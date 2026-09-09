import { AsyncLocalStorage } from 'node:async_hooks';

/*
 * The current request's correlation id, available anywhere without being
 * threaded through every function signature.
 *
 * WHY NOT A PARAMETER. The alternative is passing a requestId into every
 * service method that might log - through the ingestion pipeline, the
 * GitHub client, the market adapters. That is a large, invasive change to
 * frozen code for a diagnostic concern, and every new method would have to
 * remember to accept and forward it. AsyncLocalStorage keeps the plumbing
 * in one file.
 *
 * It holds ONE value, and that value is an opaque id we generated or
 * validated. Nothing user-owned goes in here: it is deliberately not a
 * "request context" that accumulates a user, a session and a body, because
 * that is how such a thing ends up being logged wholesale.
 */

type RequestContext = {
  requestId: string;
};

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with `requestId` attached to everything it awaits. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

/**
 * The current request's id, or null outside a request.
 *
 * Null rather than a placeholder, so a log line from the CLI or from
 * startup is honestly uncorrelated rather than carrying a fake id that a
 * reader would try to search for.
 */
export function currentRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}
