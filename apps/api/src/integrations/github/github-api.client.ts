import { Injectable } from '@nestjs/common';

import {
  GITHUB_API_BASE_URL,
  GITHUB_TOKEN_URL,
  GithubOAuthConfig,
} from './github-oauth.config.js';

/*
 * Every call to GitHub goes through this class, and nothing outside it
 * touches a token-bearing request or response.
 *
 * That single-entry rule exists because of how tokens actually leak. It is
 * almost never someone printing one on purpose. It is `logger.error(err)`
 * on an error object from an HTTP client, because clients attach the
 * request configuration - including the Authorization header - to the
 * error they reject with, and every structured logger and error reporter
 * walks that object. So no raw failure is allowed to escape: each one is
 * caught and replaced with a GithubApiError carrying a status, an
 * operation name and, where GitHub supplies one, a documented error code.
 * No headers, no bodies, no request objects, no cause chain.
 */

const API_VERSION = '2026-03-10';

/*
 * GitHub rejects API requests that arrive without a User-Agent.
 */
const USER_AGENT = 'career-os';

/*
 * Documented OAuth error codes. Only these are ever surfaced. Anything
 * else collapses to 'unknown_error' rather than being echoed back, so a
 * response body can never carry an unexpected value out of this class.
 */
const KNOWN_OAUTH_ERRORS = new Set([
  /*
   * The four GitHub documents for the OAuth App web flow.
   *
   * unverified_user_email is the surprising one: the TOKEN EXCHANGE
   * itself fails when the account's primary email is unverified. It is
   * not a soft empty result later on, and it is user-actionable, so it
   * gets its own outcome rather than collapsing into a generic failure.
   */
  'bad_verification_code',
  'incorrect_client_credentials',
  'redirect_uri_mismatch',
  'unverified_user_email',
  /* Documented on the authorization step rather than the exchange. */
  'access_denied',
  'application_suspended',
]);

export class GithubApiError extends Error {
  readonly operation: string;

  readonly status: number | null;

  readonly code: string | null;

  constructor(
    operation: string,
    status: number | null,
    code: string | null,
  ) {
    super(
      `GitHub request failed: ${operation}${
        code ? ` (${code})` : ''
      }`,
    );

    this.name = 'GithubApiError';
    this.operation = operation;
    this.status = status;
    this.code = code;
  }
}

export type GithubTokenGrant = {
  accessToken: string;
  /** What GitHub ACTUALLY granted, which can differ from what was asked. */
  grantedScopes: string[];
  tokenType: string | null;
};

export type GithubAccount = {
  /** Immutable numeric account id. The only safe join key. */
  id: string;
  /** Mutable, and reusable by someone else once released. Display only. */
  login: string;
};

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function readOAuthErrorCode(
  body: Record<string, unknown>,
): string | null {
  const error = body['error'];

  if (typeof error !== 'string') {
    return null;
  }

  return KNOWN_OAUTH_ERRORS.has(error)
    ? error
    : 'unknown_error';
}

@Injectable()
export class GithubApiClient {
  constructor(
    private readonly config: GithubOAuthConfig,
  ) {}

  /**
   * Exchanges an authorization code for an access token.
   *
   * Runs server-side because it has to: GitHub requires client_secret on
   * this endpoint even when PKCE is used, so there is no public-client
   * variant of this flow to move onto the device.
   */
  async exchangeCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<GithubTokenGrant> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret(),
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });

    let response: Response;

    try {
      response = await fetch(GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: {
          /*
           * Without this GitHub answers in
           * application/x-www-form-urlencoded, and a JSON parse of that
           * yields nothing useful. The failure is quiet - a token that
           * reads as undefined rather than an error - so the header is
           * load-bearing.
           */
          Accept: 'application/json',
          'Content-Type':
            'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
        body: body.toString(),
      });
    } catch {
      /*
       * The network error is discarded rather than wrapped: it holds the
       * request, and the request body holds the client secret and the
       * authorization code.
       */
      throw new GithubApiError(
        'token_exchange',
        null,
        'network_error',
      );
    }

    const parsed = await this.readJson(
      response,
      'token_exchange',
    );

    /*
     * GitHub answers OAuth failures with HTTP 200 and an error body, so
     * checking response.ok is not enough. An implementation that only
     * checks the status reads `access_token: undefined` as success and
     * stores an empty credential.
     */
    const oauthError = readOAuthErrorCode(parsed);

    if (oauthError) {
      throw new GithubApiError(
        'token_exchange',
        response.status,
        oauthError,
      );
    }

    if (!response.ok) {
      throw new GithubApiError(
        'token_exchange',
        response.status,
        null,
      );
    }

    const accessToken = parsed['access_token'];

    if (
      typeof accessToken !== 'string' ||
      accessToken.length === 0
    ) {
      throw new GithubApiError(
        'token_exchange',
        response.status,
        'missing_access_token',
      );
    }

    const scope = parsed['scope'];

    const tokenType = parsed['token_type'];

    return {
      accessToken,
      /*
       * The request sends scopes space-delimited; the response returns
       * them COMMA-delimited ("repo,gist"). The asymmetry is documented
       * and easy to get wrong - splitting the response on whitespace
       * yields one bogus scope string rather than a list, and the granted
       * scope is what later phases check before calling an endpoint.
       * Both separators are accepted so neither reading can break it.
       */
      grantedScopes:
        typeof scope === 'string'
          ? scope
              .split(/[\s,]+/)
              .filter((entry) => entry.length > 0)
          : [],
      tokenType:
        typeof tokenType === 'string'
          ? tokenType
          : null,
    };
  }

  /**
   * Identifies the account a token belongs to.
   *
   * A token with no repository scope still authenticates as its owner, so
   * this returns the public user response - which carries the id and login
   * that are the whole of what Phase 7.2 needs.
   */
  async fetchAuthenticatedAccount(
    accessToken: string,
  ): Promise<GithubAccount> {
    const response = await this.authorizedGet(
      '/user',
      accessToken,
      'fetch_account',
    );

    const id = response['id'];
    const login = response['login'];

    /*
     * The id is numeric in GitHub's response and stored as text, so that
     * the column can serve a provider whose ids are not numbers. It is
     * converted here rather than at the call site so there is one place
     * where the representation is decided.
     */
    /*
     * GitHub types the account id as int64. JSON.parse gives a double, so
     * an id beyond 2^53 would arrive already rounded - isSafeInteger turns
     * that into a visible failure instead of a silently wrong identity,
     * which for the column we key every connection on is the difference
     * between an error and a cross-account mix-up.
     */
    if (
      typeof id !== 'number' ||
      !Number.isSafeInteger(id) ||
      typeof login !== 'string' ||
      login.length === 0
    ) {
      throw new GithubApiError(
        'fetch_account',
        200,
        'unexpected_account_payload',
      );
    }

    return { id: String(id), login };
  }

  /**
   * Revokes the whole grant for this user.
   *
   * The grant endpoint rather than the token endpoint, because that is
   * what a user means by "disconnect": the application disappears from
   * their GitHub authorized-applications list. Revoking only the token
   * leaves us listed there, looking connected.
   */
  async revokeGrant(
    accessToken: string,
  ): Promise<void> {
    let response: Response;

    try {
      response = await fetch(
        `${GITHUB_API_BASE_URL}/applications/${encodeURIComponent(
          this.config.clientId,
        )}/grant`,
        {
          method: 'DELETE',
          headers: {
            /*
             * The application endpoints authenticate with the client id
             * as username and the secret as password, not with the user's
             * token. The token being revoked travels in the body.
             */
            Authorization:
              this.config.basicAuthorizationHeader(),
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': API_VERSION,
            'User-Agent': USER_AGENT,
          },
          body: JSON.stringify({
            access_token: accessToken,
          }),
        },
      );
    } catch {
      throw new GithubApiError(
        'revoke_grant',
        null,
        'network_error',
      );
    }

    /*
     * 204 is the documented success. 404 is treated as success too: it
     * means GitHub has no such grant, which is the state we were trying to
     * reach - though note GitHub documents 404 only for the check and
     * reset endpoints, not for this one, so it is defensive rather than
     * contractual.
     *
     * 422 is deliberately NOT treated as success. GitHub documents it as
     * "validation failed, or the endpoint has been spammed", which is not
     * evidence the grant is gone. Reporting it as revoked would be a claim
     * we cannot support - and the caller destroys the local credential
     * regardless, so nothing is lost by being honest about it.
     */
    if (
      response.status === 204 ||
      response.status === 404
    ) {
      return;
    }

    throw new GithubApiError(
      'revoke_grant',
      response.status,
      null,
    );
  }

  private async authorizedGet(
    path: string,
    accessToken: string,
    operation: string,
  ): Promise<Record<string, unknown>> {
    let response: Response;

    try {
      response = await fetch(
        `${GITHUB_API_BASE_URL}${path}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github+json',
            /*
             * Pinned explicitly. Omitting this header does not mean
             * "latest" - GitHub defaults the request to 2022-11-28, which
             * has a published end-of-support date, after which omitting it
             * starts returning 410 Gone.
             */
            'X-GitHub-Api-Version': API_VERSION,
            'User-Agent': USER_AGENT,
          },
        },
      );
    } catch {
      throw new GithubApiError(
        operation,
        null,
        'network_error',
      );
    }

    if (!response.ok) {
      /*
       * 401 is the one status worth naming: it means the token is dead,
       * and the caller has to distinguish that from a rate limit or a
       * scope problem, which must not invalidate a connection.
       */
      throw new GithubApiError(
        operation,
        response.status,
        response.status === 401
          ? 'bad_credentials'
          : null,
      );
    }

    return this.readJson(response, operation);
  }

  private async readJson(
    response: Response,
    operation: string,
  ): Promise<Record<string, unknown>> {
    let parsed: unknown;

    try {
      parsed = await response.json();
    } catch {
      throw new GithubApiError(
        operation,
        response.status,
        'unparseable_response',
      );
    }

    if (!isRecord(parsed)) {
      throw new GithubApiError(
        operation,
        response.status,
        'unexpected_response_shape',
      );
    }

    return parsed;
  }
}
