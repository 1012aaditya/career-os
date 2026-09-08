/*
 * Moved to src/common/canonical-json.ts in Phase 8.
 *
 * The Market Graph needs the same guarantee this function provides, and
 * duplicating a determinism primitive is the one kind of duplication that
 * cannot be tolerated: two copies drift, and every determinism claim in
 * both phases rests on them agreeing. Promoting it to a shared home was
 * cheaper and safer than either a copy or a cross-domain import from
 * market-graph into integrations/github.
 *
 * This re-export exists so that no Phase 7 import or test changed.
 *
 * The implementation moved unaltered. Compared with comments and
 * whitespace removed, the new file differs from this one by exactly five
 * characters: one optional leading `|` on a union type and four trailing
 * commas, all of them prettier reformatting. No logic, no branch and no
 * error message changed, and the Phase 7 suite passes unmodified.
 */
export { canonicalJson } from '../../../common/canonical-json.js';
