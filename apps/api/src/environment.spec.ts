import { afterEach, describe, expect, it } from 'vitest';

import {
  booleanOverride,
  corsAllowedOrigins,
  currentEnvironment,
  shouldServeApiDocs,
} from './environment.js';

/*
 * Environment-dependent behaviour.
 *
 * The property every test here defends is DENY BY DEFAULT: an unset,
 * misspelt or hostile value must land on the safe answer. The API had no
 * NODE_ENV check at all before PR-3, which is why its documentation was
 * served to the public internet - so "what happens when nobody configured
 * anything" is the case that matters most.
 */

afterEach(() => {
  delete process.env.NODE_ENV;
  delete process.env.API_DOCS_ENABLED;
  delete process.env.CORS_ALLOWED_ORIGINS;
});

describe('deciding which environment this is', () => {
  it.each(['development', 'test', 'staging', 'production'])(
    'recognises %s',
    (value) => {
      expect(currentEnvironment({ NODE_ENV: value })).toBe(value);
    },
  );

  /*
   * The rule the whole file turns on. Guessing "development" for an unset
   * variable means a real deployment with public docs; guessing
   * "production" means a developer sets a variable. Only one of those is
   * an incident.
   */
  it.each([undefined, '', 'prod', 'PRODUCTION', 'dev', 'staging ', 'nonsense'])(
    'treats %j as production',
    (value) => {
      expect(currentEnvironment({ NODE_ENV: value })).toBe('production');
    },
  );
});

describe('reading a boolean override', () => {
  it('accepts only an explicit true or false', () => {
    expect(booleanOverride('true')).toBe(true);
    expect(booleanOverride('false')).toBe(false);
    expect(booleanOverride('TRUE')).toBe(true);
    expect(booleanOverride('  false  ')).toBe(false);
  });

  /*
   * A typo returns null so the caller falls back to its default. If a
   * mistyped value read as truthy, "API_DOCS_ENABLED=yes" would publish
   * the API surface in production - the exact accident this guards.
   */
  it.each(['yes', '1', 'on', 'enabled', '', 'TrUe!'])(
    'refuses %j, falling back to the default',
    (value) => {
      expect(booleanOverride(value)).toBeNull();
    },
  );

  it('returns null when nothing was configured', () => {
    expect(booleanOverride(undefined)).toBeNull();
  });
});

describe('whether to serve API documentation', () => {
  it('serves docs in development and staging', () => {
    expect(shouldServeApiDocs({ NODE_ENV: 'development' })).toBe(true);
    expect(shouldServeApiDocs({ NODE_ENV: 'staging' })).toBe(true);
  });

  it('does not serve docs in production', () => {
    expect(shouldServeApiDocs({ NODE_ENV: 'production' })).toBe(false);
  });

  it('does not serve docs when nobody said what this is', () => {
    expect(shouldServeApiDocs({})).toBe(false);
  });

  /*
   * Not "if production then never". A staging environment legitimately
   * wants docs, and a production incident legitimately might - and a
   * hard-coded refusal gets worked around in a hurry, badly.
   */
  it('can be turned on in production, deliberately', () => {
    expect(
      shouldServeApiDocs({ NODE_ENV: 'production', API_DOCS_ENABLED: 'true' }),
    ).toBe(true);
  });

  it('can be turned off in development, deliberately', () => {
    expect(
      shouldServeApiDocs({ NODE_ENV: 'development', API_DOCS_ENABLED: 'false' }),
    ).toBe(false);
  });

  it('ignores a malformed override rather than guessing', () => {
    expect(
      shouldServeApiDocs({ NODE_ENV: 'production', API_DOCS_ENABLED: 'yes' }),
    ).toBe(false);
  });
});

describe('which browser origins may call the API', () => {
  /*
   * Empty is correct rather than unfinished. The only client is a native
   * iOS app, which is not a browser and is not subject to CORS; allowing
   * an origin would be inventing a web frontend that does not exist.
   */
  it('allows nothing by default', () => {
    expect(corsAllowedOrigins({})).toEqual([]);
    expect(corsAllowedOrigins({ CORS_ALLOWED_ORIGINS: '' })).toEqual([]);
    expect(corsAllowedOrigins({ CORS_ALLOWED_ORIGINS: '   ' })).toEqual([]);
  });

  it('reads a configured list', () => {
    expect(
      corsAllowedOrigins({
        CORS_ALLOWED_ORIGINS: 'https://app.example.com, https://admin.example.com',
      }),
    ).toEqual(['https://app.example.com', 'https://admin.example.com']);
  });

  /*
   * The misconfiguration this exists to prevent, refused even when it
   * arrives through configuration somebody set on purpose. `*` with
   * credentials is the classic CORS hole, and accepting it from an
   * environment variable would reintroduce it through the back door.
   */
  it('refuses a wildcard, however it is configured', () => {
    expect(corsAllowedOrigins({ CORS_ALLOWED_ORIGINS: '*' })).toEqual([]);
    expect(
      corsAllowedOrigins({
        CORS_ALLOWED_ORIGINS: 'https://app.example.com,*',
      }),
    ).toEqual(['https://app.example.com']);
  });

  it('drops empty entries from a sloppy list', () => {
    expect(
      corsAllowedOrigins({
        CORS_ALLOWED_ORIGINS: 'https://a.example.com,,  ,https://b.example.com',
      }),
    ).toEqual(['https://a.example.com', 'https://b.example.com']);
  });
});
