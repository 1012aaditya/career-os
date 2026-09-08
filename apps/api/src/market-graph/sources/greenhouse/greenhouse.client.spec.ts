import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GreenhouseClient,
  GreenhouseRequestError,
} from './greenhouse.client.js';

/*
 * The HTTP layer.
 *
 * fetch is stubbed with real Response objects rather than a mock library,
 * and the sleep is injected so the backoff DECISIONS are asserted against
 * a recorded array without the suite ever waiting. A test that actually
 * slept would be deleted by the first person who noticed the runtime.
 */

type Reply = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};

function script(replies: Reply[]): { calls: string[]; waits: number[] } {
  const calls: string[] = [];
  let index = 0;

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    calls.push(String(input));

    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;

    if (reply === undefined) {
      throw new Error('no reply scripted');
    }

    return new Response(
      reply.body === undefined ? '' : JSON.stringify(reply.body),
      { status: reply.status, headers: reply.headers },
    );
  });

  return { calls, waits: [] };
}

function client(waits: number[]): GreenhouseClient {
  return new GreenhouseClient(async (ms) => {
    waits.push(ms);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetching a board', () => {
  it('asks for the full body, because a snippet cannot be mined for skills', async () => {
    const waits: number[] = [];
    const { calls } = script([{ status: 200, body: { jobs: [] } }]);

    await client(waits).fetchBoard('acme');

    expect(calls[0]).toBe(
      'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true',
    );
  });

  it('encodes a board token rather than pasting it into the path', async () => {
    const waits: number[] = [];
    const { calls } = script([{ status: 200, body: { jobs: [] } }]);

    await client(waits).fetchBoard('a/../b');

    expect(calls[0]).toContain('a%2F..%2Fb');
  });

  it('returns the parsed body on success', async () => {
    const waits: number[] = [];
    script([{ status: 200, body: { jobs: [{ id: 1 }] } }]);

    await expect(client(waits).fetchBoard('acme')).resolves.toEqual({
      jobs: [{ id: 1 }],
    });
  });
});

describe('failures', () => {
  it.each([
    [404, 'board_not_found'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [503, 'unavailable'],
    [418, 'unexpected_response'],
  ])('maps %i to %s', async (status, reason) => {
    const waits: number[] = [];
    script([{ status }]);

    await expect(client(waits).fetchBoard('acme')).rejects.toMatchObject({
      reason,
    });
  });

  /*
   * A missing board will still be missing in half a second, and retrying
   * turns a config typo into three times the traffic against an endpoint
   * nobody has granted us access to.
   */
  it('does not retry a 404', async () => {
    const waits: number[] = [];
    const { calls } = script([{ status: 404 }]);

    await expect(client(waits).fetchBoard('acme')).rejects.toBeInstanceOf(
      GreenhouseRequestError,
    );

    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('retries a 500 a bounded number of times and then gives up', async () => {
    const waits: number[] = [];
    const { calls } = script([{ status: 500 }]);

    await expect(client(waits).fetchBoard('acme')).rejects.toMatchObject({
      reason: 'unavailable',
    });

    expect(calls).toHaveLength(3);
    expect(waits).toEqual([500, 1_500]);
  });

  it('recovers when a transient failure is followed by success', async () => {
    const waits: number[] = [];
    const { calls } = script([
      { status: 500 },
      { status: 200, body: { jobs: [] } },
    ]);

    await expect(client(waits).fetchBoard('acme')).resolves.toEqual({
      jobs: [],
    });

    expect(calls).toHaveLength(2);
  });

  it('waits out a short Retry-After', async () => {
    const waits: number[] = [];
    script([
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 200, body: { jobs: [] } },
    ]);

    await client(waits).fetchBoard('acme');

    expect(waits).toEqual([2_000]);
  });

  /*
   * A rate-limit reset can be most of an hour away. Blocking a run for
   * that long is worse than recording PARTIAL and trying again later - and
   * with one live run per source enforced by an index, a blocked run
   * blocks every subsequent one.
   */
  it('refuses to absorb a long Retry-After', async () => {
    const waits: number[] = [];
    script([{ status: 429, headers: { 'retry-after': '3600' } }]);

    await expect(client(waits).fetchBoard('acme')).rejects.toMatchObject({
      reason: 'rate_limited',
    });

    expect(waits).toEqual([]);
  });

  it('retries a network failure and then reports it as one', async () => {
    const waits: number[] = [];
    const calls: string[] = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      calls.push(String(input));
      throw new Error('socket hang up');
    });

    await expect(client(waits).fetchBoard('acme')).rejects.toMatchObject({
      reason: 'network_error',
    });

    expect(calls).toHaveLength(3);
  });

  /*
   * A 200 whose body is not JSON is a broken response, not an empty board.
   * Conflating them is how a source outage becomes "this employer has no
   * jobs" and, downstream, "the job market is empty".
   */
  it('treats a 200 with an unreadable body as a failure, not an empty board', async () => {
    const waits: number[] = [];

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"jobs":[', { status: 200 }),
    );

    await expect(client(waits).fetchBoard('acme')).rejects.toMatchObject({
      reason: 'unexpected_response',
    });
  });
});

describe('what a failure is allowed to carry', () => {
  it('carries a board, a status and a code, and never the response', async () => {
    const waits: number[] = [];
    script([{ status: 500, body: { secret: 'do-not-carry-me' } }]);

    const error = await client(waits)
      .fetchBoard('acme')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GreenhouseRequestError);

    /*
     * The way credentials reach log files is an HTTP client attaching the
     * request - Authorization header included - to the error it rejects
     * with. This endpoint needs no credentials, but the habit has to be
     * right before the source that does arrives.
     */
    const serialized = [
      String(error),
      JSON.stringify(error),
      JSON.stringify(error, Object.getOwnPropertyNames(Object(error))),
      (error as Error).stack ?? '',
    ].join(' ');

    expect(serialized).not.toContain('do-not-carry-me');
    expect(error).not.toHaveProperty('response');
    expect(error).not.toHaveProperty('request');
    expect(error).not.toHaveProperty('cause');
  });

  it('detects a planted value, so the check above cannot pass vacuously', () => {
    const planted = new GreenhouseRequestError('acme', 500, 'unavailable');
    (planted as unknown as Record<string, unknown>).response =
      'do-not-carry-me';

    const serialized = JSON.stringify(
      planted,
      Object.getOwnPropertyNames(planted),
    );

    expect(serialized).toContain('do-not-carry-me');
  });
});
