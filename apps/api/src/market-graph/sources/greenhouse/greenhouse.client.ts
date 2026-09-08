import { Injectable, Optional } from '@nestjs/common';

import type { SourceClient, SourcePage } from '../source-adapter.js';

/*
 * The Greenhouse Job Board HTTP layer.
 *
 * Knows how to fetch one board and nothing else. It does not know what a
 * job is; deciding what any of the response MEANS belongs to the adapter,
 * which is pure and therefore testable without a network.
 *
 * There is no credential anywhere in this file. The endpoint is
 * unauthenticated, which removes a whole class of leak - but it also
 * removes the pressure that normally keeps a client from attaching the
 * request to the error it rejects with. That habit is still wrong here (a
 * URL is not a secret but a caught error object carries far more than a
 * URL), so every failure is a GreenhouseRequestError holding a board, a
 * status and a reason code, and never a Response or a cause.
 */

const BASE_URL = 'https://boards-api.greenhouse.io/v1/boards';

const USER_AGENT = 'career-os';

/*
 * Transient failures are retried a bounded number of times and then give
 * up. Retrying forever converts a Greenhouse outage into an infinite loop
 * holding an ingestion run open - and the partial unique index means that
 * run blocks every subsequent one for its source.
 */
const MAX_ATTEMPTS = 3;

/*
 * Greenhouse publishes no rate limit and did not throttle twenty rapid
 * sequential requests. That is not a promise, so the client waits between
 * boards regardless. Being a well-behaved client of an endpoint nobody
 * has granted us access to is the cheapest insurance available.
 */
export const INTER_BOARD_DELAY_MS = 250;

const BACKOFF_MS = [500, 1_500];

/*
 * The longest this will sit on a Retry-After before giving up and letting
 * the caller record a PARTIAL run. Blocking a run for an hour is worse
 * than reporting what we have and trying again later.
 */
const MAX_RETRY_AFTER_MS = 10_000;

export type GreenhouseFailure =
  /* 404. The board token is wrong, or the board was removed. */
  | 'board_not_found'
  | 'rate_limited'
  | 'unavailable'
  | 'network_error'
  | 'unexpected_response';

export class GreenhouseRequestError extends Error {
  readonly boardToken: string;

  readonly status: number | null;

  readonly reason: GreenhouseFailure;

  constructor(
    boardToken: string,
    status: number | null,
    reason: GreenhouseFailure,
  ) {
    super(`Greenhouse request failed: ${boardToken} (${reason})`);

    this.name = 'GreenhouseRequestError';
    this.boardToken = boardToken;
    this.status = status;
    this.reason = reason;
  }
}

type Sleep = (ms: number) => Promise<void>;

function retryAfterMs(header: string | null): number | null {
  if (header === null) {
    return null;
  }

  const seconds = Number(header.trim());

  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }

  return seconds * 1_000;
}

@Injectable()
export class GreenhouseClient implements SourceClient {
  constructor(
    /*
     * Injected so tests exercise the real backoff decisions without
     * actually waiting. Nest reads the emitted paramtype for a type alias
     * as `Function` and would fail to find a provider for it, so @Optional
     * is what lets the default below apply and the application boot.
     */
    @Optional()
    private readonly sleep: Sleep = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /**
   * Fetches one board in full.
   *
   * There is no pagination: the endpoint returns the entire board in one
   * response. That is a real property worth naming, because it means there
   * is no window during which the underlying set can shift mid-walk, so
   * this source cannot produce a torn page - a class of partial data every
   * paginated source will.
   */
  async fetchBoard(boardToken: string): Promise<unknown> {
    const url = `${BASE_URL}/${encodeURIComponent(boardToken)}/jobs?content=true`;

    let lastError: GreenhouseRequestError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response;

      try {
        response = await fetch(url, {
          headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        });
      } catch {
        /*
         * The caught error is deliberately not inspected and never
         * attached. It is a fetch failure; the only fact worth keeping is
         * that the request did not complete.
         */
        lastError = new GreenhouseRequestError(
          boardToken,
          null,
          'network_error',
        );

        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(BACKOFF_MS[attempt - 1] ?? 0);
          continue;
        }

        throw lastError;
      }

      if (response.status === 404) {
        /* Not retried: a missing board will still be missing in 500ms. */
        throw new GreenhouseRequestError(boardToken, 404, 'board_not_found');
      }

      if (response.status === 429) {
        const wait = retryAfterMs(response.headers.get('retry-after'));

        lastError = new GreenhouseRequestError(boardToken, 429, 'rate_limited');

        if (wait !== null && wait > MAX_RETRY_AFTER_MS) {
          throw lastError;
        }

        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(wait ?? BACKOFF_MS[attempt - 1] ?? 0);
          continue;
        }

        throw lastError;
      }

      if (response.status >= 500) {
        lastError = new GreenhouseRequestError(
          boardToken,
          response.status,
          'unavailable',
        );

        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(BACKOFF_MS[attempt - 1] ?? 0);
          continue;
        }

        throw lastError;
      }

      if (!response.ok) {
        throw new GreenhouseRequestError(
          boardToken,
          response.status,
          'unexpected_response',
        );
      }

      try {
        return (await response.json()) as unknown;
      } catch {
        /*
         * A 200 whose body is not JSON is a broken response, not an empty
         * board. Conflating the two is how a source outage becomes "the
         * job market is empty".
         */
        throw new GreenhouseRequestError(
          boardToken,
          response.status,
          'unexpected_response',
        );
      }
    }

    throw (
      lastError ??
      new GreenhouseRequestError(boardToken, null, 'unexpected_response')
    );
  }

  /*
   * The SourceClient surface.
   *
   * Greenhouse returns an entire board in one response, so its cursor is
   * always null and its page ceiling is one. That is a real property worth
   * stating in the return value rather than in the shape of the interface:
   * this source cannot produce a torn page, and a source that can will
   * return a cursor here instead.
   */

  readonly interScopeDelayMs = INTER_BOARD_DELAY_MS;

  readonly maxPagesPerScope = 1;

  async fetchScope(scope: string, _cursor: string | null): Promise<SourcePage> {
    return { body: await this.fetchBoard(scope), nextCursor: null };
  }

  classifyFailure(error: unknown): string {
    return error instanceof GreenhouseRequestError
      ? error.reason
      : 'unexpected_response';
  }
}
