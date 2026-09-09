import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { Redis } from 'ioredis';

import { StructuredLogger } from '../observability/structured-logger.js';

/*
 * Derived from the interface rather than imported: @nestjs/throttler
 * exports ThrottlerStorage from its index but not the record type its one
 * method returns. Deriving it keeps this file honest if the package
 * changes that shape, where a hand-copied interface would silently drift,
 * and avoids importing from the package's dist/ internals.
 */
type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

/*
 * Rate limiting that survives more than one API instance.
 *
 * THE PROBLEM PR-2 LEFT OPEN, stated plainly in throttling.ts: the counter
 * was a Map in one process. With N instances behind a load balancer the
 * effective limit was N times what the numbers say, and a caller who
 * simply reconnected until they landed on a different instance got a fresh
 * budget. On one machine that is a rounding error. In production it means
 * the limit protecting a single long-lived worker secret is not the limit
 * anybody wrote down.
 *
 * WHAT REPLACES IT. One counter per key in Redis, incremented atomically,
 * expiring on its own. Every instance increments the same key, so the
 * limit is the limit regardless of how the load balancer felt.
 *
 * WHY A LUA SCRIPT AND NOT INCR-THEN-EXPIRE. Two commands are two round
 * trips and a race: if the process dies between them - or if the second
 * fails - the key exists with NO expiry and that caller is throttled
 * forever. Redis evaluates a script atomically, so the increment and the
 * expiry either both happen or neither does. It is also one round trip
 * instead of three, which matters on a path that runs before every single
 * request.
 *
 * STORAGE IS BOUNDED BY CONSTRUCTION. Every key this writes is created
 * with a TTL in the same atomic step, so Redis reclaims them without a
 * sweeper. There is no unbounded map and nothing to leak.
 */

/*
 * KEYS[1] hit counter, KEYS[2] block marker.
 * ARGV[1] ttl ms, ARGV[2] limit, ARGV[3] block duration ms.
 *
 * Returns: totalHits, hit ttl ms, isBlocked, block ttl ms.
 *
 * The block is checked FIRST and short-circuits, so a blocked caller does
 * not keep inflating a counter they are already past - which is what makes
 * the block duration mean what it says rather than compounding.
 */
const INCREMENT = `
local blockTtl = redis.call('PTTL', KEYS[2])
if blockTtl > 0 then
  local hits = tonumber(redis.call('GET', KEYS[1]) or '0')
  return {hits, redis.call('PTTL', KEYS[1]), 1, blockTtl}
end

local hits = redis.call('INCR', KEYS[1])
if hits == 1 then
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]))
end
local ttl = redis.call('PTTL', KEYS[1])

if hits > tonumber(ARGV[2]) and tonumber(ARGV[3]) > 0 then
  redis.call('SET', KEYS[2], '1', 'PX', tonumber(ARGV[3]))
  return {hits, ttl, 1, tonumber(ARGV[3])}
end

return {hits, ttl, 0, 0}
`;

/**
 * How long a Redis failure keeps us on the fallback before trying again.
 *
 * Without it, every request during an outage pays a connection attempt and
 * its timeout - turning a degraded limiter into a latency incident on
 * every route at once.
 */
const DEGRADED_RETRY_MS = 5_000;

/** Seconds, rounded up, to match the in-memory storage's contract exactly. */
function toSeconds(milliseconds: number): number {
  return Math.ceil(milliseconds / 1000);
}

@Injectable()
export class RedisThrottlerStorage
  implements ThrottlerStorage, OnModuleDestroy
{
  private degradedUntil = 0;

  constructor(
    private readonly redis: Redis,
    /*
     * THE FALLBACK IS THE IN-MEMORY LIMITER, NOT "ALLOW".
     *
     * The two obvious behaviours when Redis is down are both wrong. Failing
     * closed rejects every request in the system because a rate limiter is
     * unavailable, converting a degradation into a total outage. Failing
     * open removes the limit entirely - and makes knocking Redis over the
     * first step of any attack on the routes the limiter protects.
     *
     * Degrading to the per-process counter keeps a real bound in force -
     * the PR-2 bound, N times the configured limit - while Redis is away.
     * That is strictly better than either, and it is the behaviour the
     * system had before this class existed.
     */
    private readonly fallback: ThrottlerStorageService,
    private readonly logger: StructuredLogger,
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    if (Date.now() < this.degradedUntil) {
      return this.fallback.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
      );
    }

    try {
      const namespaced = `throttle:${throttlerName}:${key}`;

      const [hits, hitTtl, blocked, blockTtl] = (await this.redis.eval(
        INCREMENT,
        2,
        namespaced,
        `${namespaced}:blocked`,
        String(ttl),
        String(limit),
        String(blockDuration),
      )) as [number, number, number, number];

      return {
        totalHits: hits,
        timeToExpire: toSeconds(hitTtl),
        isBlocked: blocked === 1,
        timeToBlockExpire: toSeconds(blockTtl),
      };
    } catch (error) {
      this.degradedUntil = Date.now() + DEGRADED_RETRY_MS;

      /*
       * Class and code only. A Redis connection error's message carries the
       * host, the port and sometimes the credential from the URL - which is
       * exactly the shape PR-5's allowlist exists to keep out of a log.
       */
      this.logger.failure('throttle.store.unavailable', error, {
        dependency: 'redis',
        dependencyStatus: 'unavailable',
        operation: 'increment',
      });

      return this.fallback.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
      );
    }
  }

  async onModuleDestroy() {
    /*
     * Closed on shutdown for the same reason the database pool is: a
     * connection we do not close is held until the server reaps it, and on
     * a shared Redis that capacity belongs to the worker too.
     */
    await this.redis.quit().catch(() => undefined);
  }
}
