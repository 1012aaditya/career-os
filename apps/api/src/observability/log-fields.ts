import { createHash } from 'node:crypto';

/*
 * What may appear in a log line, and nothing else.
 *
 * Pure: no clock, no logger, no I/O. Every decision here is a function of
 * its arguments, which is what lets "a secret cannot reach a log" be a
 * test rather than a habit.
 *
 * THE MODEL IS AN ALLOWLIST, and the difference from the obvious
 * alternative is the whole point. Removing a few known-bad keys and then
 * logging the object is not a control: it protects against the fields
 * somebody thought of, on the day they thought of them, and fails silently
 * the moment a provider adds `access_token` to a response shape or a
 * developer spreads a request into a log call. Here, a field that is not
 * named below does not get logged - so the failure mode of forgetting
 * something is a missing diagnostic, not a leaked credential.
 *
 * WHY THIS FILE EXISTS AT ALL. Until PR-5 the API's policy was zero
 * console output, enforced by a source scan. That was the honest interim
 * position while there was nothing safe to log into - but it also meant a
 * production incident would be invisible. This replaces "log nothing" with
 * "log exactly these things".
 */

/**
 * Every field name a log line may carry.
 *
 * Deliberately small, and deliberately boring. Each one is either about
 * the REQUEST (which route, how long, what status) or about the SHAPE of a
 * failure (which class, which code) - never about the user, their data, or
 * the credentials involved.
 *
 * Adding a name here is the moment to ask whether the value it will carry
 * can identify a person or authenticate as one. That question is easy to
 * answer for one field in a review, and impossible to answer for an
 * arbitrary object at runtime.
 */
export const ALLOWED_LOG_FIELDS = [
  /* Correlation. The thread a human follows through an incident. */
  'requestId',

  /* The request, in terms that carry no identifiers - see `route`. */
  'method',
  'route',
  'statusCode',
  'durationMs',

  /* What happened. A short stable code, never a sentence from a provider. */
  'event',
  'outcome',

  /*
   * Failure shape. The CLASS and the CODE, never the message: a message is
   * where a provider puts a bucket name, a tenant id or a connection
   * string, and it is the field most likely to carry something we did not
   * choose.
   */
  'errorClass',
  'errorCode',
  'errorCategory',

  /* Which external system, and which operation on it. Names, not payloads. */
  'provider',
  'operation',

  /* Dependency health, for readiness diagnostics. */
  'dependency',
  'dependencyStatus',

  /*
   * A pseudonym for a user, never the user id itself. See `pseudonymize`.
   * Present so that "the same person hit this five times" is answerable
   * without the log carrying the key that indexes their career history.
   */
  'actor',

  /* Where the process is running. */
  'environment',
  'service',
] as const;

export type AllowedLogField = (typeof ALLOWED_LOG_FIELDS)[number];

/** What an allowed field may hold. Primitives only - never a nested object. */
export type LogValue = string | number | boolean | null;

export type LogFields = Partial<Record<AllowedLogField, LogValue>>;

const ALLOWED = new Set<string>(ALLOWED_LOG_FIELDS);

/**
 * A ceiling on any single value.
 *
 * A long string in a log is either a mistake or an attack: a caller
 * pasting a body in, or somebody stuffing a header to bury other lines.
 * Truncation is visible - the marker stays - so a reader can tell a cut
 * value from a short one.
 */
const MAX_VALUE_LENGTH = 256;

/**
 * The fields of a log line, filtered to the allowlist.
 *
 * Anything not named in ALLOWED_LOG_FIELDS is DROPPED, silently and by
 * design: a caller that passes a whole request object gets a log line with
 * its allowed fields and nothing else, rather than an error at 3am or a
 * leaked Authorization header.
 *
 * Nested objects are dropped too, whatever their key. A value that needs a
 * structure is a value somebody has not thought about - and it is exactly
 * how an error object, a Prisma payload or a Supabase session ends up in a
 * log while looking like one innocent field.
 */
export function safeFields(input: Record<string, unknown>): LogFields {
  const out: LogFields = {};

  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED.has(key)) {
      continue;
    }

    if (value === null) {
      out[key as AllowedLogField] = null;
      continue;
    }

    if (typeof value === 'number') {
      /* NaN and Infinity serialise as null in JSON and read as "missing". */
      out[key as AllowedLogField] = Number.isFinite(value) ? value : null;
      continue;
    }

    if (typeof value === 'boolean') {
      out[key as AllowedLogField] = value;
      continue;
    }

    if (typeof value === 'string') {
      out[key as AllowedLogField] =
        value.length > MAX_VALUE_LENGTH
          ? `${value.slice(0, MAX_VALUE_LENGTH)}…[truncated]`
          : value;
      continue;
    }

    /*
     * Everything else - objects, arrays, functions, symbols, undefined -
     * is dropped. This is the branch that stops `{ error }`, `{ session }`
     * and `{ body }` from ever being serialised.
     */
  }

  return out;
}

/**
 * A stable pseudonym for a user id.
 *
 * The operational need is real: "the same person hit this five times in a
 * minute" is a different incident from "five people did". The privacy need
 * is equally real: a user id is the key that indexes somebody's resumes
 * and employment history, and a log aggregator is not where it belongs.
 *
 * A truncated SHA-256 over the id and a per-deployment salt satisfies
 * both. It is stable within a deployment, so events correlate; it is not
 * reversible to the id; and because the salt differs per environment, a
 * pseudonym from one deployment says nothing about another.
 *
 * Twelve hex characters is 48 bits - collision-free in practice at any
 * volume this product will see, and short enough to read in a log.
 *
 * The salt is passed in rather than read from the environment, so this
 * module stays pure and configuration reads stay in the one file the
 * security boundary permits them in. See `logPseudonymSalt`.
 */
export function pseudonymize(userId: string, salt = ''): string {
  return createHash('sha256')
    .update(`${salt}:${userId}`)
    .digest('hex')
    .slice(0, 12);
}

/** Broad buckets an operator triages by, before reading anything else. */
export type ErrorCategory =
  /* The caller asked for something impossible. Not our failure. */
  | 'client'
  /* A dependency we require refused or could not be reached. */
  | 'dependency'
  /* The database specifically, which has its own escalation path. */
  | 'database'
  /* Ours. A bug. */
  | 'internal';

export type SafeErrorShape = {
  errorClass: string;
  errorCode: string | null;
  errorCategory: ErrorCategory;
};

/**
 * An error reduced to the parts that are safe to record.
 *
 * The MESSAGE is deliberately absent, and that is the single most
 * important line in this file. A message is where a provider writes a
 * bucket name, a tenant identifier, a hostname, a row of failing data or -
 * for a connection error - the connection string itself. The class and the
 * code answer "what kind of failure" without any of that.
 *
 * `errorCode` is taken only from known-safe shapes: a Prisma code like
 * P2028, an HTTP status, a short provider reason code. Anything that is
 * not a short token is dropped rather than trusted.
 */
export function describeError(error: unknown): SafeErrorShape {
  if (!(error instanceof Error)) {
    return {
      errorClass: typeof error,
      errorCode: null,
      errorCategory: 'internal',
    };
  }

  const code = safeCode((error as { code?: unknown }).code);

  return {
    errorClass: error.constructor?.name ?? error.name ?? 'Error',
    errorCode: code,
    errorCategory: categorise(error, code),
  };
}

/**
 * A code, if it is short and token-shaped.
 *
 * Node puts strings like ECONNREFUSED here and Prisma puts P2028. Both are
 * safe and useful. A long value in the same position is something else -
 * a message, a URL, a payload - and is dropped rather than guessed at.
 */
function safeCode(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value !== 'string') {
    return null;
  }

  return /^[A-Za-z0-9_.-]{1,32}$/.test(value) ? value : null;
}

function categorise(error: Error, code: string | null): ErrorCategory {
  /*
   * Prisma's known-request errors all carry a P-prefixed code. P2028 is
   * the transaction-start timeout PR-4 found against the Sydney pooler,
   * and it is the reason this category exists separately from
   * 'dependency': a database that cannot start a transaction is an
   * escalation, not a flaky third party.
   */
  if (code !== null && /^P\d{4}$/.test(code)) {
    return 'database';
  }

  if (error.constructor?.name?.startsWith('Prisma')) {
    return 'database';
  }

  if (
    code !== null &&
    ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(
      code,
    )
  ) {
    return 'dependency';
  }

  return 'internal';
}

/**
 * A route pattern that is safe to log.
 *
 * `/v1/resume-imports/8f3a…/file` names a specific document belonging to a
 * specific person; `/v1/resume-imports/:id/file` names an endpoint. Only
 * the second belongs in a log, and this is what makes the difference
 * automatic rather than something each call site has to remember.
 *
 * Nest gives us the matched route pattern when a handler was found. This
 * exists for the paths where it does not - a 404, a request that never
 * reached a controller - where the raw URL is all there is.
 */
export function safeRoute(rawPath: string): string {
  const path = rawPath.split('?')[0] ?? '';

  const segments = path.split('/').map((segment) => {
    if (segment === '') {
      return segment;
    }

    /* A uuid is an identifier by definition. */
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        segment,
      )
    ) {
      return ':id';
    }

    /* A long opaque token, or anything mostly digits. */
    if (/^\d+$/.test(segment) || segment.length > 40) {
      return ':id';
    }

    return segment;
  });

  const joined = segments.join('/');

  return joined.length > MAX_VALUE_LENGTH
    ? `${joined.slice(0, MAX_VALUE_LENGTH)}…[truncated]`
    : joined;
}

/**
 * A client-supplied correlation id, if it is safe to echo.
 *
 * Accepted so a request can be followed across a client, a proxy and this
 * API. Constrained because the value is written into every log line this
 * request produces: an unvalidated one is a way to inject newlines and
 * forge log entries, or to bloat every line with a kilobyte of padding.
 */
export function safeRequestId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return /^[A-Za-z0-9_-]{8,64}$/.test(trimmed) ? trimmed : null;
}
