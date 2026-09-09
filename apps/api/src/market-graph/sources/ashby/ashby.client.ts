import { Injectable, Optional } from '@nestjs/common';

import {
  MarketSourceCredentials,
  MissingCredentialError,
  type SourceCredentialRequirement,
} from '../source-credentials.js';
import type { SourceClient, SourcePage } from '../source-adapter.js';

/*
 * The Ashby job board HTTP layer.
 *
 * Knows how to fetch one board and nothing else. What any of the response
 * MEANS belongs to the adapter, which is pure and therefore testable
 * without a network.
 *
 * This is the first client written for a source that MIGHT need a
 * credential, and it is written that way even though the endpoint it
 * currently reaches does not. The partner form of this feed is
 * consent-gated and would be authenticated; the public form is not. Rather
 * than write the unauthenticated client now and retrofit authentication
 * under time pressure later, the credential path exists, is tested, and is
 * inert while ASHBY_API_KEY is unset.
 *
 * CREDENTIAL RULES, and they are absolute:
 *   - the value is read at request time and used to build one header
 *   - it is never stored on this object, never put in queryParams, never
 *     returned, never logged, and never attached to a thrown error
 *   - every failure this file throws is an AshbyRequestError carrying a
 *     board token, a status and a short reason code, and never a Response,
 *     a cause, a URL or a header
 */

const BASE_URL = 'https://api.ashbyhq.com/posting-api/job-board';

const USER_AGENT = 'career-os';

/**
 * What the authenticated form of this feed would need.
 *
 * Declared here, beside the request that would use it, and mirrored onto
 * the descriptor by NAME only. Absent, the client sends no Authorization
 * header at all - which is correct for the public endpoint and is why a
 * missing key is not itself a failure for this source.
 */
export const ASHBY_CREDENTIALS: SourceCredentialRequirement = {
  envKeys: ['ASHBY_API_KEY'],
};

const MAX_ATTEMPTS = 3;

/*
 * Ashby publishes no rate limit for the posting API and did not throttle a
 * short sequential sample. That is not a promise, so the client paces
 * itself regardless. Being a well-behaved client of an endpoint nobody has
 * granted us access to is the cheapest insurance available - and this
 * source is not granted, so it is also the only decent thing to do.
 */
export const INTER_BOARD_DELAY_MS = 1_000;

/** Enforced between requests, including retries within one board. */
export const MIN_REQUEST_INTERVAL_MS = 1_000;

const BACKOFF_MS = [1_000, 3_000];

/*
 * The longest this will sit on a Retry-After before giving up and letting
 * the caller record a PARTIAL run. Blocking a run for an hour is worse
 * than reporting what we have and trying again later.
 */
const MAX_RETRY_AFTER_MS = 10_000;

/*
 * A ceiling on one request. Without it a provider that accepts a
 * connection and never answers holds an ingestion run open indefinitely,
 * and the partial unique index then blocks every later run for the source
 * until the stale-run lease expires.
 */
const REQUEST_TIMEOUT_MS = 20_000;

export type AshbyFailure =
  /** 404. The board token is wrong, or the board is not published. */
  | 'board_not_found'
  /** 401. A credential was sent and rejected, or one was required. */
  | 'unauthorized'
  /** 403. Authenticated and not permitted - the partnership answer. */
  | 'forbidden'
  | 'rate_limited'
  | 'unavailable'
  | 'timeout'
  | 'network_error'
  /** Declared in configuration terms, never the provider's. */
  | 'credentials_missing'
  | 'unexpected_response';

export class AshbyRequestError extends Error {
  readonly boardToken: string;

  readonly status: number | null;

  readonly reason: AshbyFailure;

  constructor(boardToken: string, status: number | null, reason: AshbyFailure) {
    super(`Ashby request failed: ${boardToken} (${reason})`);

    this.name = 'AshbyRequestError';
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
export class AshbyClient implements SourceClient {
  /*
   * When the last request was issued, as a monotonic-enough millisecond
   * count. The ONLY mutable state on this object, and it holds no
   * credential - which is stated because "the client holds the key" is the
   * obvious shortcut and it is the one this file exists not to take.
   */
  private lastRequestAt: number | null = null;

  constructor(
    @Optional()
    private readonly credentials: MarketSourceCredentials = new MarketSourceCredentials(),
    /*
     * Injected so tests exercise the real pacing and backoff decisions
     * without waiting. Nest reads the emitted paramtype for a type alias
     * as `Function` and would fail to find a provider for it, so @Optional
     * is what lets the default below apply and the application boot.
     */
    @Optional()
    private readonly sleep: Sleep = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    @Optional() private readonly clock: () => number = () => Date.now(),
  ) {}

  /**
   * Fetches one board in full.
   *
   * There is no pagination: the endpoint returns the whole board in one
   * response. A real property worth naming, because it means there is no
   * window in which the underlying set can shift mid-walk - this source
   * cannot produce a torn page.
   */
  async fetchBoard(boardToken: string): Promise<unknown> {
    const headers = this.headers(boardToken);
    const url = `${BASE_URL}/${encodeURIComponent(boardToken)}`;

    let lastError: AshbyRequestError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await this.pace();

      let response: Response;

      try {
        response = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        /*
         * The caught error is classified by NAME and then discarded. It is
         * never attached, never logged and never stored: a fetch failure
         * object carries the whole request, headers included, and this is
         * the client that may one day put a credential in one.
         */
        const timedOut =
          error instanceof Error &&
          (error.name === 'TimeoutError' || error.name === 'AbortError');

        lastError = new AshbyRequestError(
          boardToken,
          null,
          timedOut ? 'timeout' : 'network_error',
        );

        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(BACKOFF_MS[attempt - 1] ?? 0);
          continue;
        }

        throw lastError;
      }

      if (response.status === 404) {
        /* Not retried: a missing board will still be missing in a second. */
        throw new AshbyRequestError(boardToken, 404, 'board_not_found');
      }

      if (response.status === 401) {
        /*
         * Not retried, and deliberately distinct from 403. A credential
         * that is wrong now will be wrong on the next attempt, and hammering
         * an endpoint with a rejected credential is how an account gets
         * locked. Distinct from `credentials_missing` too: this one means
         * we HAD something and the provider refused it.
         */
        throw new AshbyRequestError(boardToken, 401, 'unauthorized');
      }

      if (response.status === 403) {
        /*
         * Authenticated and not permitted. For a partner feed this is the
         * status that means the partnership does not cover this board -
         * an access-state fact, not an outage, and it must never be
         * retried into looking like one.
         */
        throw new AshbyRequestError(boardToken, 403, 'forbidden');
      }

      if (response.status === 429) {
        const wait = retryAfterMs(response.headers.get('retry-after'));

        lastError = new AshbyRequestError(boardToken, 429, 'rate_limited');

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
        lastError = new AshbyRequestError(
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
        throw new AshbyRequestError(
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
         * board. Conflating the two is how a provider outage becomes "this
         * employer is not hiring".
         */
        throw new AshbyRequestError(
          boardToken,
          response.status,
          'unexpected_response',
        );
      }
    }

    throw (
      lastError ?? new AshbyRequestError(boardToken, null, 'unexpected_response')
    );
  }

  /**
   * The request headers, including authentication when it is configured.
   *
   * The value is read here and used here. It is not stored on the
   * instance, and the returned object is handed straight to fetch.
   */
  private headers(boardToken: string): Record<string, string> {
    const base: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    };

    const state = this.credentials.state(ASHBY_CREDENTIALS);

    /*
     * MISSING is not an error for this source, and that is a decision
     * rather than laziness: the endpoint this client reaches is public,
     * so an absent key means "use the public form", not "we are
     * misconfigured". The partner form would flip this branch to a throw,
     * and the reason code it would throw already exists so that the change
     * is one line rather than a new failure taxonomy.
     */
    if (state.kind !== 'CONFIGURED') {
      return base;
    }

    try {
      const resolved = this.credentials.resolve(ASHBY_CREDENTIALS);

      return {
        ...base,
        Authorization: `Basic ${Buffer.from(`${resolved.ASHBY_API_KEY}:`).toString('base64')}`,
      };
    } catch (error) {
      /*
       * Only reachable if configuration changed between the two calls
       * above. Re-thrown as this client's own error type carrying a code
       * and nothing else - the caught error names keys and no values, and
       * even that is not passed on.
       */
      if (error instanceof MissingCredentialError) {
        throw new AshbyRequestError(boardToken, null, 'credentials_missing');
      }

      throw error;
    }
  }

  /** Waits out the minimum interval since the previous request. */
  private async pace(): Promise<void> {
    const now = this.clock();

    if (this.lastRequestAt !== null) {
      const elapsed = now - this.lastRequestAt;

      if (elapsed < MIN_REQUEST_INTERVAL_MS) {
        await this.sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
      }
    }

    this.lastRequestAt = this.clock();
  }

  /*
   * The SourceClient surface.
   *
   * One response per board, so the cursor is always null and the page
   * ceiling is one.
   */

  readonly interScopeDelayMs = INTER_BOARD_DELAY_MS;

  readonly maxPagesPerScope = 1;

  async fetchScope(scope: string, _cursor: string | null): Promise<SourcePage> {
    return { body: await this.fetchBoard(scope), nextCursor: null };
  }

  classifyFailure(error: unknown): string {
    return error instanceof AshbyRequestError
      ? error.reason
      : 'unexpected_response';
  }
}
