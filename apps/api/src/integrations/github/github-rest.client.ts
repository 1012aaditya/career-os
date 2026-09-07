import {
  Injectable,
  Optional,
} from '@nestjs/common';

import { GITHUB_API_BASE_URL } from './github-oauth.config.js';

/*
 * The ingestion HTTP layer.
 *
 * Separate from GithubApiClient rather than bolted onto it. That client
 * serves the OAuth lifecycle: three one-shot calls, no pagination, no
 * retries, and it is frozen. Ingestion needs the opposite - paginated
 * walks, conditional requests, rate-limit awareness and bounded retry -
 * and mixing the two would give the connection flow a retry policy it has
 * no use for.
 *
 * This layer knows nothing about repositories. It returns parsed JSON and
 * the metadata needed to walk and cache it; deciding what any of it MEANS
 * belongs to the parsing and observation layers.
 *
 * Nothing here logs, and no failure carries a request. Every error is a
 * GithubRequestError holding a status, an operation and a reason - because
 * the way tokens reach log files is an HTTP client attaching the request,
 * Authorization header included, to the error it rejects with.
 */

const API_VERSION = '2026-03-10';

const USER_AGENT = 'career-os';

/* GitHub's documented maximum for most paginated endpoints. */
const MAX_PER_PAGE = 100;

/*
 * A ceiling, so this can never become an unbounded crawler. At 100 per
 * page this admits 1,000 repositories, which is far beyond any plausible
 * individual account; anything past it is reported as truncated rather
 * than silently dropped.
 */
const DEFAULT_MAX_PAGES = 10;

/*
 * Transient failures are retried a bounded number of times and then give
 * up. Retrying forever converts a GitHub outage into an infinite loop
 * holding a database row open.
 */
const MAX_ATTEMPTS = 3;

/*
 * The longest this will sit waiting on a Retry-After before giving up and
 * letting the caller record a partial run. A primary rate-limit reset can
 * be most of an hour away; blocking a request for that long is worse than
 * reporting PARTIAL and trying again later.
 */
const MAX_RETRY_AFTER_MS = 10_000;

export type GithubRequestFailure =
  | 'rate_limited'
  | 'access_lost'
  /*
   * 409 on the commits endpoint. Documented as a status but with no
   * documented body, so it is matched on the code alone. It is NOT an
   * error condition: a repository with no commits legitimately has none,
   * and the caller records zero rather than "not scanned".
   */
  | 'empty_repository'
  | 'unavailable'
  | 'network_error'
  | 'unexpected_response'
  | 'bad_credentials'
  | 'forbidden';

export class GithubRequestError extends Error {
  readonly operation: string;

  readonly status: number | null;

  readonly reason: GithubRequestFailure;

  /** Epoch ms when the rate limit resets, when GitHub said so. */
  readonly resetAt: number | null;

  constructor(
    operation: string,
    status: number | null,
    reason: GithubRequestFailure,
    resetAt: number | null = null,
  ) {
    super(
      `GitHub request failed: ${operation} (${reason})`,
    );

    this.name = 'GithubRequestError';
    this.operation = operation;
    this.status = status;
    this.reason = reason;
    this.resetAt = resetAt;
  }
}

export type ConditionalResponse =
  | {
      status: 'ok';
      body: unknown;
      etag: string | null;
      linkNext: string | null;
    }
  | { status: 'not_modified'; etag: string | null };

export type PaginatedResult = {
  items: unknown[];
  /** A page ceiling was reached, so the list is incomplete. */
  truncated: boolean;
  pagesFetched: number;
};

export type RequestOptions = {
  accessToken: string;
  /** Sent as If-None-Match; a 304 then costs nothing against the limit. */
  etag?: string | null;
  operation: string;
};

type Sleep = (ms: number) => Promise<void>;

/*
 * Parses the Link header for rel="next".
 *
 * GitHub is explicit that a client should follow this rather than
 * incrementing `page` itself: not every relation appears in every
 * response, and `last` can be absent entirely when the total is not
 * calculable.
 */
export function parseLinkNext(
  header: string | null,
): string | null {
  if (!header) {
    return null;
  }

  for (const part of header.split(',')) {
    const match = part.match(
      /<([^>]+)>\s*;\s*rel="([^"]+)"/,
    );

    if (match && match[2] === 'next') {
      return match[1] ?? null;
    }
  }

  return null;
}

@Injectable()
export class GithubRestClient {
  /*
   * Injected so tests exercise the real backoff decisions without
   * actually waiting. A test that slept would be slow enough that
   * somebody would eventually delete it.
   */
  constructor(
    /*
     * Nest reads the emitted paramtype for this argument and finds
     * `Function` - Sleep is a type alias, not an injectable class - so
     * without @Optional it looks for a provider under that token and the
     * whole application fails to bootstrap. Optional makes it pass
     * undefined instead, which is what lets the default below apply.
     */
    @Optional()
    private readonly sleep: Sleep = (ms) =>
      new Promise((resolve) =>
        setTimeout(resolve, ms),
      ),
  ) {}

  /**
   * One GET, with conditional-request support and bounded retry.
   *
   * `path` may be an absolute URL, so a `rel="next"` link can be followed
   * verbatim instead of being reassembled from parts.
   */
  async get(
    path: string,
    options: RequestOptions,
  ): Promise<ConditionalResponse> {
    const url = path.startsWith('http')
      ? path
      : `${GITHUB_API_BASE_URL}${path}`;

    let lastError: GithubRequestError | null =
      null;

    for (
      let attempt = 1;
      attempt <= MAX_ATTEMPTS;
      attempt += 1
    ) {
      let response: Response;

      const headers: Record<string, string> = {
        Authorization: `Bearer ${options.accessToken}`,
        Accept: 'application/vnd.github+json',
        /*
         * Pinned. Omitting this does not mean "latest" - GitHub defaults
         * the request to an older version with a published end-of-support
         * date, after which omitting it starts returning 410.
         */
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': USER_AGENT,
      };

      if (options.etag) {
        headers['If-None-Match'] = options.etag;
      }

      try {
        response = await fetch(url, { headers });
      } catch {
        /*
         * Discarded rather than wrapped: a fetch failure carries the
         * request, and the request carries the token.
         */
        lastError = new GithubRequestError(
          options.operation,
          null,
          'network_error',
        );

        await this.backoff(attempt);
        continue;
      }

      /*
       * Unchanged since the stored ETag. GitHub documents that a 304 does
       * not count against the primary rate limit, which is what makes
       * re-syncing cheap.
       */
      if (response.status === 304) {
        return {
          status: 'not_modified',
          etag:
            response.headers.get('etag') ??
            options.etag ??
            null,
        };
      }

      if (response.ok) {
        let body: unknown;

        try {
          body = await response.json();
        } catch {
          throw new GithubRequestError(
            options.operation,
            response.status,
            'unexpected_response',
          );
        }

        return {
          status: 'ok',
          body,
          etag: response.headers.get('etag'),
          linkNext: parseLinkNext(
            response.headers.get('link'),
          ),
        };
      }

      const failure = this.classify(
        response,
        options.operation,
      );

      /*
       * A dead token, a lost repository and a scope problem are all
       * final. Retrying them wastes budget and, for 401, keeps presenting
       * a credential that GitHub has already rejected.
       */
      if (
        failure.reason !== 'unavailable' &&
        failure.reason !== 'rate_limited'
      ) {
        throw failure;
      }

      if (failure.reason === 'rate_limited') {
        const waitMs = this.retryDelayMs(
          response,
        );

        /*
         * Only a short wait is absorbed here. A primary-limit reset can
         * be most of an hour away, and the right answer then is to stop
         * and record a partial run rather than hold everything open.
         */
        if (
          waitMs === null ||
          waitMs > MAX_RETRY_AFTER_MS
        ) {
          throw failure;
        }

        lastError = failure;
        await this.sleep(waitMs);
        continue;
      }

      lastError = failure;
      await this.backoff(attempt);
    }

    /* Attempts exhausted. */
    throw (
      lastError ??
      new GithubRequestError(
        options.operation,
        null,
        'unavailable',
      )
    );
  }

  /**
   * Walks a paginated collection, following rel="next".
   *
   * Bounded by maxPages. When the ceiling is reached with a next link
   * still present, the result is marked truncated - the caller must
   * surface that rather than treating a short list as a complete one.
   */
  async getAll(
    path: string,
    options: RequestOptions & {
      maxPages?: number;
      perPage?: number;
    },
  ): Promise<PaginatedResult> {
    const perPage = Math.min(
      options.perPage ?? MAX_PER_PAGE,
      MAX_PER_PAGE,
    );

    const maxPages =
      options.maxPages ?? DEFAULT_MAX_PAGES;

    const first = new URL(
      path.startsWith('http')
        ? path
        : `${GITHUB_API_BASE_URL}${path}`,
    );

    first.searchParams.set(
      'per_page',
      String(perPage),
    );

    const items: unknown[] = [];

    let next: string | null = first.toString();
    let pagesFetched = 0;

    /*
     * Sequential by construction. GitHub's own guidance is to make
     * requests serially rather than concurrently, and the secondary limit
     * caps concurrency across the whole API - a Promise.all over pages
     * would trip it.
     */
    while (next && pagesFetched < maxPages) {
      const response: ConditionalResponse =
        await this.get(next, {
          accessToken: options.accessToken,
          operation: options.operation,
        });

      pagesFetched += 1;

      if (response.status === 'not_modified') {
        break;
      }

      if (!Array.isArray(response.body)) {
        throw new GithubRequestError(
          options.operation,
          200,
          'unexpected_response',
        );
      }

      items.push(...response.body);
      next = response.linkNext;
    }

    return {
      items,
      truncated: next !== null,
      pagesFetched,
    };
  }

  private classify(
    response: Response,
    operation: string,
  ): GithubRequestError {
    const status = response.status;

    const resetAt = this.resetAtMs(response);

    if (status === 401) {
      return new GithubRequestError(
        operation,
        status,
        'bad_credentials',
      );
    }

    /*
     * 404 rather than 403 is what GitHub returns for something the token
     * cannot see, deliberately, so that the API does not confirm whether
     * a private resource exists. For us it means access was lost - the
     * observation is retained and marked, never deleted.
     */
    /*
     * 404 rather than 403 is deliberate on GitHub's side, so the API does
     * not confirm whether a private resource exists. It means the same
     * thing to us either way: no longer readable. 451 is a legal block -
     * permanent, and never retried.
     *
     * Neither is treated as "gone": the observation captured earlier was
     * true when it was captured, and is retained and marked stale.
     */
    if (status === 404 || status === 451) {
      return new GithubRequestError(
        operation,
        status,
        'access_lost',
      );
    }

    if (status === 409) {
      return new GithubRequestError(
        operation,
        status,
        'empty_repository',
      );
    }

    if (status === 429) {
      return new GithubRequestError(
        operation,
        status,
        'rate_limited',
        resetAt,
      );
    }

    if (status === 403) {
      /*
       * 403 is overloaded. It is a rate limit only when GitHub says the
       * remaining budget is zero or supplies a Retry-After; otherwise it
       * is a permissions problem, and treating that as a rate limit would
       * make the client wait and retry something that can never succeed.
       */
      const remaining = response.headers.get(
        'x-ratelimit-remaining',
      );

      const isRateLimit =
        remaining === '0' ||
        response.headers.get('retry-after') !==
          null;

      return new GithubRequestError(
        operation,
        status,
        isRateLimit
          ? 'rate_limited'
          : 'forbidden',
        isRateLimit ? resetAt : null,
      );
    }

    if (status >= 500) {
      return new GithubRequestError(
        operation,
        status,
        'unavailable',
      );
    }

    return new GithubRequestError(
      operation,
      status,
      'unexpected_response',
    );
  }

  private resetAtMs(
    response: Response,
  ): number | null {
    const reset = response.headers.get(
      'x-ratelimit-reset',
    );

    if (!reset) {
      return null;
    }

    const seconds = Number(reset);

    return Number.isFinite(seconds)
      ? seconds * 1000
      : null;
  }

  /*
   * Retry-After takes precedence over the reset header, which is the
   * order GitHub documents: honour Retry-After first, then wait for
   * x-ratelimit-reset when the remaining budget is zero.
   */
  private retryDelayMs(
    response: Response,
  ): number | null {
    const retryAfter = response.headers.get(
      'retry-after',
    );

    if (retryAfter !== null) {
      const seconds = Number(retryAfter);

      if (Number.isFinite(seconds)) {
        return Math.max(0, seconds * 1000);
      }
    }

    const resetAt = this.resetAtMs(response);

    if (resetAt !== null) {
      return Math.max(0, resetAt - Date.now());
    }

    return null;
  }

  private async backoff(attempt: number) {
    /* 200ms, 400ms. Bounded by MAX_ATTEMPTS above. */
    await this.sleep(200 * 2 ** (attempt - 1));
  }
}
