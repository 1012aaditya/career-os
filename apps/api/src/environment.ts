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
