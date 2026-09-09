import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * A type-only import alongside the dynamic one below. The module is loaded
 * with `await import` so that vi.mock applies first, and that form gives
 * TypeScript a value binding but no usable type name - so the class is
 * imported again, as a type, purely for the annotations. Type imports are
 * erased, so this does not defeat the mock.
 */
import type { ApiError as ApiErrorType } from './client';

/*
 * The API client, against a mocked network.
 *
 * Three behaviours are under test and all three are new in PR-4: a request
 * cannot hang forever, a 401 invalidates the session exactly once without
 * navigating, and nothing is ever retried automatically.
 *
 * Supabase is mocked rather than reached. What matters is that the client
 * asks it to sign out, not what Supabase does about it.
 */

process.env.EXPO_PUBLIC_API_URL = 'https://api.example.invalid';
process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://supabase.example.invalid';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon';

const signOut = vi.fn().mockResolvedValue({ error: null });
const getSession = vi.fn().mockResolvedValue({
  data: { session: { access_token: 'a-real-looking-token' } },
});

vi.mock('../lib/supabase', () => ({
  supabase: { auth: { getSession, signOut } },
}));

const { apiRequest, ApiError, canRetry, describeError } = await import(
  './client'
);
const { resetSessionInvalidationForTests } = await import(
  './session-invalidation'
);

/*
 * Awaits a request that is expected to fail and hands back the ApiError.
 *
 * A plain `.catch(e => e as ApiError)` types as `unknown` here, because
 * apiRequest's own result type joins the union. This narrows it in one
 * place instead of casting at every call site.
 */
async function captureError(promise: Promise<unknown>): Promise<ApiErrorType> {
  try {
    await promise;
  } catch (error) {
    return error as ApiErrorType;
  }

  throw new Error('expected the request to fail, and it did not');
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSessionInvalidationForTests();
  getSession.mockResolvedValue({
    data: { session: { access_token: 'a-real-looking-token' } },
  });
  signOut.mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('a successful request', () => {
  it('returns the parsed body and sends the bearer token', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { ok: true }));

    await expect(apiRequest('/thing')).resolves.toEqual({ ok: true });

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;

    expect(headers.Authorization).toBe('Bearer a-real-looking-token');
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      'https://api.example.invalid/v1/thing',
    );
  });

  it('handles a 204 with no body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await expect(apiRequest('/thing')).resolves.toBeUndefined();
  });
});

describe('a request that never answers', () => {
  /*
   * Before PR-4 this hung forever, and with it the screen's loading state,
   * which has no way to end on its own.
   */
  it('is aborted and reported as a timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );

    vi.useFakeTimers();

    const pending = apiRequest('/slow');
    const assertion = expect(pending).rejects.toMatchObject({
      kind: 'timeout',
    });

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  /*
   * The abort is real, not a race that leaves the request running with its
   * socket open.
   */
  it('actually signals the abort to fetch', async () => {
    let signal: AbortSignal | undefined;

    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );

    vi.useFakeTimers();

    const pending = apiRequest('/slow');
    const assertion = expect(pending).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;

    expect(signal?.aborted).toBe(true);
  });

  it('tells the user something they can act on', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );

    vi.useFakeTimers();

    const assertion = captureError(apiRequest('/slow'));

    await vi.advanceTimersByTimeAsync(15_000);

    const error = await assertion;

    expect(error.message).toMatch(/too long/i);
    expect(error.retryable).toBe(true);
  });
});

describe('a request that cannot reach the server', () => {
  it('is reported as offline rather than as a server error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('Network request failed'),
    );

    const error = await captureError(apiRequest('/thing'));

    expect(error.kind).toBe('offline');
    expect(error.message).toMatch(/connection/i);
  });

  /*
   * A fetch error carries the whole request, headers included - and every
   * request here carries a bearer token. It is classified and discarded.
   */
  it('does not leak the request or the token into the error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('Network request failed for https://api.example.invalid'),
    );

    const error = await captureError(apiRequest('/thing'));

    expect(error.message).not.toContain('a-real-looking-token');
    expect(error.message).not.toContain('api.example.invalid');
    expect(JSON.stringify(error)).not.toContain('a-real-looking-token');
  });
});

describe('a 401', () => {
  it('signs the session out', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(401, { message: 'Invalid access token' }),
    );

    await expect(apiRequest('/thing')).rejects.toMatchObject({
      kind: 'unauthenticated',
    });

    /* Started but not awaited by the client, so give the microtask a turn. */
    await Promise.resolve();

    expect(signOut).toHaveBeenCalledTimes(1);
  });

  /*
   * THE concurrency case. Five requests failing together must produce one
   * sign-out, not five.
   */
  it('signs out once even when several requests fail together', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(401, { message: 'Invalid access token' }),
    );

    const results = await Promise.allSettled([
      apiRequest('/a'),
      apiRequest('/b'),
      apiRequest('/c'),
      apiRequest('/d'),
      apiRequest('/e'),
    ]);

    expect(results.every((r) => r.status === 'rejected')).toBe(true);

    await Promise.resolve();

    expect(signOut).toHaveBeenCalledTimes(1);
  });

  /*
   * The server's "Invalid access token" is a true sentence that means
   * nothing to a person. They are told their session expired instead.
   */
  it('does not show the raw server message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(401, { message: 'Invalid access token' }),
    );

    const error = await captureError(apiRequest('/thing'));

    expect(error.message).not.toContain('Invalid access token');
    expect(error.message).toMatch(/session/i);
  });

  /*
   * No retry button for an expired session: the same dead token would
   * fail identically, and the app is signing the user out anyway.
   */
  it('is not offered as retryable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(401, {}));

    const error = await captureError(apiRequest('/thing'));

    expect(error.retryable).toBe(false);
    expect(canRetry(error)).toBe(false);
  });

  /*
   * The client must not loop. One request produces exactly one fetch -
   * there is no re-authenticate-and-retry path that could spin.
   */
  it('does not retry the failed request', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(401, {}));

    await apiRequest('/thing').catch(() => undefined);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('what is never repeated', () => {
  /*
   * One fetch per call, for every method. An automatic retry of a DELETE
   * that timed out could delete twice.
   */
  it.each(['GET', 'POST', 'PATCH', 'DELETE'] as const)(
    'sends exactly one %s even when it fails',
    async (method) => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(jsonResponse(500, { message: 'boom' }));

      await apiRequest('/thing', { method }).catch(() => undefined);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );

  it('sends exactly one request when the network fails', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('Network request failed'));

    await apiRequest('/account', { method: 'DELETE' }).catch(() => undefined);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('server refusals', () => {
  /*
   * A 4xx body is a refusal the API wrote for a user, and PR-3 made those
   * safe. It is shown as-is.
   */
  it('passes a 4xx message through', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(409, {
        message: 'You already have 3 resume imports in progress.',
      }),
    );

    const error = await captureError(apiRequest('/thing'));

    expect(error.message).toBe(
      'You already have 3 resume imports in progress.',
    );
    expect(error.status).toBe(409);
  });

  /* A 500 body is plumbing. "Internal server error" helps nobody. */
  it('replaces a 5xx message with something a person can act on', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(500, { message: 'Internal server error' }),
    );

    const error = await captureError(apiRequest('/thing'));

    expect(error.message).not.toContain('Internal server error');
    expect(error.message).toMatch(/something went wrong/i);
  });

  it('survives a non-JSON body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    );

    const error = await captureError(apiRequest('/thing'));

    expect(error.message).not.toContain('html');
    expect(error.kind).toBe('server');
  });
});

describe('describing an error to a screen', () => {
  it('uses the ApiError message', () => {
    expect(describeError(new ApiError(500, 'A safe sentence'))).toBe(
      'A safe sentence',
    );
  });

  /*
   * Anything that is not an ApiError is a bug in our own code. Rendering
   * its message would put an internal string in front of a user.
   */
  it('does not render an internal error message', () => {
    expect(
      describeError(new Error('Cannot read properties of undefined')),
    ).not.toContain('undefined');
    expect(describeError('a string')).toMatch(/something went wrong/i);
  });
});
