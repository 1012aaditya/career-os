import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { safeRoute } from './log-fields.js';
import { requestIdOf } from './request-id.middleware.js';
import { StructuredLogger } from './structured-logger.js';

/*
 * The last thing that runs before a client sees a failure.
 *
 * TWO JOBS, and they pull in opposite directions. The client must learn as
 * little as possible: no stack, no provider text, no database message, no
 * file path. The operator must learn enough to act: which route, which
 * kind of failure, which code, and - crucially - a correlation id that
 * ties the user's screenshot to the server's line.
 *
 * The split is: everything diagnostic goes to the LOG, and the response
 * carries a safe sentence plus the request id.
 *
 * WHAT IS PRESERVED. A thrown HttpException is a decision somebody made -
 * a 409 for too many imports, a 404 for an id that is not yours, a 401 for
 * a bad token - and PR-2 and PR-3 already made those messages safe and
 * user-facing. They pass through untouched. Turning them into 500s would
 * destroy real information; rewriting their messages would undo two
 * phases of work.
 *
 * WHAT IS REPLACED. Anything that is not an HttpException reached here by
 * accident: a Prisma error, a TypeError, a provider client throwing. Those
 * become a 500 with a fixed sentence, because their own messages are
 * exactly the ones that carry connection strings and bucket names.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: StructuredLogger) {}

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') {
      throw exception;
    }

    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const requestId = requestIdOf(request);
    const route = this.routeOf(request);
    const method = request.method;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();

      /*
       * A 5xx thrown deliberately is still a server failure and still
       * needs a diagnostic line - the ServiceUnavailableException PR-2
       * throws when Supabase Auth stalls is the case that matters. A 4xx
       * is the system working, and logging every one at error level would
       * bury the real failures under a wall of 401s.
       */
      if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
        this.logger.failure('http.error', exception, {
          requestId,
          method,
          route,
          statusCode: status,
          errorCategory: 'dependency',
        });
      } else {
        this.logger.event('info', 'http.client_error', {
          requestId,
          method,
          route,
          statusCode: status,
        });
      }

      /*
       * The body Nest would have produced, plus the correlation id. The
       * message is the one the thrower chose and PR-3 verified as safe.
       */
      const body = exception.getResponse();

      response.status(status).json(
        typeof body === 'string'
          ? { statusCode: status, message: body, requestId }
          : { ...(body as Record<string, unknown>), requestId },
      );

      return;
    }

    /*
     * Unexpected. The error is reduced to a class, a code and a category
     * before anything is written, and the original never leaves this
     * method.
     *
     * This is where a P2028 - the transaction-start timeout PR-4 found
     * against the Sydney pooler - becomes visible: it arrives as a
     * PrismaClientKnownRequestError with code P2028, and is logged with
     * errorCategory 'database' so it can be alerted on separately from a
     * flaky third party. What is NOT logged is its message, which for a
     * connection failure contains the connection string.
     */
    this.logger.failure('http.unhandled', exception, {
      requestId,
      method,
      route,
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    });

    /*
     * The class, the code and the category went to the LOG on the line
     * above and appear nowhere below. A caller learning that the failure
     * was a `PrismaClientKnownRequestError` learns which database we run
     * and that it is currently unhappy, which is free reconnaissance.
     *
     * The request id is what makes this actionable anyway: a user quotes
     * it, and an operator finds the line that has everything else.
     */
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Something went wrong.',
      requestId,
    });
  }

  private routeOf(request: Request): string {
    const pattern = (request as Request & { route?: { path?: unknown } }).route
      ?.path;

    if (typeof pattern === 'string' && pattern !== '') {
      return pattern;
    }

    return safeRoute(request.originalUrl ?? request.url ?? '');
  }
}
