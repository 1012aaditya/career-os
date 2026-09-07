/*
 * Primitive readers for the /career-graph payload.
 *
 * The API client types every relation as `unknown`, so every field access
 * has to narrow defensively. These helpers are the single place that does
 * it, which keeps date parsing identical everywhere it happens.
 */

export function toArray(
  value: unknown,
): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function getStringField(
  item: unknown,
  key: string,
): string | null {
  if (
    typeof item !== 'object' ||
    item === null
  ) {
    return null;
  }

  const value = (
    item as Record<string, unknown>
  )[key];

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0
    ? trimmed
    : null;
}

export function getBooleanField(
  item: unknown,
  key: string,
) {
  if (
    typeof item !== 'object' ||
    item === null
  ) {
    return false;
  }

  return (
    (item as Record<string, unknown>)[key] ===
    true
  );
}

export function getObjectField(
  item: unknown,
  key: string,
): unknown {
  if (
    typeof item !== 'object' ||
    item === null
  ) {
    return null;
  }

  return (item as Record<string, unknown>)[
    key
  ];
}

/*
 * The shape Prisma's DateTime serialises to over JSON, plus the bare
 * date-only form. Both are unambiguous and both parse as UTC.
 *
 * The gate matters because Date's parser is far more permissive than the
 * contract below: `new Date('Summer 2023')` does not fail, it INVENTS
 * 1 January 2023 — and parses it in local time, so in a positive-offset
 * timezone it lands on 31 December 2022, a year the payload never
 * mentioned. Ingestion learned this the hard way and gates its own parsing
 * the same way (see parseDate in career-graph-ingestion.service.ts).
 *
 * The API cannot currently emit such a value, so this is a guard rather
 * than a fix for a live bug. It is still worth having: it is the whole
 * difference between the contract this function documents and what it
 * actually did, and Phase 7 adds a second source of dates.
 *
 * A time component must carry a zone. ECMAScript reads a date-ONLY string
 * as UTC but a date-TIME string without an offset as LOCAL, so
 * "2026-01-01T00:00:00" means a different instant on two devices — the
 * same split-brain between "2023-05-01" and "May 2023" that ingestion's
 * parseDate was hardened against. Only the two unambiguous shapes are
 * admitted: a bare date, or a full timestamp with Z or an offset. That is
 * exactly what Date.prototype.toISOString produces, which is what Prisma
 * serialises a DateTime to.
 */
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))?$/;

/*
 * Returns epoch milliseconds only for a value the payload actually carries
 * and that parses to a real instant. Anything else is null — a missing or
 * unparseable date is never substituted with a stand-in.
 */
export function getTimeField(
  item: unknown,
  key: string,
): number | null {
  const value = getStringField(item, key);

  if (
    value === null ||
    !ISO_INSTANT.test(value)
  ) {
    return null;
  }

  const time = new Date(value).getTime();

  return Number.isNaN(time) ? null : time;
}
