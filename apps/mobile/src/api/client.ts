import { supabase } from '../lib/supabase';
import {
  failureMessage,
  isRetryable,
  REQUEST_TIMEOUT_MS,
  type FailureKind,
  type HttpMethod,
} from './request-policy';
import { invalidateSession } from './session-invalidation';

const apiUrl = process.env.EXPO_PUBLIC_API_URL;

if (!apiUrl) {
  throw new Error('EXPO_PUBLIC_API_URL must be configured');
}

const API_BASE_URL = `${apiUrl.replace(/\/$/, '')}/v1`;

/**
 * A failed request, classified.
 *
 * `status` is unchanged for the callers that already read it. What is new
 * is `kind`, because a screen needs to tell "the server refused" from "we
 * never reached the server" from "the session is gone" - and a status code
 * cannot express the middle one, since a request that never completed has
 * no status at all.
 */
export class ApiError extends Error {
  readonly status: number;

  readonly kind: FailureKind;

  /** Whether offering the user a retry makes sense for this failure. */
  readonly retryable: boolean;

  constructor(status: number, message: string, kind: FailureKind = 'server') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
    this.retryable = isRetryable(kind);
  }
}

type RequestOptions = {
  method?: HttpMethod;
  body?: unknown;
  /**
   * Overrides the default ceiling for one call.
   *
   * Exists for the poll loop on the import screen, which issues many short
   * requests and would rather give up on one than hold the whole loop. Not
   * a way to wait LONGER - a request needing more than the default is a
   * server problem rather than a client one.
   */
  timeoutMs?: number;
};

/*
 * There is no retry anywhere in this file, and that is a decision rather
 * than an omission. A timeout means we stopped listening, not that the
 * server stopped working - so automatically retrying `DELETE /v1/account`
 * would race an operation that may already have succeeded. Retrying is
 * something a person does by pressing a button, and every screen that can
 * fail offers one. See request-policy.ts.
 */
export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const method = options.method ?? 'GET';

  const {
    data: { session },
  } = await supabase.auth.getSession();

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (session?.access_token) {
    headers.Authorization = `Bearer ${session.access_token}`;
  }

  /*
   * The timeout. Before this, a request to an API that accepted the
   * connection and never answered would hang forever - and with it the
   * screen's loading state, which has no way to end on its own.
   *
   * AbortController rather than Promise.race, because racing leaves the
   * underlying request running and its socket open. Aborting stops it.
   */
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? REQUEST_TIMEOUT_MS,
  );

  let response: Response;

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
  } catch (error) {
    /*
     * The thrown value is classified by shape and then discarded. A fetch
     * error carries the whole request, headers included - and every
     * request here carries a bearer token.
     */
    const aborted =
      error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'TimeoutError');

    const kind: FailureKind = aborted ? 'timeout' : 'offline';

    throw new ApiError(0, failureMessage(kind), kind);
  } finally {
    /*
     * Always cleared, including on the success path. An uncleared
     * fifteen-second timer per request would keep firing into a controller
     * nothing is listening to, and would hold the timer queue busy.
     */
    clearTimeout(timer);
  }

  /*
   * 401 handled before anything else, because it is the one status whose
   * meaning is about the SESSION rather than about the request.
   *
   * The sign-out is started and deliberately not awaited: awaiting would
   * make every screen's error path wait on a network call to Supabase
   * before it could render, and the outcome does not change what this
   * function throws. Concurrency is handled inside invalidateSession - the
   * first 401 starts it and the rest join it - and no screen navigates,
   * because AuthProvider observes the cleared session and RootNavigator
   * swaps declaratively.
   */
  if (response.status === 401) {
    void invalidateSession(() => supabase.auth.signOut());

    throw new ApiError(401, failureMessage('unauthenticated'), 'unauthenticated');
  }

  if (!response.ok) {
    let message = '';

    try {
      const errorBody = (await response.json()) as {
        message?: string | string[];
      };

      if (Array.isArray(errorBody.message)) {
        message = errorBody.message.join(', ');
      } else if (errorBody.message) {
        message = errorBody.message;
      }
    } catch {
      /* Not JSON. The generic message below is used instead. */
    }

    /*
     * A 5xx gets OUR message rather than the server's. A 4xx is a refusal
     * the API wrote for a user - PR-3 made those safe and readable - but a
     * 500 body is plumbing, and "Internal server error" tells a person
     * nothing they can act on.
     */
    const useServerMessage = response.status < 500;

    throw new ApiError(
      response.status,
      failureMessage('server', useServerMessage ? message : ''),
      'server',
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

/**
 * The user-facing message for any thrown value.
 *
 * One place, so a screen never has to decide whether what it caught has a
 * `.message` worth showing. Anything that is not an ApiError - a bug in
 * our own code, a parse failure - gets the generic sentence rather than
 * its own text, which is what keeps an internal message out of the UI.
 */
export function describeError(error: unknown): string {
  return error instanceof ApiError ? error.message : failureMessage('unknown');
}

/** Whether a screen should offer the user a retry for this failure. */
export function canRetry(error: unknown): boolean {
  return error instanceof ApiError ? error.retryable : true;
}
