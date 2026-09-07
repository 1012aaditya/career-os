/*
 * Deterministic serialization.
 *
 * JSON.stringify emits object keys in insertion order, so two structurally
 * identical observations built by different code paths - one from a fresh
 * fetch, one rebuilt from a cached page - serialize to different strings.
 * That matters here because these values are compared, hashed and stored:
 * a byte difference with no semantic difference would read as a change and
 * would make a re-sync look like new data.
 *
 * Keys are therefore sorted, recursively. Array order is preserved
 * untouched, because in this model array order is meaning - the ordering
 * of repositories and languages is decided deliberately in normalize.ts
 * and must not be re-sorted here.
 */

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function canonicalize(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value as JsonValue;
  }

  if (typeof value === 'number') {
    /*
     * NaN and Infinity have no JSON representation and would silently
     * become null. A count that is not a number is a bug upstream, so it
     * fails here rather than persisting as an absence.
     */
    if (!Number.isFinite(value)) {
      throw new Error(
        'Cannot serialize a non-finite number',
      );
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (typeof value === 'object') {
    const source = value as Record<
      string,
      unknown
    >;

    const result: { [key: string]: JsonValue } =
      {};

    /*
     * Sorted by code unit, which is what Array.prototype.sort does by
     * default for strings. The comparison only has to be total and
     * stable, not linguistically meaningful.
     */
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];

      /*
       * undefined is dropped rather than encoded, matching
       * JSON.stringify - but done explicitly, so an optional field that
       * is absent and one that is present-and-undefined cannot produce
       * two different strings.
       */
      if (entry === undefined) {
        continue;
      }

      result[key] = canonicalize(entry);
    }

    return result;
  }

  /*
   * Functions, symbols, bigint. None belong in an observation, and
   * silently dropping them would hide a mistake.
   */
  throw new Error(
    `Cannot serialize value of type ${typeof value}`,
  );
}

/** Structurally identical input always yields an identical string. */
export function canonicalJson(
  value: unknown,
): string {
  return JSON.stringify(canonicalize(value));
}
