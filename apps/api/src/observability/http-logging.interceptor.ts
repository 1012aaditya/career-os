import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

import { safeRoute } from './log-fields.js';
import { requestIdOf } from './request-id.middleware.js';
import { StructuredLogger } from './structured-logger.js';

/*
 * One line per request: what was asked, what came back, how long it took.
 *
 * WHAT IS DELIBERATELY NOT HERE. No request body, no response body, no
 * headers, no query string. Those are where the credentials and the
 * personal data are, and a logger that takes them "just for debugging" is
 * a logger that will eventually be the reason a resume ends up in a log
 * aggregator.
 *
 * THE ROUTE IS A PATTERN, NOT A URL, and that distinction is the reason
 * this interceptor exists rather than an off-the-shelf HTTP logger.
 * `/v1/resume-imports/8f3a…/file` names one person's document;
 * `/v1/resume-imports/:id/file` names an endpoint. Nest gives us the
 * matched pattern, and `safeRoute` masks identifiers on the paths where it
 * cannot - a 404, a request that never reached a controller.
 *
 * Errors are logged by the exception filter rather than here, so a failing
 * request produces one diagnostic line and one access line rather than two
 * half-descriptions of the same thing.
 */
@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: StructuredLogger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const startedAt = Date.now();

    const method = request.method;
    const route = this.routeOf(context, request);
    const requestId = requestIdOf(request);

    return next.handle().pipe(
      tap({
        next: () => {
          const response = http.getResponse<Response>();

          this.logger.event('info', 'http.request', {
            requestId,
            method,
            route,
            statusCode: response.statusCode,
            durationMs: Date.now() - startedAt,
            outcome: 'ok',
          });
        },
        error: () => {
          /*
           * The access line for a failed request. The DIAGNOSTIC line -
           * error class, code, category - is written by the exception
           * filter, which is the only place that has seen the throwable.
           * Recording the status here as well would mean guessing at it
           * before the filter has decided.
           */
          this.logger.event('warn', 'http.request', {
            requestId,
            method,
            route,
            durationMs: Date.now() - startedAt,
            outcome: 'failed',
          });
        },
      }),
    );
  }

  /**
   * The matched route pattern, falling back to a masked path.
   *
   * Nest exposes the pattern on the handler's metadata via the underlying
   * router; when a handler was found this is `/resume-imports/:id`. When
   * one was not - a 404 - there is no pattern, and the raw path is masked
   * instead so an id in the URL still never reaches a line.
   */
  private routeOf(context: ExecutionContext, request: Request): string {
    const pattern = (request as Request & { route?: { path?: unknown } }).route
      ?.path;

    if (typeof pattern === 'string' && pattern !== '') {
      return pattern;
    }

    return safeRoute(request.originalUrl ?? request.url ?? '');
  }
}
