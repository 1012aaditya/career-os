import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical-json.js';

/*
 * The one content-hash primitive.
 *
 * Built on canonicalJson rather than beside it, so a hash and a stored
 * serialization can never disagree about what "the same value" means. No
 * other module may call createHash to hash a value - one primitive, one
 * test, one version story - and a test asserts that.
 *
 * Note what this inherits by construction: canonicalJson sorts object keys
 * recursively, so key order cannot reach a byte; it PRESERVES array order,
 * so any array whose order is not already decided must be sorted by its
 * caller before it gets here; and it throws on a Date, Map, Set, Buffer,
 * NaN or Infinity rather than silently serializing it to {} or null.
 * Convert instants to ISO strings before hashing. A throw here is the
 * design working, not an inconvenience to catch around.
 */
export function canonicalHash(value: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}
