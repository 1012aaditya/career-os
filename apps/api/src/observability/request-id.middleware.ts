import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

import { safeRequestId } from './log-fields.js';
import { runWithRequestId } from './request-context.js';

/*
 * Gives every request an id, and makes it available to everything the
 * request touches.
 *
 * WHY ACCEPT AN INCOMING ID AT ALL. A request that crossed a proxy or a
 * client already has a trace, and refusing it means an incident is
 * reconstructed from two unrelated identifiers. So `x-request-id` is
 * honoured - but only after `safeRequestId` has checked its shape, because
 * the value is written into every log line this request produces. An
 * unvalidated one is a newline injection that forges log entries, or a
 * kilobyte of padding on every line.
 *
 * The id is echoed on the response so a client - and the mobile app's
 * error reporting - can quote it, and so a user reporting "it said
 * reference abc123" gives an operator something to search for.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction) {
    const incoming = safeRequestId(request.headers[REQUEST_ID_HEADER]);
    const requestId = incoming ?? randomUUID();

    /*
     * Stored on the request as well as in async storage. The filter and
     * the interceptor read it from here rather than from the store,
     * because an exception thrown synchronously during routing can escape
     * the async context while the request object is always to hand.
     */
    (request as Request & { requestId?: string }).requestId = requestId;

    response.setHeader(REQUEST_ID_HEADER, requestId);

    runWithRequestId(requestId, () => {
      next();
    });
  }
}

/** The id attached by the middleware, or null if it never ran. */
export function requestIdOf(request: unknown): string | null {
  const candidate = (request as { requestId?: unknown } | null)?.requestId;

  return typeof candidate === 'string' ? candidate : null;
}
