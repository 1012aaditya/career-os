import {
  stubConfig,
  TEST_GITHUB_CONFIG,
} from '../test-doubles.js';

import { GithubOAuthConfig } from './github-oauth.config.js';

/*
 * The configuration boundary, and specifically the one value that decides
 * where a browser is sent while it is carrying a completed OAuth flow.
 *
 * Until the 7.8 audit the mobile redirect was checked only for being a
 * parseable URL, while the GitHub-facing callback was held to https. That
 * asymmetry meant a misconfigured or tampered https://attacker.example
 * would turn our own callback into a 302 delivering the user there
 * mid-authorisation - a phishing position reached through configuration
 * rather than through any flaw in the flow.
 */

const build = (
  overrides: Record<string, string>,
) =>
  new GithubOAuthConfig(
    stubConfig({
      ...TEST_GITHUB_CONFIG,
      ...overrides,
    }),
  );

describe('GithubOAuthConfig', () => {
  /*
   * Surrounding whitespace, and why it is not cosmetic.
   *
   * A trailing newline reached production through a dashboard paste. It
   * survived every check here, because `new URL()` strips one before
   * parsing - and then went to GitHub as `...%2Fcallback%0A`, which does
   * not byte-match the registered callback. GitHub refused the
   * authorisation on its own error page, so nothing in our logs said why.
   *
   * The stored value must therefore be the trimmed one, not merely a
   * value that parses once trimmed.
   */
  describe('whitespace around configured values', () => {
    it('is stripped from the callback url', () => {
      const config = build({
        GITHUB_OAUTH_CALLBACK_URL: `  ${TEST_GITHUB_CONFIG.GITHUB_OAUTH_CALLBACK_URL}\n\n`,
      });

      expect(config.callbackUrl).toBe(
        TEST_GITHUB_CONFIG.GITHUB_OAUTH_CALLBACK_URL,
      );
      expect(config.callbackUrl).not.toMatch(/\s/);
    });

    it('is stripped from the mobile redirect uri', () => {
      const config = build({
        GITHUB_OAUTH_MOBILE_REDIRECT_URI: `\n${TEST_GITHUB_CONFIG.GITHUB_OAUTH_MOBILE_REDIRECT_URI}  `,
      });

      expect(config.mobileRedirectUri).toBe(
        TEST_GITHUB_CONFIG.GITHUB_OAUTH_MOBILE_REDIRECT_URI,
      );
    });

    /*
     * The credentials matter just as much: a newline on the client id
     * goes into the authorize URL, and one on the secret goes into an
     * Authorization header, where it is both wrong and a header-injection
     * shape.
     */
    it('is stripped from the client id and secret', () => {
      const config = build({
        GITHUB_CLIENT_ID: `${TEST_GITHUB_CONFIG.GITHUB_CLIENT_ID}\n`,
        GITHUB_CLIENT_SECRET: ` ${TEST_GITHUB_CONFIG.GITHUB_CLIENT_SECRET}\n`,
      });

      expect(config.clientId).toBe(TEST_GITHUB_CONFIG.GITHUB_CLIENT_ID);
      expect(config.clientSecret()).toBe(
        TEST_GITHUB_CONFIG.GITHUB_CLIENT_SECRET,
      );
      expect(config.basicAuthorizationHeader()).not.toMatch(/\s$/);
    });

    /*
     * Trimming must not become a way to configure nothing. A value that
     * is only whitespace is absent, and absent already throws.
     */
    it('does not turn a whitespace-only value into a configured one', () => {
      expect(() =>
        build({ GITHUB_OAUTH_CALLBACK_URL: '   \n  ' }),
      ).toThrow(/must be configured/);
    });
  });

  it('accepts the application scheme', () => {
    expect(() => build({})).not.toThrow();

    expect(
      build({}).mobileRedirectUri,
    ).toBe(
      TEST_GITHUB_CONFIG.GITHUB_OAUTH_MOBILE_REDIRECT_URI,
    );
  });

  /*
   * The attack this exists to stop. Each of these can address a remote
   * origin, so any of them turns the callback into an open redirect at
   * the worst possible moment.
   */
  it.each([
    'https://attacker.example/callback',
    'http://attacker.example/callback',
    'ws://attacker.example',
    'wss://attacker.example',
    'ftp://attacker.example',
    'file:///etc/passwd',
  ])(
    'refuses a web scheme: %s',
    (uri) => {
      expect(() =>
        build({
          GITHUB_OAUTH_MOBILE_REDIRECT_URI: uri,
        }),
      ).toThrow(
        /must use the application scheme/,
      );
    },
  );

  it('still refuses a value that is not an absolute URL', () => {
    expect(() =>
      build({
        GITHUB_OAUTH_MOBILE_REDIRECT_URI:
          '/github/callback',
      }),
    ).toThrow(/must be an absolute URL/);
  });

  /*
   * The refusal happens at construction, so a deployment configured this
   * way fails to boot rather than running and redirecting users to the
   * wrong place. Failing closed is the whole point: a misconfiguration
   * that starts successfully is one nobody notices.
   */
  it('refuses at construction rather than at request time', () => {
    expect(() =>
      build({
        GITHUB_OAUTH_MOBILE_REDIRECT_URI:
          'https://attacker.example',
      }),
    ).toThrow();
  });

  /*
   * The GitHub-facing callback keeps its own, stricter rule - it is a URL
   * GitHub redirects a browser to with an authorization code attached.
   */
  it('still requires https on the GitHub-facing callback', () => {
    expect(() =>
      build({
        GITHUB_OAUTH_CALLBACK_URL:
          'http://api.example.com/v1/github/callback',
      }),
    ).toThrow(/must use https/);
  });

  it('never exposes the client secret when serialized', () => {
    const serialized = JSON.stringify(build({}));

    expect(serialized).not.toContain(
      TEST_GITHUB_CONFIG.GITHUB_CLIENT_SECRET,
    );
    expect(serialized).toContain('[redacted]');
  });
});
