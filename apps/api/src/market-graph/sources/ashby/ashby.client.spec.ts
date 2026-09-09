import { afterEach, describe, expect, it, vi } from 'vitest';

import { MarketSourceCredentials } from '../source-credentials.js';
import {
  ASHBY_CREDENTIALS,
  AshbyClient,
  AshbyRequestError,
} from './ashby.client.js';

/*
 * The HTTP layer, and the failure modes Phase 11 Part Q enumerates.
 *
 * fetch is stubbed with real Response objects rather than a mock library,
 * and both the sleep and the clock are injected - so the pacing and
 * backoff DECISIONS are asserted against recorded arrays without the suite
 * ever waiting. A test that actually slept for the one-second minimum
 * interval would be deleted by the first person who noticed the runtime.
 *
 * The point of most of these is not that a failure is handled. It is that
 * failures which look alike are kept APART: a missing credential and a
 * rejected one, a rejected credential and a forbidden board, an outage and
 * a timeout. Collapsing any of those pairs sends an operator to check the
 * wrong thing, and in two cases makes an access decision look like a bug.
 */

type Reply = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  throws?: Error;
  /** A 200 whose body is not JSON, which is not an empty board. */
  raw?: string;
};

function script(replies: Reply[]): { calls: string[]; headers: HeadersInit[] } {
  const calls: string[] = [];
  const headers: HeadersInit[] = [];
  let index = 0;

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    calls.push(String(input));
    headers.push(init?.headers ?? {});

    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;

    if (reply === undefined) {
      throw new Error('no reply scripted');
    }

    if (reply.throws !== undefined) {
      throw reply.throws;
    }

    return new Response(
      reply.raw ??
        (reply.body === undefined ? '' : JSON.stringify(reply.body)),
      { status: reply.status, headers: reply.headers },
    );
  });

  return { calls, headers };
}

/*
 * A clock that only moves when the injected sleep moves it. Real pacing
 * decisions, no real time - and it means a test can assert that the client
 * waited rather than that it happened to be slow.
 */
function client(waits: number[], credentials?: MarketSourceCredentials) {
  let now = 1_000_000;

  return new AshbyClient(
    credentials ?? new MarketSourceCredentials(),
    async (ms) => {
      waits.push(ms);
      now += ms;
    },
    () => now,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ASHBY_API_KEY;
});

describe('fetching a board', () => {
  it('asks the posting API for one board and returns its body', async () => {
    const { calls } = script([{ status: 200, body: { jobs: [], apiVersion: 1 } }]);

    const page = await client([]).fetchScope('acme', null);

    expect(calls[0]).toBe(
      'https://api.ashbyhq.com/posting-api/job-board/acme',
    );
    expect(page.body).toEqual({ jobs: [], apiVersion: 1 });
    /* One response per board: no cursor, and no torn page is possible. */
    expect(page.nextCursor).toBeNull();
  });

  it('encodes a board token rather than pasting it into a URL', async () => {
    const { calls } = script([{ status: 200, body: { jobs: [] } }]);

    await client([]).fetchScope('a-b.c', null);

    expect(calls[0]).toContain('/job-board/a-b.c');
  });

  it('paces itself between requests without being asked to', async () => {
    script([{ status: 200, body: { jobs: [] } }]);

    const waits: number[] = [];
    const ashby = client(waits);

    await ashby.fetchScope('one', null);
    await ashby.fetchScope('two', null);

    /* First request: nothing to wait for. Second: the full interval. */
    expect(waits).toEqual([1_000]);
  });
});

describe('credentials', () => {
  /*
   * The public endpoint needs none, so an unset variable is the normal
   * state rather than a misconfiguration. This is the branch that keeps
   * "no key needed" from being reported as "key missing".
   */
  it('sends no authorization header when none is configured', async () => {
    const { headers } = script([{ status: 200, body: { jobs: [] } }]);

    await client([]).fetchScope('acme', null);

    expect(Object.keys(headers[0] as Record<string, string>)).toEqual([
      'Accept',
      'User-Agent',
    ]);
  });

  it('sends one when it is, and holds no copy of it', async () => {
    process.env.ASHBY_API_KEY = 'live-key-value';

    const { headers } = script([{ status: 200, body: { jobs: [] } }]);
    const ashby = client([]);

    await ashby.fetchScope('acme', null);

    const sent = headers[0] as Record<string, string>;

    expect(sent.Authorization).toBe(
      `Basic ${Buffer.from('live-key-value:').toString('base64')}`,
    );

    /*
     * The credential is used and not kept. Serialising the client must not
     * turn it up, because a client that holds one will eventually be
     * logged, snapshotted or attached to an error by somebody who did not
     * read this file.
     */
    expect(JSON.stringify(ashby)).not.toContain('live-key-value');
    expect(JSON.stringify(ashby)).not.toContain('ASHBY_API_KEY');
  });

  it('treats a blank variable as unset rather than as a credential', () => {
    process.env.ASHBY_API_KEY = '   ';

    expect(new MarketSourceCredentials().state(ASHBY_CREDENTIALS)).toEqual({
      kind: 'MISSING',
      missingKeys: ['ASHBY_API_KEY'],
    });
  });
});

describe('what the provider can do wrong', () => {
  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'board_not_found'],
  ])('does not retry a %i, and reports it as %s', async (status, reason) => {
    const { calls } = script([{ status }]);
    const waits: number[] = [];

    await expect(client(waits).fetchScope('acme', null)).rejects.toMatchObject({
      reason,
      status,
    });

    /*
     * One request. A credential that is wrong now will be wrong in a
     * second, and hammering an endpoint with a rejected one is how an
     * account gets locked; a forbidden board is an access fact, not an
     * outage, and retrying it would dress it up as one.
     */
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('keeps 401 and 403 apart, because they mean different things', async () => {
    script([{ status: 401 }]);
    const rejected = await client([])
      .fetchScope('acme', null)
      .catch((error: unknown) => error);

    script([{ status: 403 }]);
    const forbidden = await client([])
      .fetchScope('acme', null)
      .catch((error: unknown) => error);

    expect((rejected as AshbyRequestError).reason).toBe('unauthorized');
    expect((forbidden as AshbyRequestError).reason).toBe('forbidden');
  });

  it('retries a 429 and honours a short Retry-After', async () => {
    script([
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 200, body: { jobs: [] } },
    ]);

    const waits: number[] = [];

    await client(waits).fetchScope('acme', null);

    /* The pacing interval, then the provider's own two seconds. */
    expect(waits).toContain(2_000);
  });

  it('gives up rather than sitting on a long Retry-After', async () => {
    script([{ status: 429, headers: { 'retry-after': '600' } }]);

    await expect(client([]).fetchScope('acme', null)).rejects.toMatchObject({
      reason: 'rate_limited',
    });
  });

  it('retries a 500 and then reports the source unavailable', async () => {
    const { calls } = script([{ status: 503 }]);

    await expect(client([]).fetchScope('acme', null)).rejects.toMatchObject({
      reason: 'unavailable',
    });

    expect(calls).toHaveLength(3);
  });

  it('reports a timeout as a timeout, not as a network error', async () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';

    script([{ status: 0, throws: timeout }]);

    await expect(client([]).fetchScope('acme', null)).rejects.toMatchObject({
      reason: 'timeout',
    });
  });

  it('reports a refused connection as a network error', async () => {
    script([{ status: 0, throws: new TypeError('fetch failed') }]);

    await expect(client([]).fetchScope('acme', null)).rejects.toMatchObject({
      reason: 'network_error',
    });
  });

  /*
   * A 200 that is not JSON is a broken response, not an empty board.
   * Conflating the two is how a provider outage becomes "this employer is
   * not hiring" - and, one aggregation later, "demand for this role fell".
   */
  it('refuses a malformed 200 rather than reading it as an empty board', async () => {
    script([{ status: 200, raw: '<html>maintenance</html>' }]);

    await expect(client([]).fetchScope('acme', null)).rejects.toMatchObject({
      reason: 'unexpected_response',
    });
  });

  /*
   * The rule Phase 7 established and this pipeline inherited: a caught
   * error carries the request that produced it, headers included, so it is
   * classified and discarded. This is the client that may carry a
   * credential in one of those headers.
   */
  it('throws a code and never the provider response or the request', async () => {
    process.env.ASHBY_API_KEY = 'live-key-value';
    script([{ status: 401 }]);

    const error = (await client([])
      .fetchScope('acme', null)
      .catch((caught: unknown) => caught)) as AshbyRequestError;

    expect(error).toBeInstanceOf(AshbyRequestError);
    expect(error.reason).toBe('unauthorized');
    expect(JSON.stringify(error)).not.toContain('live-key-value');
    expect(error.message).not.toContain('live-key-value');
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });

  it('classifies an unrecognised throw without inspecting it', () => {
    expect(client([]).classifyFailure(new Error('anything'))).toBe(
      'unexpected_response',
    );
  });
});
