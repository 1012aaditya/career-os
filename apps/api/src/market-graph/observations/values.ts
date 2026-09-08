/*
 * Value coercions for market payloads.
 *
 * Pure. No HTTP, no Prisma, no clock, no randomness. Every one of these
 * refuses rather than guesses: a market source is not a trusted input, and
 * a coerced value is indistinguishable from a real one once it is stored.
 */

/** Trims, and treats an empty or whitespace-only string as absent. */
export function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

/*
 * An instant with a zone, re-emitted in UTC.
 *
 * Greenhouse emits a numeric offset ("2026-08-18T18:06:19-04:00"), not Z,
 * so the offset branch is the one that actually fires here - it is not
 * defensive padding.
 *
 * A zone-LESS date-time is refused rather than coerced. ECMAScript reads a
 * date-only string as UTC but a date-time string without an offset as
 * LOCAL, so "2026-01-01T00:00:00" is a different instant on a laptop in
 * Sydney and a container in us-east-1. Accepting one would fabricate a
 * date rather than report one.
 */
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))?$/;

export function optionalInstant(value: unknown): string | null {
  const text = optionalString(value);

  if (text === null || !ISO_INSTANT.test(text)) {
    return null;
  }

  const parsed = Date.parse(text);

  if (Number.isNaN(parsed)) {
    return null;
  }

  /*
   * Re-emitted from the parsed instant rather than passed through, so two
   * spellings of one moment normalize to one string and do not read as a
   * change on the next ingest. This is also what converts the offset form
   * to UTC, so everything downstream compares like with like.
   */
  return new Date(parsed).toISOString();
}

/*
 * A source-provided numeric id, held as text.
 *
 * JSON numbers are doubles. Beyond 2^53 the value has already been rounded
 * by the parser, and a rounded id could collide with a DIFFERENT posting -
 * which would silently merge two jobs into one row and undercount demand.
 * It is refused rather than stored.
 */
export function numericKey(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }

  return String(value);
}
