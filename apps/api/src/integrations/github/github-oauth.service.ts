import { Injectable, Optional } from '@nestjs/common';

import { OAuthStateService } from '../oauth/oauth-state.service.js';

import { StructuredLogger } from '../../observability/structured-logger.js';

import {
  GithubApiClient,
  GithubApiError,
} from './github-api.client.js';
import {
  GithubAccountAlreadyLinkedError,
  GithubConnectionService,
} from './github-connection.service.js';
import {
  GITHUB_AUTHORIZE_URL,
  GITHUB_OAUTH_SCOPE,
  GithubOAuthConfig,
} from './github-oauth.config.js';

const PROVIDER = 'GITHUB' as const;

/*
 * The reasons a connection attempt can end.
 *
 * A closed set, because these values travel to the client in a redirect
 * URL. Anything derived from a GitHub response or an exception message
 * could carry detail we did not intend to publish, so nothing does: the
 * callback maps every outcome onto one of these constants.
 */
export type CallbackOutcome =
  | 'success'
  | 'access_denied'
  | 'invalid_state'
  | 'exchange_failed'
  /*
   * Distinguished from exchange_failed because it is the one exchange
   * failure the user can act on: GitHub refuses to issue a token when the
   * account's primary email is unverified. Collapsing it into a generic
   * error would tell someone to retry a flow that cannot succeed until
   * they verify their email at GitHub.
   */
  | 'unverified_email'
  | 'account_unavailable'
  | 'account_already_linked'
  | 'server_error';

export type AuthorizationRequestResult = {
  authorizationUrl: string;
  expiresAt: Date;
};

@Injectable()
export class GithubOAuthService {

  constructor(
    private readonly config: GithubOAuthConfig,
    private readonly state: OAuthStateService,
    private readonly api: GithubApiClient,
    private readonly connections: GithubConnectionService,
    /*
     * Optional with a default, matching the pattern the source clients
     * already use for their injected sleep and credentials. The container
     * supplies the shared singleton; the default exists so the Phase 7
     * specs, which construct these services directly with a fixed
     * argument list, keep working without being rewritten for a
     * diagnostics change.
     */
    @Optional()
    private readonly structured: StructuredLogger = new StructuredLogger(),
  ) {}

  /**
   * Builds the URL the user is sent to, and records the pending request
   * that the callback will be matched against.
   */
  async createAuthorizationRequest(
    userId: string,
  ): Promise<AuthorizationRequestResult> {
    const pending = await this.state.create(
      userId,
      PROVIDER,
      this.config.callbackUrl,
      GITHUB_OAUTH_SCOPE,
    );

    const url = new URL(GITHUB_AUTHORIZE_URL);

    url.searchParams.set(
      'client_id',
      this.config.clientId,
    );
    url.searchParams.set(
      'redirect_uri',
      this.config.callbackUrl,
    );
    /*
     * Always sent, never omitted. Omitting `scope` does not request
     * nothing - GitHub grants whatever this user has previously
     * authorized for the application, so a silent request can inherit a
     * broader grant from an earlier one.
     */
    url.searchParams.set(
      'scope',
      GITHUB_OAUTH_SCOPE,
    );
    url.searchParams.set(
      'state',
      pending.state,
    );
    url.searchParams.set(
      'code_challenge',
      pending.codeChallenge,
    );
    url.searchParams.set(
      'code_challenge_method',
      pending.codeChallengeMethod,
    );

    return {
      authorizationUrl: url.toString(),
      expiresAt: pending.expiresAt,
    };
  }

  /**
   * Handles GitHub's redirect back.
   *
   * Note what this method does NOT take: any notion of "the current
   * user". It cannot, and that is the design. The owning user comes from
   * the consumed authorization request, so an attacker who replays their
   * own callback URL against a logged-in victim binds the account to
   * themselves - the identity the state carries - rather than to whoever
   * happened to issue the request.
   */
  async handleCallback(params: {
    code?: string;
    state?: string;
    error?: string;
  }): Promise<CallbackOutcome> {
    /*
     * The user declined at GitHub, or GitHub refused. Handled before the
     * state is consumed so a decline does not burn the pending request -
     * though in practice the user restarts the flow anyway.
     */
    if (params.error) {
      return 'access_denied';
    }

    if (!params.state || !params.code) {
      return 'invalid_state';
    }

    const consumed = await this.state.consume(
      PROVIDER,
      params.state,
    );

    /*
     * One branch for every state failure: unknown, expired, already
     * consumed, or a verifier that would not decrypt. The caller cannot
     * tell them apart, so a replayed callback and a forged one look
     * identical from outside.
     */
    if (!consumed) {
      return 'invalid_state';
    }

    let grant;

    try {
      grant = await this.api.exchangeCode(
        params.code,
        consumed.codeVerifier,
        consumed.redirectUri,
      );
    } catch (error) {
      this.logFailure(
        'token_exchange',
        consumed.userId,
        error,
      );

      if (
        error instanceof GithubApiError &&
        error.code === 'unverified_user_email'
      ) {
        return 'unverified_email';
      }

      return 'exchange_failed';
    }

    let account;

    try {
      account =
        await this.api.fetchAuthenticatedAccount(
          grant.accessToken,
        );
    } catch (error) {
      this.logFailure(
        'fetch_account',
        consumed.userId,
        error,
      );

      return 'account_unavailable';
    }

    try {
      await this.connections.upsertConnection({
        /*
         * The authoritative binding. Read from the row, never from the
         * request.
         */
        userId: consumed.userId,
        accountId: account.id,
        login: account.login,
        accessToken: grant.accessToken,
        grantedScopes: grant.grantedScopes,
      });
    } catch (error) {
      if (
        error instanceof
        GithubAccountAlreadyLinkedError
      ) {
        return 'account_already_linked';
      }

      this.logFailure(
        'persist_connection',
        consumed.userId,
        error,
      );

      return 'server_error';
    }

    return 'success';
  }

  /**
   * The URL the browser is sent to once the callback is done.
   *
   * Carries a status and nothing else. No access token, no authorization
   * code, no state, no PKCE verifier - a deep link is visible to the
   * operating system, can be logged by it, and on a custom scheme can be
   * claimed by another application. The app treats this as a hint and
   * re-reads the real state from GET /github/status under its own
   * authentication.
   *
   * The base is configuration, so there is no input that could redirect
   * this somewhere else.
   */
  buildRedirectUrl(
    outcome: CallbackOutcome,
  ): string {
    const url = new URL(
      this.config.mobileRedirectUri,
    );

    url.searchParams.set(
      'status',
      outcome === 'success'
        ? 'success'
        : 'error',
    );

    if (outcome !== 'success') {
      url.searchParams.set('reason', outcome);
    }

    return url.toString();
  }

  /*
   * Logs the shape of a failure and never the failure itself. Passing the
   * caught error to the logger is the single most common way a token
   * reaches a log file, because HTTP clients attach the request - and its
   * Authorization header - to the error they reject with.
   */
  private logFailure(
    operation: string,
    userId: string,
    error: unknown,
  ) {
    const detail =
      error instanceof GithubApiError
        ? `status=${
            error.status ?? 'none'
          } code=${error.code ?? 'none'}`
        : 'unexpected_error';

    /*
     * The user id used to be interpolated here in plain text. Replaced in
     * PR-5 by a stable pseudonym: still enough to see one person failing
     * repeatedly, without the log carrying the key to their data.
     */
    this.structured.event('warn', 'github.oauth.failed', {
      actor: this.structured.actor(userId),
      provider: 'github',
      operation,
      errorCode: detail,
      errorCategory: 'dependency',
    });
  }
}
