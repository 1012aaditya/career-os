import { Injectable, Optional } from '@nestjs/common';

import type { SourceClient, SourcePage } from '../source-adapter.js';

/*
 * The USAJOBS Historic JOA HTTP layer.
 *
 * NO CREDENTIAL, and that is a legal position rather than a convenience.
 * Registering for a USAJOBS API key binds the registrant to terms
 * forbidding derivative works; this endpoint needs no registration, and
 * USAJOBS' own documentation states it "does not require authorization or
 * authentication. The data returned by this endpoint is publicly
 * consumable." Sending a key here would be worse than pointless - it would
 * be opting into a contract we have a reason not to sign.
 *
 * A User-Agent IS required. Verified: the same request returns 200 with
 * any User-Agent and 403 with none. That is a server-side filter, not a
 * documented rule, which is exactly why it is recorded here rather than
 * assumed.
 *
 * Fifth pagination model: an opaque CONTINUATION TOKEN, already URL-
 * encoded by the source. Passed back verbatim - re-encoding it produces a
 * token the server rejects, and decoding it would be reading a cursor the
 * contract says is opaque.
 */

const BASE_URL = 'https://data.usajobs.gov/api/historicjoa';

/*
 * Required. The value identifies the caller, and unlike the Search API's
 * User-Agent - which USAJOBS specifies must be the email address used to
 * request a key - this endpoint takes no key and so no personal data
 * belongs in this header.
 */
const USER_AGENT = 'career-os';

/*
 * Scope slug -> OPM occupational series.
 *
 * The series is the source's own occupational taxonomy and each is a
 * slice that can be read to the end, which is what makes "completely read"
 * a meaningful claim about it. A free-text keyword would not be: it is a
 * question we asked, not a part of the market.
 */
const SERIES: Readonly<Record<string, string>> = {
  'it-2210': '2210',
  'engineering-0801': '0801',
  'mathematics-1520': '1520',
  'economist-0110': '0110',
};

export const USAJOBS_HISTORIC_SCOPES = Object.keys(SERIES).sort();

/*
 * 500 records per page and 125,717 records in series 2210 alone means a
 * complete walk is 252 pages. The ceiling is set below that deliberately:
 * this is a historic archive that does not change, a full backfill is an
 * operator decision rather than something a routine sync should do, and a
 * run that stops here records the scope as read-but-NOT-complete, which is
 * the honest description of what happened.
 */
const MAX_PAGES = 20;

const INTER_SCOPE_DELAY_MS = 1_000;

const MAX_ATTEMPTS = 3;

const BACKOFF_MS = [500, 1_500];

const MAX_RETRY_AFTER_MS = 10_000;

export type UsaJobsHistoricFailure =
  | 'unknown_scope'
  | 'rate_limited'
  | 'unavailable'
  | 'network_error'
  | 'unexpected_response';

export class UsaJobsHistoricRequestError extends Error {
  readonly scope: string;

  readonly status: number | null;

  readonly reason: UsaJobsHistoricFailure;

  constructor(
    scope: string,
    status: number | null,
    reason: UsaJobsHistoricFailure,
  ) {
    super(`USAJOBS historic request failed: ${scope} (${reason})`);

    this.name = 'UsaJobsHistoricRequestError';
    this.scope = scope;
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

  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : null;
}

@Injectable()
export class UsaJobsHistoricClient implements SourceClient {
  constructor(
    @Optional()
    private readonly sleep: Sleep = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  readonly interScopeDelayMs = INTER_SCOPE_DELAY_MS;

  readonly maxPagesPerScope = MAX_PAGES;

  async fetchScope(scope: string, cursor: string | null): Promise<SourcePage> {
    const series = SERIES[scope];

    if (series === undefined) {
      throw new UsaJobsHistoricRequestError(scope, null, 'unknown_scope');
    }

    const url =
      `${BASE_URL}?PositionSeries=${encodeURIComponent(series)}` +
      /*
       * Verbatim. The token arrives already percent-encoded inside
       * paging.next, and encoding it again yields one the server rejects.
       */
      (cursor === null ? '' : `&continuationtoken=${cursor}`);

    const body = await this.get(url, scope);

    return { body, nextCursor: this.nextCursor(body) };
  }

  /**
   * The next continuation token, or null when the series is exhausted.
   *
   * The source returns a token on every page including the last, so the
   * token alone cannot say "done". Exhaustion is decided by an empty data
   * array, which is the only signal that actually means it.
   */
  private nextCursor(body: unknown): string | null {
    const envelope = body as {
      data?: unknown;
      paging?: { metadata?: { continuationToken?: unknown } };
    } | null;

    if (!Array.isArray(envelope?.data) || envelope.data.length === 0) {
      return null;
    }

    const token = envelope.paging?.metadata?.continuationToken;

    return typeof token === 'string' && token.length > 0 ? token : null;
  }

  classifyFailure(error: unknown): string {
    return error instanceof UsaJobsHistoricRequestError
      ? error.reason
      : 'unexpected_response';
  }

  private async get(url: string, scope: string): Promise<unknown> {
    let lastError: UsaJobsHistoricRequestError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response;

      try {
        response = await fetch(url, {
          headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        });
      } catch {
        /* The caught error is never inspected and never attached. */
        lastError = new UsaJobsHistoricRequestError(
          scope,
          null,
          'network_error',
        );

        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(BACKOFF_MS[attempt - 1] ?? 0);
          continue;
        }

        throw lastError;
      }

      if (response.status === 429) {
        const wait = retryAfterMs(response.headers.get('retry-after'));

        lastError = new UsaJobsHistoricRequestError(scope, 429, 'rate_limited');

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
        lastError = new UsaJobsHistoricRequestError(
          scope,
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
        throw new UsaJobsHistoricRequestError(
          scope,
          response.status,
          'unexpected_response',
        );
      }

      try {
        return (await response.json()) as unknown;
      } catch {
        throw new UsaJobsHistoricRequestError(
          scope,
          response.status,
          'unexpected_response',
        );
      }
    }

    throw (
      lastError ??
      new UsaJobsHistoricRequestError(scope, null, 'unexpected_response')
    );
  }
}
