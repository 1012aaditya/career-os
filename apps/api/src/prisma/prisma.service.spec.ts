import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { poolConfigFromEnv } from './prisma.service.js';

/*
 * The connection pool's configuration.
 *
 * These read like assertions about numbers, and the one that matters is
 * about a shape: two of node-postgres's defaults are "no limit", and under
 * saturation "no limit" does not mean fast - it means a request waits
 * forever for a connection a stuck query is never going to return.
 *
 * The first test below documents what the defaults actually were, by
 * building a pool the way this service used to and reading its options
 * back. It is there so the reason for every value in poolConfigFromEnv is
 * checkable rather than remembered.
 */

const KEYS = [
  'DATABASE_POOL_MAX',
  'DATABASE_CONNECTION_TIMEOUT_MS',
  'DATABASE_STATEMENT_TIMEOUT_MS',
  'DATABASE_IDLE_TIMEOUT_MS',
  'DATABASE_APPLICATION_NAME',
];

afterEach(() => {
  for (const key of KEYS) {
    delete process.env[key];
  }
});

const URL = 'postgresql://user:pass@localhost:5432/db';

describe('what node-postgres does when nobody configures it', () => {
  /*
   * Not a test of our code. It is the evidence for the change, and it will
   * fail loudly if a future pg release makes the bare defaults safe - at
   * which point this file should be revisited rather than trusted.
   */
  it('waits forever for a connection and never times out a query', () => {
    const pool = new Pool({ connectionString: URL });

    try {
      expect(pool.options.connectionTimeoutMillis).toBeUndefined();
      expect(pool.options.statement_timeout).toBeUndefined();
      expect(pool.options.query_timeout).toBeUndefined();
      /* And the pool is small, which is what makes the above matter. */
      expect(pool.options.max).toBe(10);
    } finally {
      void pool.end();
    }
  });
});

describe('the configuration this service builds instead', () => {
  it('bounds every wait that was previously unbounded', () => {
    const config = poolConfigFromEnv(URL);

    expect(config.connectionTimeoutMillis).toBe(10_000);
    expect(config.statement_timeout).toBe(30_000);
    expect(config.query_timeout).toBe(30_000);
  });

  /*
   * Both halves of one guard. statement_timeout is enforced by Postgres
   * and frees the CONNECTION; query_timeout is enforced by the client and
   * frees the REQUEST when the server has stopped answering entirely.
   */
  it('sets the server-side and client-side ceilings together', () => {
    process.env.DATABASE_STATEMENT_TIMEOUT_MS = '45000';

    const config = poolConfigFromEnv(URL);

    expect(config.statement_timeout).toBe(45_000);
    expect(config.query_timeout).toBe(45_000);
  });

  it('keeps the connection string it was given', () => {
    expect(poolConfigFromEnv(URL).connectionString).toBe(URL);
  });

  it('names the connection so it can be found in pg_stat_activity', () => {
    expect(poolConfigFromEnv(URL).application_name).toBe('career-os-api');

    process.env.DATABASE_APPLICATION_NAME = 'career-os-worker';
    expect(poolConfigFromEnv(URL).application_name).toBe('career-os-worker');
  });

  it('takes overrides for every value', () => {
    process.env.DATABASE_POOL_MAX = '25';
    process.env.DATABASE_CONNECTION_TIMEOUT_MS = '2000';
    process.env.DATABASE_IDLE_TIMEOUT_MS = '5000';

    const config = poolConfigFromEnv(URL);

    expect(config.max).toBe(25);
    expect(config.connectionTimeoutMillis).toBe(2_000);
    expect(config.idleTimeoutMillis).toBe(5_000);
  });

  /*
   * A typo in an operational knob must not stop the service booting, and
   * must not silently reinstate "no limit" either. Zero is refused along
   * with the rest, because zero is exactly how node-postgres spells
   * "wait forever".
   */
  it.each(['0', '-1', 'lots', '', '   ', '10.5'])(
    'falls back to the documented default for %j',
    (value) => {
      process.env.DATABASE_CONNECTION_TIMEOUT_MS = value;

      expect(poolConfigFromEnv(URL).connectionTimeoutMillis).toBe(10_000);
    },
  );

  /*
   * The pool is per-process, so the number the database sees is this times
   * the instance count. Pinned because raising it without checking the
   * pooler's own limit moves the failure to a pool shared with the worker
   * and with migrations, which is strictly worse.
   */
  it('defaults to a per-process ceiling of 10', () => {
    expect(poolConfigFromEnv(URL).max).toBe(10);
  });
});
