import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { StructuredLogger } from '../observability/structured-logger.js';

/*
 * Whether this instance can serve traffic.
 *
 * THE BUG THIS REPLACES. `/health/db` answered HTTP 200 with a body saying
 * `{"status":"error","database":"unreachable"}`. Every load balancer,
 * orchestrator and uptime check in existence reads the STATUS CODE - so a
 * dead database read as a healthy instance, and the one endpoint whose job
 * was to notice would have kept sending traffic into it.
 *
 * WHAT READINESS DEPENDS ON, and what it deliberately does not. The
 * database is required: without it every authenticated route fails, so an
 * instance that cannot reach Postgres should be taken out of rotation.
 * GitHub is NOT required - a GitHub outage should degrade one feature, not
 * empty the load balancer. Neither is any Market Graph source: those are
 * read by a CLI, and a provider being down has no bearing on whether this
 * process can serve a search over data already ingested. Supabase Auth is
 * a harder call and is deliberately excluded too: PR-2 bounded that call
 * with a 5s timeout and returns 503 per-request, which degrades the
 * affected requests without declaring the whole instance unfit.
 *
 * A readiness check that depends on everything is a readiness check that
 * takes the fleet down when a third party sneezes.
 */

/**
 * How long a readiness probe may take before it is called a failure.
 *
 * Two seconds. Long enough for a healthy round trip - even the Sydney
 * pooler answers a trivial query well inside it - and short enough that a
 * probe on a five-second interval never overlaps itself.
 *
 * This bound matters more than it looks given what PR-4 found: against
 * that pooler, acquiring a connection can take seconds. A probe with no
 * ceiling would queue behind the same contention it is meant to detect.
 */
const READINESS_TIMEOUT_MS = 2_000;

/**
 * How long a result is reused.
 *
 * A probe every second against a pool of ten connections is a meaningful
 * fraction of the pool spent on health checking - and PR-4 established
 * that connection acquisition here is not free. One second of cache makes
 * the probe's cost independent of how often it is called, while still
 * turning a real outage around within a second.
 */
const READINESS_CACHE_MS = 1_000;

export type DependencyStatus = 'ok' | 'unavailable';

export type ReadinessResult = {
  ready: boolean;
  checks: { database: DependencyStatus };
  /** How long the underlying check took, for diagnosing slow dependencies. */
  durationMs: number;
};

@Injectable()
export class HealthService {
  private cached: { at: number; result: ReadinessResult } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * Whether the process is running.
   *
   * Takes no dependency on anything, and that is the entire point: a
   * liveness probe that consults the database will restart a perfectly
   * healthy process during a database incident, turning a degradation into
   * an outage and losing every in-flight request with it.
   */
  liveness() {
    return { status: 'ok' as const, service: 'career-os-api' };
  }

  /**
   * Whether this instance should receive traffic.
   *
   * `now` is a parameter so the cache can be tested at stated instants
   * rather than by sleeping.
   */
  async readiness(now: number = Date.now()): Promise<ReadinessResult> {
    if (this.cached !== null && now - this.cached.at < READINESS_CACHE_MS) {
      return this.cached.result;
    }

    const result = await this.checkDatabase();

    this.cached = { at: now, result };

    return result;
  }

  /**
   * The smallest question that proves the database is usable.
   *
   * `SELECT 1` - no table, no plan, no lock, and nothing that could be
   * slow for a reason other than the connection itself. Deliberately NOT
   * inside a transaction: an interactive transaction is exactly what fails
   * with P2028 against the current pooler, and a probe that reproduces the
   * outage it is meant to observe is not a probe.
   */
  private async checkDatabase(): Promise<ReadinessResult> {
    const startedAt = Date.now();

    let timer: NodeJS.Timeout | undefined;

    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('readiness_timeout')),
          READINESS_TIMEOUT_MS,
        );
      });

      await Promise.race([this.prisma.$queryRaw`SELECT 1`, timeout]);

      return {
        ready: true,
        checks: { database: 'ok' },
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;

      /*
       * The diagnostic an operator needs, and nothing more. The error is
       * reduced to a class and a code before it is written - a Prisma
       * connection failure carries the connection string in its message,
       * and this is the one code path guaranteed to run during exactly the
       * incident where that message would be most tempting to keep.
       */
      this.logger.failure('db.readiness.failed', error, {
        dependency: 'database',
        dependencyStatus: 'unavailable',
        durationMs,
        operation: 'readiness',
      });

      return {
        ready: false,
        checks: { database: 'unavailable' },
        durationMs,
      };
    } finally {
      /*
       * Always cleared. An uncleared two-second timer per probe, at one
       * probe a second, is a steadily growing pile of rejections nobody
       * is listening for.
       */
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
