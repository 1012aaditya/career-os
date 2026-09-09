import { Injectable, Optional } from '@nestjs/common';

import {
  MarketSourceCredentials,
  type SourceCredentialRequirement,
} from '../source-credentials.js';
import type { SourceClient, SourcePage } from '../source-adapter.js';

/*
 * The NAV / Arbeidsplassen HTTP layer.
 *
 * The FIRST source in this pipeline that needs a credential, and the
 * handling is deliberate because the obvious way to do it leaks.
 *
 * WHERE THE TOKEN MUST NOT GO. SourceDescriptor.queryParams is stored
 * verbatim on every ingestion run AND hashed into queryFingerprint, which
 * GET /v1/market/signals/:id serves. A token placed there would become a
 * plaintext credential in the database and - since the rest of the object
 * is public in source-registry.ts - a brute-forceable commitment to it,
 * published over HTTP. So the token is read here, in the client, from the
 * environment, and attached as a header. A boundary test now rejects
 * credential-shaped keys in queryParams so this cannot be done the wrong
 * way by accident.
 *
 * TWO TOKENS. NAV publishes a rotating PUBLIC token at an unauthenticated
 * endpoint, which is what this client falls back to and what the live
 * verification used. For production NAV asks operators to request a stable
 * private token by email, confirming in writing that they accept the
 * terms. That token goes in MARKET_NAV_TOKEN and nowhere else. The public
 * token is a real credential in shape if not in secrecy, and is handled
 * identically so the code path is the one that will run in production.
 */

const BASE_URL = 'https://pam-stilling-feed.nav.no/api/v1/feed';

const PUBLIC_TOKEN_URL = 'https://pam-stilling-feed.nav.no/api/publicToken';

const USER_AGENT = 'career-os';

const PAGE_SIZE = 100;

/*
 * The feed is national and not partitioned by the source into slices that
 * can each be read to the end, so it is one scope - the value the schema
 * reserves for a source with no sub-scope.
 */
export const NAV_NO_SCOPES = ['*'];

/*
 * The feed runs from 2019 and is walked oldest-first, so a complete
 * backfill is far more than a routine sync should attempt. Reaching this
 * ceiling records the scope as read but NOT complete, which is the honest
 * description of a partial walk of an archive.
 */
const MAX_PAGES = 20;

const INTER_SCOPE_DELAY_MS = 1_000;

const MAX_ATTEMPTS = 3;

const BACKOFF_MS = [500, 1_500];

const MAX_RETRY_AFTER_MS = 10_000;

export type NavFailure =
  | 'unknown_scope'
  | 'missing_credential'
  | 'rate_limited'
  | 'unavailable'
  | 'network_error'
  | 'unexpected_response';

export class NavRequestError extends Error {
  readonly scope: string;

  readonly status: number | null;

  readonly reason: NavFailure;

  constructor(scope: string, status: number | null, reason: NavFailure) {
    super(`NAV request failed: ${scope} (${reason})`);

    this.name = 'NavRequestError';
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

/**
 * The operator override, by NAME.
 *
 * OPTIONAL, which is why it is not on the descriptor: without it this
 * client fetches NAV's own public token, so an unset variable is the
 * normal case rather than a misconfiguration. Declaring it as a
 * requirement would make the gate refuse a source that works fine.
 */
export const NAV_CREDENTIALS: SourceCredentialRequirement = {
  envKeys: ['MARKET_NAV_TOKEN'],
};

@Injectable()
export class NavClient implements SourceClient {
  /**
   * The PUBLIC token, cached for the life of the process.
   *
   * Only ever the public one. An operator-supplied token is re-read from
   * configuration on each use and never stored here - a client holding a
   * secret is one console.log away from a log file full of them, and
   * caching buys nothing when the read is an object lookup.
   */
  private publicToken: string | null = null;

  constructor(
    @Optional()
    private readonly credentials: MarketSourceCredentials = new MarketSourceCredentials(),
    @Optional()
    private readonly sleep: Sleep = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  readonly interScopeDelayMs = INTER_SCOPE_DELAY_MS;

  readonly maxPagesPerScope = MAX_PAGES;

  /**
   * The bearer token, from configuration if an operator supplied one and
   * otherwise from NAV's own public token endpoint.
   *
   * Cached for the life of the process. The public token rotates on the
   * order of weeks, so a long-lived process could outlive one - a 401 is
   * classified as `unexpected_response` and fails the scope loudly rather
   * than being silently retried with the same dead token, because a
   * credential that has expired is an operator problem and not a
   * transient network one.
   */
  private async bearerToken(scope: string): Promise<string> {
    /*
     * Configuration first, and read through the one service that reads
     * configuration. This used to reach into process.env directly and
     * cache the result on the instance, which was a second credential
     * path beside the shared one - the exact duplication Phase 11's
     * boundary scan now refuses.
     */
    if (this.credentials.state(NAV_CREDENTIALS).kind === 'CONFIGURED') {
      return this.credentials.resolve(NAV_CREDENTIALS).MARKET_NAV_TOKEN.trim();
    }

    if (this.publicToken !== null) {
      return this.publicToken;
    }

    let response: Response;

    try {
      response = await fetch(PUBLIC_TOKEN_URL, {
        headers: { 'User-Agent': USER_AGENT },
      });
    } catch {
      throw new NavRequestError(scope, null, 'network_error');
    }

    if (!response.ok) {
      throw new NavRequestError(scope, response.status, 'missing_credential');
    }

    /*
     * The endpoint returns prose with the token on its own line, not JSON:
     *   "Current public token for Nav Job Vacancy Feed:\n<jwt>"
     * So the JWT is picked out by shape rather than by position, which
     * survives the wording changing.
     */
    const text = await response.text();
    const match = /ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.exec(text);

    if (match === null) {
      throw new NavRequestError(scope, response.status, 'missing_credential');
    }

    this.publicToken = match[0];

    return this.publicToken;
  }

  async fetchScope(scope: string, cursor: string | null): Promise<SourcePage> {
    if (!NAV_NO_SCOPES.includes(scope)) {
      throw new NavRequestError(scope, null, 'unknown_scope');
    }

    const url =
      `${BASE_URL}?size=${PAGE_SIZE}` +
      (cursor === null ? '' : `&last_id=${encodeURIComponent(cursor)}`);

    const body = await this.get(url, scope);

    return { body, nextCursor: this.nextCursor(body) };
  }

  /** The feed's own next_id, or null when it says there is no more. */
  private nextCursor(body: unknown): string | null {
    const envelope = body as { next_id?: unknown; items?: unknown } | null;

    if (!Array.isArray(envelope?.items) || envelope.items.length === 0) {
      return null;
    }

    const next = envelope.next_id;

    return typeof next === 'string' && next.length > 0 ? next : null;
  }

  classifyFailure(error: unknown): string {
    return error instanceof NavRequestError
      ? error.reason
      : 'unexpected_response';
  }

  private async get(url: string, scope: string): Promise<unknown> {
    const token = await this.bearerToken(scope);
    let lastError: NavRequestError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response;

      try {
        response = await fetch(url, {
          headers: {
            Accept: 'application/json',
            'User-Agent': USER_AGENT,
            Authorization: `Bearer ${token}`,
          },
        });
      } catch {
        /*
         * The caught error is never inspected, never attached and never
         * logged. That rule matters more here than anywhere else in the
         * pipeline: this is the one request that carries a credential, and
         * a fetch error can carry the request that produced it.
         */
        lastError = new NavRequestError(scope, null, 'network_error');

        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(BACKOFF_MS[attempt - 1] ?? 0);
          continue;
        }

        throw lastError;
      }

      if (response.status === 429) {
        const wait = retryAfterMs(response.headers.get('retry-after'));

        lastError = new NavRequestError(scope, 429, 'rate_limited');

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
        lastError = new NavRequestError(scope, response.status, 'unavailable');

        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(BACKOFF_MS[attempt - 1] ?? 0);
          continue;
        }

        throw lastError;
      }

      if (!response.ok) {
        throw new NavRequestError(
          scope,
          response.status,
          'unexpected_response',
        );
      }

      try {
        return (await response.json()) as unknown;
      } catch {
        throw new NavRequestError(
          scope,
          response.status,
          'unexpected_response',
        );
      }
    }

    throw lastError ?? new NavRequestError(scope, null, 'unexpected_response');
  }
}
