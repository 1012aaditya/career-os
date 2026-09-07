import { inspect } from 'node:util';

import {
  GithubRequestError,
  GithubRestClient,
  parseLinkNext,
} from './github-rest.client.js';

const TOKEN_PREFIX = 'gho';

const TOKEN = `${TOKEN_PREFIX}_16C7e42F292c6912E7710c838347Ae178B4a`;

type Reply = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

type Call = {
  url: string;
  headers: Record<string, string>;
};

/*
 * The real client against a scripted network. Sleep is injected as a
 * no-op recorder, so the backoff DECISIONS are exercised without the
 * suite ever waiting - a test that actually slept would be deleted by the
 * first person who noticed the runtime.
 */
function build(replies: Reply[]) {
  const calls: Call[] = [];
  const waits: number[] = [];

  let index = 0;

  vi.spyOn(
    globalThis,
    'fetch',
  ).mockImplementation(async (input, init) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<
        string,
        string
      >,
    });

    const reply =
      replies[Math.min(index, replies.length - 1)]!;

    index += 1;

    return new Response(
      reply.body === undefined
        ? null
        : JSON.stringify(reply.body),
      {
        status: reply.status ?? 200,
        headers: {
          'Content-Type': 'application/json',
          ...reply.headers,
        },
      },
    );
  });

  const client = new GithubRestClient(
    async (ms) => {
      waits.push(ms);
    },
  );

  return { client, calls, waits };
}

const opts = {
  accessToken: TOKEN,
  operation: 'test_op',
};

afterEach(() => vi.restoreAllMocks());

describe('parseLinkNext', () => {
  it('finds rel="next" among several relations', () => {
    expect(
      parseLinkNext(
        '<https://api.github.com/x?page=2>; rel="prev", <https://api.github.com/x?page=4>; rel="next", <https://api.github.com/x?page=9>; rel="last"',
      ),
    ).toBe('https://api.github.com/x?page=4');
  });

  /*
   * The terminal condition is the ABSENCE of next, not the presence of
   * last - GitHub omits relations, and last can be missing entirely.
   */
  it('returns null when there is no next, even if last exists', () => {
    expect(
      parseLinkNext(
        '<https://api.github.com/x?page=1>; rel="first", <https://api.github.com/x?page=9>; rel="last"',
      ),
    ).toBeNull();

    expect(parseLinkNext(null)).toBeNull();
    expect(parseLinkNext('')).toBeNull();
    expect(parseLinkNext('garbage')).toBeNull();
  });
});

describe('GithubRestClient headers', () => {
  it('pins the API version and identifies itself', async () => {
    const { client, calls } = build([
      { body: {} },
    ]);

    await client.get('/user', opts);

    expect(
      calls[0]!.headers['X-GitHub-Api-Version'],
    ).toBe('2026-03-10');
    expect(calls[0]!.headers['Accept']).toBe(
      'application/vnd.github+json',
    );
    expect(
      calls[0]!.headers['User-Agent'],
    ).toBeTruthy();
    expect(
      calls[0]!.headers['Authorization'],
    ).toBe(`Bearer ${TOKEN}`);
  });

  it('sends If-None-Match only when an etag is supplied', async () => {
    const { client, calls } = build([
      { body: {} },
      { body: {} },
    ]);

    await client.get('/user', opts);
    expect(
      calls[0]!.headers['If-None-Match'],
    ).toBeUndefined();

    await client.get('/user', {
      ...opts,
      etag: 'W/"abc"',
    });
    expect(
      calls[1]!.headers['If-None-Match'],
    ).toBe('W/"abc"');
  });
});

describe('conditional requests', () => {
  it('reports a 304 without a body', async () => {
    const { client } = build([
      {
        status: 304,
        headers: { etag: 'W/"same"' },
      },
    ]);

    const result = await client.get('/x', {
      ...opts,
      etag: 'W/"same"',
    });

    expect(result.status).toBe('not_modified');
  });

  it('returns the etag from a 200 so it can be stored', async () => {
    const { client } = build([
      {
        body: { ok: true },
        headers: { etag: 'W/"v1"' },
      },
    ]);

    const result = await client.get('/x', opts);

    expect(result).toMatchObject({
      status: 'ok',
      etag: 'W/"v1"',
    });
  });

  it('falls back to the sent etag when a 304 omits it', async () => {
    const { client } = build([{ status: 304 }]);

    const result = await client.get('/x', {
      ...opts,
      etag: 'W/"sent"',
    });

    expect(result).toEqual({
      status: 'not_modified',
      etag: 'W/"sent"',
    });
  });
});

describe('pagination', () => {
  it('follows rel=next rather than incrementing page', async () => {
    const { client, calls } = build([
      {
        body: [{ id: 1 }],
        headers: {
          link: '<https://api.github.com/page-two>; rel="next"',
        },
      },
      { body: [{ id: 2 }] },
    ]);

    const result = await client.getAll(
      '/things',
      opts,
    );

    expect(result.items).toEqual([
      { id: 1 },
      { id: 2 },
    ]);
    expect(result.truncated).toBe(false);
    expect(result.pagesFetched).toBe(2);

    /* The second call used GitHub's URL verbatim. */
    expect(calls[1]!.url).toBe(
      'https://api.github.com/page-two',
    );
  });

  it('caps per_page at the documented maximum', async () => {
    const { client, calls } = build([
      { body: [] },
    ]);

    await client.getAll('/things', {
      ...opts,
      perPage: 5000,
    });

    expect(
      new URL(calls[0]!.url).searchParams.get(
        'per_page',
      ),
    ).toBe('100');
  });

  it('stops at the page ceiling and reports truncation', async () => {
    const { client, calls } = build([
      {
        body: [{ id: 1 }],
        headers: {
          link: '<https://api.github.com/next>; rel="next"',
        },
      },
    ]);

    const result = await client.getAll(
      '/things',
      { ...opts, maxPages: 3 },
    );

    expect(calls).toHaveLength(3);
    expect(result.pagesFetched).toBe(3);
    /* Truncated, not silently short. */
    expect(result.truncated).toBe(true);
  });

  it('rejects a page that is not an array', async () => {
    const { client } = build([
      { body: { message: 'nope' } },
    ]);

    await expect(
      client.getAll('/things', opts),
    ).rejects.toMatchObject({
      reason: 'unexpected_response',
    });
  });
});

describe('failure classification', () => {
  const cases: Array<
    [number, string, Record<string, string>?]
  > = [
    [401, 'bad_credentials'],
    [404, 'access_lost'],
    [451, 'access_lost'],
    [409, 'empty_repository'],
    [400, 'unexpected_response'],
    [
      403,
      'forbidden',
      { 'x-ratelimit-remaining': '4999' },
    ],
    [
      403,
      'rate_limited',
      { 'x-ratelimit-remaining': '0' },
    ],
    [429, 'rate_limited'],
  ];

  it.each(cases)(
    'maps %i to %s',
    async (status, reason, headers) => {
      const { client } = build([
        { status, headers, body: {} },
      ]);

      await expect(
        client.get('/x', opts),
      ).rejects.toMatchObject({ reason });
    },
  );

  /*
   * 403 is overloaded. Treating a permissions failure as a rate limit
   * would make the client wait and retry something that can never
   * succeed; treating a rate limit as a permissions failure would keep
   * calling while limited, which GitHub warns can get an integration
   * banned.
   */
  it('does not retry a permissions 403', async () => {
    const { client, calls } = build([
      {
        status: 403,
        headers: { 'x-ratelimit-remaining': '10' },
        body: {},
      },
    ]);

    await expect(
      client.get('/x', opts),
    ).rejects.toMatchObject({
      reason: 'forbidden',
    });

    expect(calls).toHaveLength(1);
  });

  it('does not retry a 404', async () => {
    const { client, calls } = build([
      { status: 404, body: {} },
    ]);

    await expect(
      client.get('/x', opts),
    ).rejects.toBeInstanceOf(GithubRequestError);

    expect(calls).toHaveLength(1);
  });
});

describe('retry behaviour', () => {
  it('retries a 5xx and succeeds', async () => {
    const { client, calls, waits } = build([
      { status: 502, body: {} },
      { body: { ok: true } },
    ]);

    const result = await client.get('/x', opts);

    expect(result.status).toBe('ok');
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([200]);
  });

  it('gives up after a bounded number of attempts', async () => {
    const { client, calls } = build([
      { status: 500, body: {} },
    ]);

    await expect(
      client.get('/x', opts),
    ).rejects.toMatchObject({
      reason: 'unavailable',
    });

    /* Bounded: it must not retry forever. */
    expect(calls).toHaveLength(3);
  });

  it('retries a network failure and then stops', async () => {
    vi.spyOn(
      globalThis,
      'fetch',
    ).mockRejectedValue(
      new Error('socket hang up'),
    );

    const waits: number[] = [];

    const client = new GithubRestClient(
      async (ms) => {
        waits.push(ms);
      },
    );

    await expect(
      client.get('/x', opts),
    ).rejects.toMatchObject({
      reason: 'network_error',
    });

    expect(waits).toEqual([200, 400, 800]);
  });

  it('waits out a short Retry-After', async () => {
    const { client, waits, calls } = build([
      {
        status: 429,
        headers: { 'retry-after': '2' },
        body: {},
      },
      { body: { ok: true } },
    ]);

    const result = await client.get('/x', opts);

    expect(result.status).toBe('ok');
    expect(waits).toEqual([2000]);
    expect(calls).toHaveLength(2);
  });

  /*
   * A primary-limit reset can be most of an hour away. Blocking a request
   * that long is worse than reporting a partial run, so a long wait is
   * surfaced rather than absorbed.
   */
  it('refuses to absorb a long Retry-After', async () => {
    const { client, waits, calls } = build([
      {
        status: 429,
        headers: { 'retry-after': '3600' },
        body: {},
      },
    ]);

    await expect(
      client.get('/x', opts),
    ).rejects.toMatchObject({
      reason: 'rate_limited',
    });

    expect(waits).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('prefers Retry-After over the reset header', async () => {
    const { client, waits } = build([
      {
        status: 429,
        headers: {
          'retry-after': '1',
          'x-ratelimit-reset': String(
            Math.floor(Date.now() / 1000) + 3600,
          ),
        },
        body: {},
      },
      { body: {} },
    ]);

    await client.get('/x', opts);

    expect(waits).toEqual([1000]);
  });

  it('carries the reset time on a rate-limit error', async () => {
    const resetSeconds =
      Math.floor(Date.now() / 1000) + 600;

    const { client } = build([
      {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset':
            String(resetSeconds),
        },
        body: {},
      },
    ]);

    await expect(
      client.get('/x', opts),
    ).rejects.toMatchObject({
      reason: 'rate_limited',
      resetAt: resetSeconds * 1000,
    });
  });
});

describe('credential leakage', () => {
  const PREFIXES = [
    'gho_',
    'ghu_',
    'ghp_',
    'ghs_',
    'ghr_',
  ];

  const serializations = (e: unknown) => [
    String(e),
    JSON.stringify(e) ?? '',
    JSON.stringify(
      e,
      Object.getOwnPropertyNames(Object(e)),
    ) ?? '',
    inspect(e, {
      depth: null,
      showHidden: true,
    }),
    (e as Error)?.stack ?? '',
  ];

  it.each([
    [401, {}],
    [403, {}],
    [500, {}],
    [404, {}],
  ])(
    'never leaks the token from a %i failure',
    async (status) => {
      const { client } = build([
        { status, body: {} },
      ]);

      let caught: unknown;

      try {
        await client.get('/x', opts);
      } catch (error) {
        caught = error;
      }

      for (const text of serializations(
        caught,
      )) {
        for (const prefix of PREFIXES) {
          expect(text).not.toContain(prefix);
        }

        expect(text).not.toContain(TOKEN);
        expect(text).not.toContain(
          'Authorization',
        );
      }
    },
  );

  it('never leaks the token from a network failure', async () => {
    /*
     * Modelled on a real HTTP client failure, where the rejected error
     * carries the request that produced it - Authorization header and
     * all. This is the shape that leaks tokens in production.
     */
    vi.spyOn(
      globalThis,
      'fetch',
    ).mockImplementation(async () => {
      const error = new Error(
        'connect ECONNREFUSED',
      ) as Error & { request?: unknown };

      error.request = {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
        },
      };

      throw error;
    });

    const client = new GithubRestClient(
      async () => {},
    );

    let caught: unknown;

    try {
      await client.get('/x', opts);
    } catch (error) {
      caught = error;
    }

    for (const text of serializations(caught)) {
      expect(text).not.toContain(TOKEN_PREFIX);
      expect(text).not.toContain(TOKEN);
    }

    expect(
      (caught as { cause?: unknown }).cause,
    ).toBeUndefined();
  });
});
