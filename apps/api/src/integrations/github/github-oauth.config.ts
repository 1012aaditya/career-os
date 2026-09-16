import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/*
 * Configuration for the GitHub OAuth App.
 *
 * The scope is a constant, not a setting. Phase 7 reads public repository
 * data only, and `user:email` is the whole of what that needs: a token
 * with no repository scope already authenticates as its owner, so GET
 * /user returns the id and login we key on. Making it configurable would
 * invite someone to widen it in an environment file, and the scopes that
 * would widen it to - `public_repo` and `repo` - are both read/WRITE
 * grants over the user's code. See docs/external-evidence.
 *
 * The value is sent explicitly on every authorization request. Omitting
 * the parameter does not mean "no scopes": GitHub then grants the set of
 * scopes the user has previously authorized for this application, so a
 * request that asked for nothing can inherit everything they ever
 * approved.
 */
export const GITHUB_OAUTH_SCOPE = 'user:email';

export const GITHUB_AUTHORIZE_URL =
  'https://github.com/login/oauth/authorize';

export const GITHUB_TOKEN_URL =
  'https://github.com/login/oauth/access_token';

export const GITHUB_API_BASE_URL =
  'https://api.github.com';

@Injectable()
export class GithubOAuthConfig {
  readonly clientId: string;

  /*
   * The registered callback. Sent on both the authorization request and
   * the token exchange, and compared against the URL the callback
   * actually arrived on.
   */
  readonly callbackUrl: string;

  /*
   * Where the browser is sent once the callback has finished. Read from
   * configuration and never from the request, so this cannot become an
   * open redirect: there is no input that can steer it.
   */
  readonly mobileRedirectUri: string;

  /*
   * True private field. It is not enumerable, does not appear in
   * Object.keys, and is not reachable by JSON.stringify - so a config
   * object that finds its way into a log line or an error payload cannot
   * carry the client secret with it. toJSON below closes the same hole
   * for the rest of the object.
   */
  readonly #clientSecret: string;

  constructor(config: ConfigService) {
    /*
     * Trimmed at the boundary, before anything validates or stores them.
     *
     * A trailing newline is invisible in a dashboard and survives a
     * copy-paste, and `new URL()` strips one silently - so the value
     * passed every check here and then went out on the wire as
     * `...%2Fcallback%0A`, which GitHub compares byte-for-byte against
     * the registered callback and rejects. The error surfaces on
     * github.com, not in our logs, which is the worst place for it.
     *
     * Environment values are typed by a human into a web form. Treating
     * surrounding whitespace as significant serves nobody, and
     * `redisUrl()` in environment.ts already trims for the same reason.
     */
    const read = (key: string): string | undefined =>
      config.get<string>(key)?.trim();

    const clientId = read('GITHUB_CLIENT_ID');

    const clientSecret = read('GITHUB_CLIENT_SECRET');

    const callbackUrl = read('GITHUB_OAUTH_CALLBACK_URL');

    const mobileRedirectUri = read('GITHUB_OAUTH_MOBILE_REDIRECT_URI');

    if (
      !clientId ||
      !clientSecret ||
      !callbackUrl ||
      !mobileRedirectUri
    ) {
      /*
       * Names only. Whichever value is missing, the message must not be
       * able to quote one that is present.
       */
      throw new Error(
        'GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_OAUTH_CALLBACK_URL and GITHUB_OAUTH_MOBILE_REDIRECT_URI must be configured',
      );
    }

    /*
     * The callback is a URL GitHub will redirect a browser to, so it has
     * to be absolute and https. http is refused rather than warned about:
     * an authorization code in a cleartext redirect is a credential on
     * the wire.
     */
    let parsedCallback: URL;

    try {
      parsedCallback = new URL(callbackUrl);
    } catch {
      throw new Error(
        'GITHUB_OAUTH_CALLBACK_URL must be an absolute URL',
      );
    }

    if (parsedCallback.protocol !== 'https:') {
      /*
       * Localhost is the one place cleartext is legitimate, because the
       * traffic never leaves the machine. GitHub documents loopback
       * redirects for exactly this case.
       */
      const isLoopback =
        parsedCallback.hostname === 'localhost' ||
        parsedCallback.hostname === '127.0.0.1' ||
        parsedCallback.hostname === '[::1]';

      if (
        !isLoopback ||
        parsedCallback.protocol !== 'http:'
      ) {
        throw new Error(
          'GITHUB_OAUTH_CALLBACK_URL must use https, except on loopback',
        );
      }
    }

    let parsedMobile: URL;

    try {
      parsedMobile = new URL(mobileRedirectUri);
    } catch {
      throw new Error(
        'GITHUB_OAUTH_MOBILE_REDIRECT_URI must be an absolute URL',
      );
    }

    /*
     * The mobile redirect must be an application scheme, never one that
     * can address a network origin.
     *
     * This value decides where a browser is sent at the exact moment it
     * is carrying a completed OAuth flow. Left unasserted - as it was
     * until this check - a misconfigured or tampered
     * https://attacker.example would turn our own callback into a 302
     * delivering the user there mid-authorisation: an excellent phishing
     * position, arrived at through configuration rather than through any
     * flaw in the flow itself.
     *
     * A custom scheme cannot reach a remote origin, so rejecting the web
     * schemes closes the threat completely. An exact match against the
     * app's own scheme was considered and rejected: it would couple this
     * service to a single bundle identifier - breaking any staging build
     * - while adding no security, because an attacker who can already
     * rewrite this variable to someapp:// gains nothing from a link that
     * carries only a status.
     */
    const NETWORK_SCHEMES = new Set([
      'http:',
      'https:',
      'ws:',
      'wss:',
      'ftp:',
      'file:',
    ]);

    if (
      NETWORK_SCHEMES.has(parsedMobile.protocol)
    ) {
      throw new Error(
        'GITHUB_OAUTH_MOBILE_REDIRECT_URI must use the application scheme, not a web scheme',
      );
    }

    this.clientId = clientId;
    this.#clientSecret = clientSecret;
    this.callbackUrl = callbackUrl;
    this.mobileRedirectUri = mobileRedirectUri;
  }

  /*
   * Deliberately a method rather than a property. A property is reachable
   * by anything that walks the object - a logger, a serializer, an error
   * reporter capturing scope - whereas a call site is greppable and has
   * to be written on purpose.
   */
  clientSecret(): string {
    return this.#clientSecret;
  }

  /*
   * Basic credentials for the OAuth application endpoints, which
   * authenticate with the client id as username and the secret as
   * password rather than with a bearer token.
   */
  basicAuthorizationHeader(): string {
    const encoded = Buffer.from(
      `${this.clientId}:${this.#clientSecret}`,
      'utf8',
    ).toString('base64');

    return `Basic ${encoded}`;
  }

  /*
   * Anything that serializes this object gets the redacted form. Without
   * it, `logger.info({ config })` is a secret disclosure.
   */
  toJSON() {
    return {
      clientId: this.clientId,
      callbackUrl: this.callbackUrl,
      mobileRedirectUri: this.mobileRedirectUri,
      clientSecret: '[redacted]',
    };
  }
}
