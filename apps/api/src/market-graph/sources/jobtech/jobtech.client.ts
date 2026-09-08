import { Injectable, Optional } from '@nestjs/common';

import type { SourceClient, SourcePage } from '../source-adapter.js';

/*
 * The JobTech (Arbetsförmedlingen) JobSearch HTTP layer.
 *
 * The second source, and chosen largely because it is shaped unlike the
 * first. Greenhouse hands back a whole board in one unpaginated response
 * from a per-company endpoint; this is a national job bank with a global
 * query, real offset pagination, a hard server-side offset cap, a deeply
 * nested envelope and a coded occupational taxonomy. Every one of those is
 * a path the pipeline had never executed.
 *
 * No credential. The dataset is CC0 - verified in the API's own
 * swagger.json, which carries
 *   "license": { "name": "Ads are licensed under CC0" }
 * - which is the only affirmative licence among every source surveyed.
 * That is a statement about copyright and it is NOT a statement about
 * personal data; see the contact stripping in the adapter.
 */

const BASE_URL = 'https://jobsearch.api.jobtechdev.se/search';

const USER_AGENT = 'career-os';

/** The API's documented maximum page size. */
const PAGE_SIZE = 100;

/*
 * The API refuses `offset` above 2000 with a 400 naming the limit, so no
 * scope can be walked past 2000 ads however many it contains. Verified:
 * offset=2000 returns 200, offset=2001 returns
 * "2001 is not less or equal to 2000".
 *
 * This is the reason JobTech can do something Greenhouse cannot - produce
 * a scope that is READ but not READ COMPLETELY. The Data/IT field holds
 * 2535 ads today, so a walk of it stops 535 short and must say so.
 */
const MAX_OFFSET = 2000;

/*
 * Scope slug -> the source's occupation-field concept id.
 *
 * The scope is a slug and not the concept id itself because the concept id
 * is mixed-case with underscores ("apaJ_2ja_LuF") and scopes are
 * CHECK-constrained to lowercase. Keeping the mapping here is also the
 * right place for it: the canonical layers must not learn that this source
 * organises the world by occupational field.
 *
 * Each scope is a slice that CAN in principle be read to the end, which is
 * what makes "completely read" a meaningful claim about it. A free-text
 * query would not be: it is a question we asked, not a part of the market,
 * and coverage over it would mean nothing.
 */
const OCCUPATION_FIELDS: Readonly<Record<string, string>> = {
  'data-it': 'apaJ_2ja_LuF',
  teknik: '6Hq3_tKo_V57',
  naturvetenskap: 'kJeN_wmw_9wX',
  'kultur-media-design': '9puE_nYg_crq',
  'chefer-verksamhetsledare': 'bh3H_Y3h_5eD',
};

export const JOBTECH_SCOPES = Object.keys(OCCUPATION_FIELDS).sort();

/*
 * No rate limit is published for JobSearch (JobStream's docs state one
 * request per minute, which is a different service). An unknown ceiling is
 * not an absent one, so the walk paces itself.
 */
const INTER_SCOPE_DELAY_MS = 1_000;

const MAX_ATTEMPTS = 3;

const BACKOFF_MS = [500, 1_500];

const MAX_RETRY_AFTER_MS = 10_000;

export type JobTechFailure =
  | 'unknown_scope'
  | 'rate_limited'
  | 'unavailable'
  | 'network_error'
  | 'unexpected_response';

export class JobTechRequestError extends Error {
  readonly scope: string;

  readonly status: number | null;

  readonly reason: JobTechFailure;

  constructor(scope: string, status: number | null, reason: JobTechFailure) {
    super(`JobTech request failed: ${scope} (${reason})`);

    this.name = 'JobTechRequestError';
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
export class JobTechClient implements SourceClient {
  constructor(
    @Optional()
    private readonly sleep: Sleep = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  readonly interScopeDelayMs = INTER_SCOPE_DELAY_MS;

  /* 2000 / 100. Reaching it means the scope was not read to the end. */
  readonly maxPagesPerScope = MAX_OFFSET / PAGE_SIZE;

  /**
   * One page of one occupational field.
   *
   * The cursor is the offset, as an opaque string. It is opaque by
   * contract - the pipeline passes it back without reading it - which is
   * what lets a cursor-based source use the same interface.
   */
  async fetchScope(scope: string, cursor: string | null): Promise<SourcePage> {
    const conceptId = OCCUPATION_FIELDS[scope];

    if (conceptId === undefined) {
      throw new JobTechRequestError(scope, null, 'unknown_scope');
    }

    const offset = cursor === null ? 0 : Number(cursor);

    if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) {
      throw new JobTechRequestError(scope, null, 'unexpected_response');
    }

    const url =
      `${BASE_URL}?occupation-field=${encodeURIComponent(conceptId)}` +
      `&limit=${PAGE_SIZE}&offset=${offset}&sort=pubdate-desc`;

    const body = await this.get(url, scope);

    return { body, nextCursor: this.nextCursor(body, offset) };
  }

  /**
   * Where the next page starts, or null when the scope is exhausted.
   *
   * Returns null at the server's offset cap even when more ads exist. That
   * is not the walk giving up quietly: the caller records the scope as read
   * but NOT complete, so a signal drawn from it is flagged rather than
   * presented as covering the field.
   */
  private nextCursor(body: unknown, offset: number): string | null {
    const envelope = body as {
      total?: { value?: unknown };
      hits?: unknown;
    } | null;

    const hits = envelope?.hits;
    const total = envelope?.total?.value;

    if (!Array.isArray(hits) || hits.length < PAGE_SIZE) {
      return null;
    }

    const next = offset + PAGE_SIZE;

    if (next > MAX_OFFSET) {
      return null;
    }

    if (typeof total === 'number' && next >= total) {
      return null;
    }

    return String(next);
  }

  classifyFailure(error: unknown): string {
    return error instanceof JobTechRequestError
      ? error.reason
      : 'unexpected_response';
  }

  private async get(url: string, scope: string): Promise<unknown> {
    let lastError: JobTechRequestError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response;

      try {
        response = await fetch(url, {
          headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        });
      } catch {
        /* The caught error is never inspected and never attached. */
        lastError = new JobTechRequestError(scope, null, 'network_error');

        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(BACKOFF_MS[attempt - 1] ?? 0);
          continue;
        }

        throw lastError;
      }

      if (response.status === 429) {
        const wait = retryAfterMs(response.headers.get('retry-after'));

        lastError = new JobTechRequestError(scope, 429, 'rate_limited');

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
        lastError = new JobTechRequestError(
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
        throw new JobTechRequestError(
          scope,
          response.status,
          'unexpected_response',
        );
      }

      try {
        return (await response.json()) as unknown;
      } catch {
        /* A 200 that is not JSON is a broken response, not an empty field. */
        throw new JobTechRequestError(
          scope,
          response.status,
          'unexpected_response',
        );
      }
    }

    throw (
      lastError ?? new JobTechRequestError(scope, null, 'unexpected_response')
    );
  }
}
