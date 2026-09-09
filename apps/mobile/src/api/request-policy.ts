/*
 * What the app is willing to wait for, and what it is willing to repeat.
 *
 * Pure: no fetch, no timers, no Supabase. Every rule here is a function of
 * its arguments, which is what lets them be asserted directly rather than
 * inferred from a screen's behaviour.
 *
 * Two questions live here, and they are related in a way that is easy to
 * get wrong. A timeout says "stop waiting"; it does NOT say "the request
 * did not happen". A DELETE that timed out may well have reached the
 * server and succeeded, so a client that retries it on timeout is a client
 * that can delete twice. The second rule below exists because the first
 * one makes it necessary.
 */

/**
 * How long any one request may take.
 *
 * Fifteen seconds. Long enough for a cold API instance on a slow mobile
 * connection - a first request after a deploy can spend several seconds
 * before it is even routed - and short enough that a user staring at a
 * spinner gets an answer rather than a decision to close the app.
 *
 * The account deletion endpoint is the slowest thing here: it walks a
 * storage prefix and cascades a dozen tables. It is still comfortably
 * inside this, and if it were not, the right fix would be to make that
 * endpoint asynchronous rather than to let the phone wait longer.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Methods that change something on the server.
 *
 * The list is by METHOD rather than by path, because a path list has to be
 * maintained and this does not: a route added later is covered by the rule
 * on the day it is written.
 */
const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

export type HttpMethod = 'GET' | (typeof MUTATING_METHODS)[number];

export function isMutating(method: HttpMethod): boolean {
  return (MUTATING_METHODS as readonly string[]).includes(method);
}

/**
 * Whether a failed request may be sent again automatically.
 *
 * The answer today is NEVER for a mutation, and the reasoning matters more
 * than the value: a timeout or a dropped connection tells us we stopped
 * listening, not that the server stopped working. `DELETE /v1/account` and
 * `DELETE /v1/resume-imports/:id` are both idempotent server-side, so a
 * repeat would not corrupt anything - but a repeat that races the first
 * attempt would report a confusing failure for an operation that actually
 * succeeded, and the user is the one who should decide whether to try
 * again.
 *
 * A GET is safe to repeat by definition, and this function says so, but
 * nothing in the client retries automatically either. Retries belong to a
 * screen where a person pressed a button.
 */
export function mayRetryAutomatically(method: HttpMethod): boolean {
  return !isMutating(method);
}

/** Why a request failed, in terms a screen can act on. */
export type FailureKind =
  /** The session is gone. Not the user's fault and not retryable here. */
  | 'unauthenticated'
  /** We stopped waiting. The request may or may not have been performed. */
  | 'timeout'
  /** The request never completed - no signal, no route, DNS, TLS. */
  | 'offline'
  /** The server answered, with a refusal. */
  | 'server'
  /** Anything else, including a response we could not parse. */
  | 'unknown';

/**
 * What to tell a person, per failure.
 *
 * Written for somebody holding a phone rather than for a log: no status
 * codes, no hostnames, no provider names. The server's own message is used
 * for 4xx refusals - those are already written for a user by the API,
 * which PR-3 made safe - and replaced for everything else, where the
 * underlying text would be network plumbing.
 */
export function failureMessage(
  kind: FailureKind,
  serverMessage?: string,
): string {
  switch (kind) {
    case 'unauthenticated':
      return 'Your session has expired. Please sign in again.';
    case 'timeout':
      return 'That took too long to respond. Check your connection and try again.';
    case 'offline':
      return 'Cannot reach Career OS. Check your connection and try again.';
    case 'server':
      return serverMessage && serverMessage.trim() !== ''
        ? serverMessage
        : 'Something went wrong. Please try again.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

/**
 * Whether offering a "Try again" button makes sense.
 *
 * False for an expired session, because retrying the same request with the
 * same dead token will fail identically - the app signs the user out
 * instead, and a retry button beside that would be a button that cannot
 * work.
 */
export function isRetryable(kind: FailureKind): boolean {
  return kind !== 'unauthenticated';
}
