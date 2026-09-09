/*
 * What environment this process is running in, and what that permits.
 *
 * PR-1 found no NODE_ENV check anywhere in the API: the code could not
 * behave differently in production even if somebody wanted it to, which is
 * why the API documentation was served to the public internet.
 *
 * Two rules shape this file.
 *
 * DENY BY DEFAULT. An unset or unrecognised NODE_ENV is treated as
 * production. The failure mode of guessing "development" is a public docs
 * endpoint and permissive CORS on a real deployment; the failure mode of
 * guessing "production" is a developer having to set a variable. Only one
 * of those is a security incident.
 *
 * NEVER "if production then never". Each capability is a separate
 * decision with its own override, because a staging environment
 * legitimately wants documentation, and a production incident
 * legitimately might. A hard-coded refusal would be worked around by
 * whoever needed it, in a hurry, badly.
 */

export type Environment = 'development' | 'test' | 'staging' | 'production';

export function currentEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Environment {
  switch (env.NODE_ENV) {
    case 'development':
    case 'test':
    case 'staging':
      return env.NODE_ENV;
    case 'production':
      return 'production';
    default:
      /* Unset or unrecognised. The safe assumption, not the convenient one. */
      return 'production';
  }
}

/**
 * Reads an explicit boolean override, or null when nothing was said.
 *
 * Only "true" and "false" count. A typo returns null and the caller falls
 * back to its default, so a mistyped override can never accidentally read
 * as "enable the thing".
 */
export function booleanOverride(
  value: string | undefined,
): boolean | null {
  if (value === undefined) {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === 'true') {
    return true;
  }

  if (normalized === 'false') {
    return false;
  }

  return null;
}

/**
 * Whether to mount Swagger.
 *
 * On by default outside production, because that is where it is useful and
 * where the surface it describes is not real. Off by default in
 * production, and enableable there through API_DOCS_ENABLED for the case
 * where somebody genuinely needs it - a decision that then exists as a
 * configured value somebody set, rather than as a default nobody chose.
 */
export function shouldServeApiDocs(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const override = booleanOverride(env.API_DOCS_ENABLED);

  if (override !== null) {
    return override;
  }

  return currentEnvironment(env) !== 'production';
}

/**
 * Browser origins permitted to call the API.
 *
 * Empty by default, and that is correct rather than unfinished: the only
 * client today is a native iOS application, which is not a browser and is
 * not subject to CORS at all. There is no web frontend to allow, so
 * allowing one would be inventing a client that does not exist.
 *
 * When a browser client appears - a web app, a docs page, an admin
 * console - its origins go in CORS_ALLOWED_ORIGINS, per environment. An
 * empty list means the API answers no cross-origin browser request, which
 * is the deny-by-default position.
 */
export function corsAllowedOrigins(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env.CORS_ALLOWED_ORIGINS;

  if (raw === undefined || raw.trim() === '') {
    return [];
  }

  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '')
    /*
     * A wildcard is refused rather than honoured. `origin: '*'` with
     * credentials is the misconfiguration this whole function exists to
     * make impossible, and silently accepting it from configuration would
     * reintroduce it through the back door.
     */
    .filter((origin) => origin !== '*');
}

/**
 * The salt that turns a user id into a log pseudonym.
 *
 * Read here rather than in log-fields.ts for two reasons. It keeps that
 * module pure - every function a value of its arguments, which is what
 * makes the allowlist testable - and it keeps configuration reads in the
 * one file the security boundary spec allows them in.
 *
 * An unset salt is not a failure and not a placeholder: pseudonyms are
 * still stable within the process, they are simply comparable across
 * deployments that also have none. Set it per environment so a pseudonym
 * from staging says nothing about production.
 */
export function logPseudonymSalt(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.LOG_PSEUDONYM_SALT ?? '';
}

/**
 * Where the shared rate-limit counter lives.
 *
 * Unset is a deliberate, supported state and not a misconfiguration: it
 * means "one process", which is exactly right for local development and
 * for the test tier, and the throttler falls back to the in-memory counter
 * PR-2 shipped. It becomes wrong only when a second instance exists, which
 * is a deployment decision and therefore a deployment's job to configure.
 *
 * Returned as an opaque string and never logged. A Redis URL carries a
 * password in the same position a Postgres URL does, which is why it is
 * read here - the one file the security boundary spec permits
 * configuration reads in - rather than wherever a client happens to be
 * constructed.
 */
export function redisUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.REDIS_URL;

  return raw === undefined || raw.trim() === '' ? null : raw.trim();
}

/**
 * How many reverse-proxy hops in front of this process may be trusted.
 *
 * THIS IS A SECURITY SETTING, NOT PLUMBING. Express resolves `req.ip` by
 * walking X-Forwarded-For from the right, skipping this many hops. The
 * rate limiter keys on `req.ip`. So:
 *
 *   0 - the default - means "no proxy": `req.ip` is the socket address,
 *   which a client cannot forge. Correct for local development and for
 *   any deployment reached directly.
 *
 *   1 means "exactly one proxy appends the real client address", which is
 *   what a single managed load balancer (Render, and most PaaS edges)
 *   does. The header is rewritten by that proxy, so the value is trusted
 *   only as far as the proxy.
 *
 *   `true` - trust everything - is NOT reachable from this function, and
 *   that is deliberate. It makes Express believe the LEFTMOST entry in a
 *   header the CLIENT controls. Every caller then has a free choice of
 *   source address, which turns the IP-keyed throttle into no throttle at
 *   all: send a different X-Forwarded-For each request and every one gets
 *   a fresh budget. It is the single easiest way to disable rate limiting
 *   while believing it is on.
 *
 * Defaulting to 0 fails safe: getting this too LOW throttles everyone
 * behind a proxy as one address, which is visible and annoying. Too HIGH
 * silently removes the limit.
 */
export function trustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRUSTED_PROXY_HOPS;

  if (raw === undefined || raw.trim() === '') {
    return 0;
  }

  const value = Number(raw);

  return Number.isInteger(value) && value >= 0 ? value : 0;
}
