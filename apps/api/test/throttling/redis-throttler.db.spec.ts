import { ThrottlerStorageService } from '@nestjs/throttler';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { StructuredLogger } from '../../src/observability/structured-logger.js';
import { RedisThrottlerStorage } from '../../src/throttling/redis-throttler.storage.js';

/*
 * The infrastructure tier, for the same reason the Postgres tests are here:
 * what is being proved IS the infrastructure's behaviour.
 *
 * The property that matters - "two API instances share one budget" - cannot
 * be demonstrated against a double. A double would be a Map, which is
 * precisely the thing this class exists to replace, so the test would prove
 * the double shares itself with itself.
 */

function redisUrlOrThrow(): string {
  const url = process.env.THROTTLE_TEST_REDIS_URL;

  if (url === undefined || url.trim() === '') {
    throw new Error(
      'THROTTLE_TEST_REDIS_URL must be set for the infrastructure tier. A silently skipped rate-limit test is worse than no test: it reports a guarantee nobody checked.',
    );
  }

  return url.trim();
}

/** One tier, borrowed from throttling.ts's shape. Values are per-test. */
const TTL_MS = 60_000;
const LIMIT = 5;
const NO_BLOCK = 0;

describe('a rate limit shared across API instances', () => {
  const url = redisUrlOrThrow();
  const connections: Redis[] = [];

  function instance(): RedisThrottlerStorage {
    const redis = new Redis(url, { lazyConnect: true });
    connections.push(redis);

    return new RedisThrottlerStorage(
      redis,
      new ThrottlerStorageService(),
      new StructuredLogger(),
    );
  }

  afterAll(async () => {
    await Promise.all(connections.map((c) => c.quit().catch(() => undefined)));
  });

  /*
   * THE property. Two storage objects, each with its OWN in-memory
   * fallback - which is what two processes behind a load balancer are -
   * counting the same caller.
   *
   * Under PR-2's in-memory store this returns 1 and 1: each instance sees
   * the caller for the first time, and the caller has just had two
   * requests for the price of one.
   */
  it('counts one caller once, no matter which instance answers', async () => {
    const key = `shared-${randomUUID()}`;
    const a = instance();
    const b = instance();

    const first = await a.increment(key, TTL_MS, LIMIT, NO_BLOCK, 'default');
    const second = await b.increment(key, TTL_MS, LIMIT, NO_BLOCK, 'default');
    const third = await a.increment(key, TTL_MS, LIMIT, NO_BLOCK, 'default');

    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
    expect(third.totalHits).toBe(3);
  });

  it('is not vacuous: two per-process stores do NOT share a count', async () => {
    /*
     * The same three calls against the implementation being replaced. If
     * this ever agreed with the test above, the test above would be
     * proving nothing.
     */
    const key = `unshared-${randomUUID()}`;
    const a = new ThrottlerStorageService();
    const b = new ThrottlerStorageService();

    const first = await a.increment(key, TTL_MS, LIMIT, NO_BLOCK, 'default');
    const second = await b.increment(key, TTL_MS, LIMIT, NO_BLOCK, 'default');

    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(1);
  });

  it('reports the limit as crossed at the same request for every instance', async () => {
    const key = `limit-${randomUUID()}`;
    const instances = [instance(), instance(), instance()];

    const hits: number[] = [];

    /* Round-robin, so no single instance sees a contiguous sequence. */
    for (let i = 0; i < LIMIT + 2; i += 1) {
      const record = await instances[i % instances.length]!.increment(
        key,
        TTL_MS,
        LIMIT,
        NO_BLOCK,
        'default',
      );
      hits.push(record.totalHits);
    }

    expect(hits).toEqual([1, 2, 3, 4, 5, 6, 7]);

    /* The guard rejects once totalHits exceeds the limit. */
    expect(hits.filter((h) => h > LIMIT)).toHaveLength(2);
  });

  /*
   * Bounded storage, which is the requirement a rate limiter most often
   * fails: a counter per address with no expiry is an unbounded map that
   * an attacker fills for free.
   */
  it('gives every key it creates an expiry, in the same atomic step', async () => {
    const key = `ttl-${randomUUID()}`;
    const store = instance();

    const record = await store.increment(key, 5_000, LIMIT, NO_BLOCK, 'default');

    expect(record.totalHits).toBe(1);
    /* Seconds, rounded up, per the in-memory storage's contract. */
    expect(record.timeToExpire).toBeGreaterThan(0);
    expect(record.timeToExpire).toBeLessThanOrEqual(5);

    const probe = new Redis(url, { lazyConnect: true });
    connections.push(probe);

    const remaining = await probe.pttl(`throttle:default:${key}`);

    /* -1 is "exists, no expiry" - the leak this asserts against. */
    expect(remaining).toBeGreaterThan(0);
  });

  it('blocks for the stated duration once the limit is crossed', async () => {
    const key = `block-${randomUUID()}`;
    const store = instance();

    for (let i = 0; i < LIMIT; i += 1) {
      await store.increment(key, TTL_MS, LIMIT, 10_000, 'default');
    }

    const crossing = await store.increment(key, TTL_MS, LIMIT, 10_000, 'default');

    expect(crossing.isBlocked).toBe(true);
    expect(crossing.timeToBlockExpire).toBeGreaterThan(0);
  });
});

describe('when Redis is unreachable', () => {
  /*
   * The behaviour under an outage, which is the part of a rate limiter
   * nobody tests and everybody finds out about at the worst moment.
   *
   * Neither of the tempting answers is taken: it does not fail closed
   * (which would turn a Redis incident into a total outage) and it does not
   * fail open (which would make knocking Redis over step one of any attack
   * on the routes the limiter protects). It degrades to the per-process
   * counter - a real bound, just a weaker one.
   */
  let store: RedisThrottlerStorage;

  beforeAll(() => {
    /* A port with nothing behind it. No offline queue, so it fails fast. */
    const dead = new Redis('redis://127.0.0.1:6399', {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    dead.on('error', () => undefined);

    store = new RedisThrottlerStorage(
      dead,
      new ThrottlerStorageService(),
      new StructuredLogger(),
    );
  });

  it('still counts, rather than throwing or allowing everything', async () => {
    const key = `degraded-${randomUUID()}`;

    const first = await store.increment(key, TTL_MS, LIMIT, NO_BLOCK, 'default');
    const second = await store.increment(key, TTL_MS, LIMIT, NO_BLOCK, 'default');

    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
  });
});
