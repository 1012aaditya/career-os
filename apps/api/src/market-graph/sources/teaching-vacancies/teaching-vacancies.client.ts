import { Injectable, Optional } from '@nestjs/common';

import type { SourceClient, SourcePage } from '../source-adapter.js';

/*
 * The UK Teaching Vacancies (DfE) HTTP layer.
 *
 * No credential. The licence is stated by the API itself, in every
 * response envelope:
 *   "license": { "name": "Open Government License",
 *                "url": ".../open-government-licence/version/3/" }
 * and OGL v3 grants the right to "exploit the Information commercially
 * and non-commercially". The service's own API terms confirm reuse of
 * job listings under OGL with a single exception - you must not charge a
 * fee for contacting, interviewing or hiring a respondent - which a market
 * statistic does not engage.
 *
 * Third pagination model in the pipeline: a page NUMBER, where the first
 * two sources used no pagination at all and a byte offset. The cursor is
 * the next page number as an opaque string, which is the same trick the
 * offset source uses and is why the contract needed nothing new for it.
 */

const BASE_URL = 'https://teaching-vacancies.service.gov.uk/api/v1/jobs.json';

const USER_AGENT = 'career-os';

/*
 * The whole corpus is one scope.
 *
 * The API exposes no server-side filter that partitions the vacancies
 * into slices that can each be read to the end, and inventing one from a
 * query would be a question we asked rather than a part of the market -
 * coverage over it would mean nothing. So the source declares the single
 * scope the schema reserves for exactly this case.
 */
export const TEACHING_VACANCIES_SCOPES = ['*'];

/*
 * 37 pages held the entire corpus on 2026-09-08. The ceiling is a safety
 * net well above the real maximum rather than a limit the source imposes,
 * so a walk that reaches it means the corpus grew unexpectedly and the run
 * is correctly recorded as read-but-not-complete.
 */
const MAX_PAGES = 200;

/* No published rate limit and no rate-limit headers returned. An unknown
 * ceiling is not an absent one, so the walk paces itself. */
const INTER_SCOPE_DELAY_MS = 1_000;

const MAX_ATTEMPTS = 3;

const BACKOFF_MS = [500, 1_500];

const MAX_RETRY_AFTER_MS = 10_000;

export type TeachingVacanciesFailure =
  | 'unknown_scope'
  | 'rate_limited'
  | 'unavailable'
  | 'network_error'
  | 'unexpected_response';

export class TeachingVacanciesRequestError extends Error {
  readonly scope: string;

  readonly status: number | null;

  readonly reason: TeachingVacanciesFailure;

  constructor(
    scope: string,
    status: number | null,
    reason: TeachingVacanciesFailure,
  ) {
    super(`Teaching Vacancies request failed: ${scope} (${reason})`);

    this.name = 'TeachingVacanciesRequestError';
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
export class TeachingVacanciesClient implements SourceClient {
  constructor(
    @Optional()
    private readonly sleep: Sleep = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  readonly interScopeDelayMs = INTER_SCOPE_DELAY_MS;

  readonly maxPagesPerScope = MAX_PAGES;

  async fetchScope(scope: string, cursor: string | null): Promise<SourcePage> {
    if (!TEACHING_VACANCIES_SCOPES.includes(scope)) {
      throw new TeachingVacanciesRequestError(scope, null, 'unknown_scope');
    }

    const page = cursor === null ? 1 : Number(cursor);

    if (!Number.isInteger(page) || page < 1) {
      throw new TeachingVacanciesRequestError(
        scope,
        null,
        'unexpected_response',
      );
    }

    const body = await this.get(`${BASE_URL}?page=${page}`, scope);

    return { body, nextCursor: this.nextCursor(body, page) };
  }

  /**
   * The next page number, or null when the corpus is exhausted.
   *
   * Read from `meta.totalPages` rather than from `links.next`, because
   * `links.next` is an absolute URL and treating it as the cursor would
   * let the source redirect the walk anywhere. The cursor stays a number
   * we chose, built from a count the source published.
   */
  private nextCursor(body: unknown, page: number): string | null {
    const meta = (body as { meta?: { totalPages?: unknown } } | null)?.meta;
    const totalPages = meta?.totalPages;

    if (typeof totalPages !== 'number' || !Number.isFinite(totalPages)) {
      /* No count means we cannot prove there is more, so we stop and the
       * scope is recorded as read but not complete. */
      return null;
    }

    return page < totalPages ? String(page + 1) : null;
  }

  classifyFailure(error: unknown): string {
    return error instanceof TeachingVacanciesRequestError
      ? error.reason
      : 'unexpected_response';
  }

  private async get(url: string, scope: string): Promise<unknown> {
    let lastError: TeachingVacanciesRequestError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response;

      try {
        response = await fetch(url, {
          headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        });
      } catch {
        /* The caught error is never inspected and never attached. */
        lastError = new TeachingVacanciesRequestError(
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

        lastError = new TeachingVacanciesRequestError(
          scope,
          429,
          'rate_limited',
        );

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
        lastError = new TeachingVacanciesRequestError(
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
        throw new TeachingVacanciesRequestError(
          scope,
          response.status,
          'unexpected_response',
        );
      }

      try {
        return (await response.json()) as unknown;
      } catch {
        /* A 200 that is not JSON is a broken response, not an empty day. */
        throw new TeachingVacanciesRequestError(
          scope,
          response.status,
          'unexpected_response',
        );
      }
    }

    throw (
      lastError ??
      new TeachingVacanciesRequestError(scope, null, 'unexpected_response')
    );
  }
}
