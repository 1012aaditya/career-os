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
 * Returns epoch milliseconds only for a value the payload actually carries
 * and that parses to a real instant. Anything else is null — a missing or
 * unparseable date is never substituted with a stand-in.
 */
export function getTimeField(
  item: unknown,
  key: string,
): number | null {
  const value = getStringField(item, key);

  if (value === null) {
    return null;
  }

  const time = new Date(value).getTime();

  return Number.isNaN(time) ? null : time;
}
