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
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

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
      throw new Error('Cannot serialize a non-finite number');
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (typeof value === 'object') {
    /*
     * Plain objects only.
     *
     * Without this, a Date, Map or Set silently canonicalizes to {} - it
     * has no own enumerable keys - and a Buffer canonicalizes to an index
     * map of its bytes, {"0":103,"1":104,...}. The second one matters:
     * it means binary would be faithfully PERSISTED rather than refused,
     * and two separate credential-safety arguments elsewhere rest on the
     * claim that this function rejects what it cannot represent. It did
     * not. Now it does, and the claim is true.
     *
     * Found by review; not reachable through today's projection, which
     * builds metadata from strings, numbers and nulls only. Closed anyway
     * because an untrue safety property is worse than a missing one.
     */
    const prototype = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Cannot serialize a non-plain object');
    }

    const source = value as Record<string, unknown>;

    const result: { [key: string]: JsonValue } = {};

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
  throw new Error(`Cannot serialize value of type ${typeof value}`);
}

/** Structurally identical input always yields an identical string. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
