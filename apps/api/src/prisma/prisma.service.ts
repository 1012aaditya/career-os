import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/*
 * The database client, and the connection pool underneath it.
 *
 * WHY THE POOL IS CONFIGURED HERE AND NOT IN THE URL. This service uses
 * the `@prisma/adapter-pg` driver adapter, which means pooling is done by
 * node-postgres and NOT by the Prisma query engine. The consequence is
 * easy to miss and was verified rather than assumed: `?connection_limit=`
 * in DATABASE_URL is a Prisma-engine parameter, and under a driver adapter
 * the engine is not the thing holding connections - so that parameter is
 * silently ignored. Sizing the pool has to happen here, on the PoolConfig.
 *
 * WHAT THE DEFAULTS ACTUALLY WERE. Constructing `new Pool({ connectionString })`
 * and reading its options back gives:
 *
 *   max                     10
 *   connectionTimeoutMillis undefined  -> wait forever for a free connection
 *   statement_timeout       undefined  -> a runaway query holds one forever
 *   query_timeout           undefined
 *   idleTimeoutMillis       10000
 *
 * The two `undefined`s are the production hazard. Under saturation the API
 * did not fail - it queued, indefinitely, with no upper bound on how long
 * a request could sit waiting for a connection that a stuck query was
 * never going to give back. Production hardening means making failure
 * safe, not pretending failure cannot happen: a request that cannot get a
 * connection must fail quickly and visibly rather than hang.
 *
 * WHY THESE NUMBERS. Every one is overridable, because the right value
 * depends on a deployment topology that does not exist yet (PR-6), and
 * every one has a stated reason rather than a shrug:
 *
 *   POOL_MAX = 10 keeps node-postgres's own default rather than inventing
 *   a number. It is a PER-PROCESS ceiling, so the figure the database sees
 *   is POOL_MAX x instances, and that arithmetic belongs to whoever
 *   decides the instance count. Supabase's pooler enforces its own limit
 *   above this; raising POOL_MAX without checking that limit moves the
 *   failure from our pool to theirs, which is strictly worse because
 *   theirs is shared with the worker and with migrations.
 *
 *   CONNECTION_TIMEOUT = 10s. Longer than any healthy checkout, which is
 *   sub-millisecond when the pool is not saturated, and shorter than a
 *   typical load-balancer timeout - so we surface the failure before
 *   something upstream gives up on us and we learn nothing.
 *
 *   STATEMENT_TIMEOUT = 30s, enforced by POSTGRES rather than by us. This
 *   is the one that actually returns a leaked connection to the pool: a
 *   client-side timeout abandons the request while the server keeps
 *   executing. The market-graph read paths are the slowest legitimate
 *   queries in the system and run in tens of milliseconds, so 30s is three
 *   orders of magnitude of headroom - a runaway detector, not a
 *   performance budget.
 *
 *   QUERY_TIMEOUT = 30s is the client-side companion, so a connection that
 *   has died silently - a dropped pooler connection, a network partition -
 *   does not hold a request open waiting for a server that will never
 *   answer.
 *
 * The ingestion CLI is the one caller that legitimately needs a longer
 * statement timeout: a market run writes tens of thousands of rows. It
 * raises the ceiling through the environment rather than by sharing the
 * API's, so a long ingestion cannot quietly widen the API's guard.
 */

/** Per-process. The number the database sees is this times the instances. */
const DEFAULT_POOL_MAX = 10;

/** How long a request may wait for a free connection before failing. */
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

/** Server-side ceiling. This is what actually reclaims a leaked connection. */
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

/** How long an unused connection is kept before being released. */
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;

/**
 * Reads a positive-integer setting, falling back to the documented default.
 *
 * An unparseable or non-positive value falls back rather than throwing:
 * these are operational tuning knobs, and a typo in one should not stop
 * the service booting with a known-good configuration. Zero is refused
 * along with the rest, because to node-postgres zero means "no limit" -
 * which is exactly the state this file exists to leave behind.
 */
function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const value = Number(raw);

  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Exported so the configuration can be asserted without opening a pool. */
export function poolConfigFromEnv(connectionString: string) {
  const statementTimeout = positiveIntFromEnv(
    'DATABASE_STATEMENT_TIMEOUT_MS',
    DEFAULT_STATEMENT_TIMEOUT_MS,
  );

  return {
    connectionString,
    max: positiveIntFromEnv('DATABASE_POOL_MAX', DEFAULT_POOL_MAX),
    connectionTimeoutMillis: positiveIntFromEnv(
      'DATABASE_CONNECTION_TIMEOUT_MS',
      DEFAULT_CONNECTION_TIMEOUT_MS,
    ),
    idleTimeoutMillis: positiveIntFromEnv(
      'DATABASE_IDLE_TIMEOUT_MS',
      DEFAULT_IDLE_TIMEOUT_MS,
    ),
    /*
     * Both halves of one guard. statement_timeout is enforced by Postgres
     * and is what frees the CONNECTION; query_timeout is enforced by
     * node-postgres and is what frees the REQUEST when the server has
     * stopped answering at all. Neither substitutes for the other.
     */
    statement_timeout: statementTimeout,
    query_timeout: statementTimeout,
    /*
     * Names the connection in pg_stat_activity. Free, and it is the
     * difference between "some client is holding 40 connections" and
     * knowing which one - which matters most on a pooler shared with the
     * worker and with migrations.
     */
    application_name: process.env.DATABASE_APPLICATION_NAME ?? 'career-os-api',
  };
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error('DATABASE_URL must be configured');
    }

    super({
      adapter: new PrismaPg(poolConfigFromEnv(connectionString)),
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  /*
   * Only reached when shutdown hooks are enabled on the application, which
   * main.ts now does. Without them Nest never calls this, and the process
   * exited on SIGTERM with its pool still open - so every deploy left
   * connections to be reaped by the server's own timeout rather than
   * closed, which on a shared pooler is other people's problem too.
   */
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
