/*
 * Which independent source an evidence row came from.
 *
 * THE MISTAKE THIS EXISTS TO PREVENT. Corroboration is the one place a
 * trust system can inflate itself without anybody lying. Fourteen GitHub
 * repositories look like fourteen pieces of evidence, and they are - but
 * they are ONE source, seen fourteen times. A resume that mentions
 * TypeScript in four bullet points is one document, not four witnesses.
 * Counting rows would turn "this person uses GitHub a lot" into "four
 * independent sources agree", which is a fabrication assembled entirely
 * out of true statements.
 *
 * So corroboration counts DISTINCT KEYS, and this module is what decides
 * that two rows share one. Volume lives inside a key; independence only
 * ever accrues across keys.
 *
 * The Phase 6 freeze anticipated exactly this failure from the other
 * direction, warning that scoring the Evidence joins would be "counting
 * imports rather than facts". A resume producing forty EvidenceSkill rows
 * still yields one key here, so that warning is satisfied structurally
 * rather than by remembering it.
 *
 * PRODUCER-DERIVED, NEVER CLIENT-SUPPLIED. Every key is built from an
 * identifier the producer already holds - a resume import id we created,
 * an account id the source itself issued. Nothing on a request path can
 * reach this function, because a caller who can choose their own
 * independence key can manufacture corroboration for free.
 */

/**
 * A source instance, in the only two shapes that exist today.
 *
 * A discriminated union rather than a string pair, so a new connector
 * cannot be added by passing a different prefix at a call site - it has to
 * be added HERE, where the rule for deriving its identity is written down
 * and reviewed.
 */
export type SourceInstance =
  | { kind: 'resume'; resumeImportId: string }
  | {
      kind: 'github';
      /*
       * GitHub's immutable numeric account id, as stored on the
       * connection - NEVER the login.
       *
       * A login is a mutable, re-assignable handle: a user can change it,
       * and GitHub will later hand it to somebody else. Keying independence
       * on it means a rename silently splits one source into two (inflating
       * corroboration), and a re-registration silently merges two people
       * into one (which is worse). The numeric id does neither.
       *
       * This is the same identifier - and the same reasoning - that
       * observations/attribution.ts uses to decide whether GitHub
       * attributed an artifact to this account at all.
       */
      authenticatedAccountId: string;
    };

/** Canonical UUID form, lowercase, as Postgres renders `uuid::text`. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Digits only, and bounded.
 *
 * GitHub account ids are int64. Anything that is not a run of digits is
 * not an account id - it is a login, an email, a display name or a commit
 * author string, and every one of those is an identity somebody can
 * choose. Refusing them here is what makes "we never attribute on name
 * similarity" true of independence as well as of attribution.
 */
const NUMERIC_ID = /^[0-9]{1,20}$/;

/**
 * The independence key for a source instance, or null.
 *
 * NULL RATHER THAN A THROW, and null rather than a partial key. An
 * evidence row legitimately may have no independence key - a resume
 * import that has since been deleted leaves one - and the consumer
 * contract is that a null key never corroborates anything. That makes the
 * failure mode safe: a malformed identity produces evidence that stands
 * alone rather than evidence that groups with strangers.
 *
 * Emitting `github:` with an empty id would be the dangerous alternative:
 * a key that is present, shared, and meaningless, silently merging every
 * unidentifiable row into one fictitious source.
 *
 * The returned format is byte-identical to what the backfill migration
 * wrote, so rows classified before and after this module agree.
 */
export function independenceKeyFor(
  instance: SourceInstance,
): string | null {
  switch (instance.kind) {
    case 'resume': {
      const id = instance.resumeImportId.trim().toLowerCase();

      return UUID.test(id) ? `resume:${id}` : null;
    }

    case 'github': {
      const id = instance.authenticatedAccountId.trim();

      return NUMERIC_ID.test(id) ? `github:${id}` : null;
    }

    default: {
      /*
       * Unreachable while the union is exhaustive, and retained so that
       * adding a member without handling it fails to compile rather than
       * silently returning a key that groups the new source with nothing.
       */
      const unhandled: never = instance;

      return unhandled;
    }
  }
}
