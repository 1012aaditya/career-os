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

/*
 * TRANSACTION BUDGET, and why PR-6 left the numbers alone.
 *
 * PR-4 saw P2028 - "Unable to start a transaction in the given time" -
 * against the Sydney pooler, 2 failures in 5. PR-6 reproduced it under a
 * latency-injecting proxy in front of a LOCAL Postgres, holding schema,
 * query shape and pool config identical so that round-trip time was the
 * only variable. The measurements, 40 concurrent imports for distinct
 * users:
 *
 *   RTT     pool  succeeded  P2028   median
 *   0ms     10    40         0       94ms
 *   250ms   10    11         29      2008ms
 *   250ms   20    21         19      2004ms
 *   250ms   40    40         0       1890ms
 *
 * Read the second and third rows together: the successes track the POOL
 * SIZE, not the load. That is the whole diagnosis. An import transaction
 * is six round trips - BEGIN, the row lock, two counts, the insert,
 * COMMIT - so at 250ms it HOLDS a connection for about 1.9s. maxWait is
 * 2s. One pool's worth of transactions therefore starts, and everything
 * behind them waits longer than the budget allows and fails before doing
 * any work.
 *
 * So P2028 is not a timeout that is too small. It is hold time that is
 * twenty times too long, and hold time here is a function of DISTANCE.
 * Co-locating the API with the database takes the median from 2008ms to
 * 94ms and the failures from 29 to 0 - with the pool unchanged at 10.
 *
 * TWO FIXES WERE MEASURED AND REJECTED.
 *
 *   Raising maxWait to 15s: 21 of 40 still failed, but the failures moved
 *   from a fast, precisely-labelled P2028 to a generic error at a 10s
 *   median and a 20s maximum. That is not a fix; it is the same failure
 *   with worse latency and a worse name.
 *
 *   Enlarging the pool: it "works" only when the transactions do not
 *   contend. Under the real contention this transaction is FOR - many
 *   imports by ONE user, serialised on that user's row lock - a pool of
 *   40 was strictly worse than a pool of 10, median 21s, because a larger
 *   pool only lets more requests hold a connection while blocked on the
 *   lock.
 *
 * Hence: the defaults below are Prisma's own, restated rather than
 * changed. Nothing here is tuned to paper over topology. They are made
 * explicit and configurable because production must be able to move them
 * without a code change, and because a budget nobody can see is a budget
 * nobody can reason about - PR-4 lost days to exactly that.
 */

/** Time to acquire a connection and BEGIN. Prisma's default, made visible. */
const DEFAULT_TRANSACTION_MAX_WAIT_MS = 2_000;

/** Time the transaction body may take once started. Prisma's default. */
const DEFAULT_TRANSACTION_TIMEOUT_MS = 5_000;

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

/**
 * The budget for an interactive transaction on the request path.
 *
 * Exported so a caller states its budget rather than inheriting an
 * invisible library default, and so the numbers can be asserted in a test
 * without opening a connection.
 */
export function transactionBudget(): { maxWait: number; timeout: number } {
  return {
    maxWait: positiveIntFromEnv(
      'DATABASE_TRANSACTION_MAX_WAIT_MS',
      DEFAULT_TRANSACTION_MAX_WAIT_MS,
    ),
    timeout: positiveIntFromEnv(
      'DATABASE_TRANSACTION_TIMEOUT_MS',
      DEFAULT_TRANSACTION_TIMEOUT_MS,
    ),
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
