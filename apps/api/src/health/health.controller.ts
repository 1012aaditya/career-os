import { Controller, Get, HttpStatus, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { requestIdOf } from '../observability/request-id.middleware.js';
import { HealthService } from './health.service.js';

/*
 * The endpoints an orchestrator probes.
 *
 * Two questions, deliberately separate, because the right response to each
 * is opposite: a failing LIVENESS probe means restart this process, and a
 * failing READINESS probe means stop sending it traffic but leave it
 * alone. Conflating them means a database incident restarts every healthy
 * instance in the fleet.
 *
 * Unauthenticated, like the health endpoint always has been - a probe has
 * no credentials - which is also why the responses say as little as they
 * do. `{"database":"unavailable"}` is what an operator needs; the reason
 * it is unavailable lives in the log, correlated by request id.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Liveness. 200 for as long as the process can answer at all.
   *
   * Kept at the bare path as well as /live, because this is the route that
   * existed before PR-5 and something may already be pointed at it.
   */
  @Get()
  check() {
    return this.health.liveness();
  }

  @Get('live')
  live() {
    return this.health.liveness();
  }

  /**
   * Readiness. 200 only when the dependencies this API requires are up.
   *
   * The status code is the answer. Before PR-5 this reported failure in a
   * 200 body, which every load balancer in existence reads as healthy -
   * so the one endpoint whose job was to notice a dead database was the
   * one guaranteeing traffic kept arriving at it.
   */
  @Get('ready')
  async ready(@Req() request: Request, @Res() response: Response) {
    const result = await this.health.readiness();

    const body = {
      status: result.ready ? 'ok' : 'not_ready',
      checks: result.checks,
      /*
       * Present on failure only. On the happy path there is nothing to
       * correlate; on failure this is what ties the probe to the
       * `db.readiness.failed` line that has the error class and code.
       */
      ...(result.ready ? {} : { requestId: requestIdOf(request) }),
    };

    response
      .status(result.ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
      .json(body);
  }

  /**
   * The pre-PR-5 database check, kept and corrected.
   *
   * It answered 200 while reporting the database unreachable. It is left
   * in place because something may be pointed at it, and it now returns
   * 503 when the database is down - the same semantics as /health/ready,
   * which is what it should always have had.
   */
  @Get('db')
  async database(@Res() response: Response) {
    const result = await this.health.readiness();

    response
      .status(result.ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
      .json({
        status: result.ready ? 'ok' : 'error',
        database: result.checks.database === 'ok' ? 'connected' : 'unreachable',
      });
  }
}
