import { Injectable, Optional } from '@nestjs/common';

import type { SourceClient, SourcePage } from '../source-adapter.js';

/*
 * The Jobicy HTTP layer.
 *
 * No credential. Jobicy's syndication terms grant reuse in its own words:
 * "Most integrations... can use the public API without a separate
 * agreement", with attribution and a polling ceiling of one request per
 * hour. The ceiling is respected by the operator's scheduling rather than
 * by this file, which is stated here so nobody assumes the code enforces
 * something it does not.
 *
 * The fourth shape, and the first with NO pagination at all: one request
 * returns the current window and there is no offset, page or cursor to
 * ask for more. nextCursor is therefore always null - honestly so, since
 * the source really has served everything it will serve - and the scope
 * records as complete. What that does NOT mean is that we have the market;
 * see the source's licence note.
 */

const BASE_URL = 'https://jobicy.com/api/v2/remote-jobs';

const USER_AGENT = 'career-os';

/** The API's documented maximum. */
const COUNT = 200;

/*
 * Scope slug -> the source's own industry filter value.
 *
 * Kept here, not in the canonical layers, for the same reason the Swedish
 * occupational-field map is: the graph must not learn that this source
 * organises the world by remote-work industry. `*` asks for everything.
 */
const INDUSTRIES: Readonly<Record<string, string | null>> = {
  '*': null,
  dev: 'dev',
  engineering: 'engineering',
  'data-science': 'data-science',
};

export const JOBICY_SCOPES = Object.keys(INDUSTRIES).sort();

/* Their stated ceiling is one poll per hour; this is the floor between
 * scopes within a single run, not a substitute for that schedule. */
const INTER_SCOPE_DELAY_MS = 2_000;

const MAX_ATTEMPTS = 3;

const BACKOFF_MS = [500, 1_500];

const MAX_RETRY_AFTER_MS = 10_000;

export type JobicyFailure =
  | 'unknown_scope'
  | 'rate_limited'
  | 'unavailable'
  | 'network_error'
  | 'unexpected_response';

export class JobicyRequestError extends Error {
  readonly scope: string;

  readonly status: number | null;

  readonly reason: JobicyFailure;

  constructor(scope: string, status: number | null, reason: JobicyFailure) {
    super(`Jobicy request failed: ${scope} (${reason})`);

    this.name = 'JobicyRequestError';
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
export class JobicyClient implements SourceClient {
  constructor(
    @Optional()
    private readonly sleep: Sleep = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  readonly interScopeDelayMs = INTER_SCOPE_DELAY_MS;

  /* One page is the whole of what this source will serve per scope. */
  readonly maxPagesPerScope = 1;

  async fetchScope(scope: string, cursor: string | null): Promise<SourcePage> {
    if (!(scope in INDUSTRIES)) {
      throw new JobicyRequestError(scope, null, 'unknown_scope');
    }

    if (cursor !== null) {
      /* There is no second page to ask for; being asked for one means the
       * caller and this client disagree about the source. */
      throw new JobicyRequestError(scope, null, 'unexpected_response');
    }

    const industry = INDUSTRIES[scope];
    const url =
      `${BASE_URL}?count=${COUNT}` +
      (industry === null || industry === undefined
        ? ''
        : `&industry=${encodeURIComponent(industry)}`);

    return { body: await this.get(url, scope), nextCursor: null };
  }

  classifyFailure(error: unknown): string {
    return error instanceof JobicyRequestError
      ? error.reason
      : 'unexpected_response';
  }

  private async get(url: string, scope: string): Promise<unknown> {
    let lastError: JobicyRequestError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response;

      try {
        response = await fetch(url, {
          headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        });
      } catch {
        /* The caught error is never inspected and never attached. */
        lastError = new JobicyRequestError(scope, null, 'network_error');

        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(BACKOFF_MS[attempt - 1] ?? 0);
          continue;
        }

        throw lastError;
      }

      if (response.status === 429) {
        const wait = retryAfterMs(response.headers.get('retry-after'));

        lastError = new JobicyRequestError(scope, 429, 'rate_limited');

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
        lastError = new JobicyRequestError(
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
        throw new JobicyRequestError(
          scope,
          response.status,
          'unexpected_response',
        );
      }

      try {
        return (await response.json()) as unknown;
      } catch {
        throw new JobicyRequestError(
          scope,
          response.status,
          'unexpected_response',
        );
      }
    }

    throw (
      lastError ?? new JobicyRequestError(scope, null, 'unexpected_response')
    );
  }
}
