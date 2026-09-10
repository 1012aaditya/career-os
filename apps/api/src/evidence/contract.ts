/*
 * The Universal Evidence Reliability Contract.
 *
 * Source-neutral by construction. Nothing in this file knows what GitHub
 * is, and nothing in it knows that a Career Graph exists - because the
 * moment the contract knows about its first connector it stops being a
 * contract and becomes that connector's interface, and the second
 * connector then arrives as a special case.
 *
 * WHAT THIS IS FOR. Phase 7 already established real reliability
 * properties for GitHub: attribution by numeric account id and nothing
 * else, completeness that refuses to render as zero, counts that are null
 * rather than 0 when unestablished. It established them INSIDE a metadata
 * blob that only the GitHub adapter can read. So a consumer holding an
 * Evidence row could not tell an authenticated API observation from a
 * line somebody typed into a resume, except by switching on sourceType -
 * which names where evidence came from, not how far it can be trusted.
 *
 * The contract moves those properties onto the row, as the columns added
 * in the preceding commit, and states them in terms every future source
 * must answer.
 *
 * ---------------------------------------------------------------------
 * THE TEN QUESTIONS
 * ---------------------------------------------------------------------
 *
 *  1. WHO does this belong to?
 *     `userId`. Supplied by the persistence layer from the authenticated
 *     connection, never by a projection and never by a request. Absent
 *     from EvidenceRecord below for exactly that reason - see the note on
 *     that type.
 *
 *  2. WHERE did it originate?
 *     `sourceType` names the system; `sourceUrl` points a human at it.
 *
 *  3. WHAT exactly was observed?
 *     `title`, `description`, and the producer's own `metadata`.
 *
 *  4. WHEN was it observed?
 *     Three different questions that are constantly confused:
 *       occurredAt     - when the thing being evidenced happened.
 *       capturedAt     - when we first materially recorded it.
 *       lastObservedAt - when we last CONFIRMED it still holds.
 *     Conflating the first with the third dates a decade-old repository
 *     to today. Conflating the second with the third means the system can
 *     say when evidence last CHANGED and cannot say when it was last
 *     CHECKED.
 *
 *  5. WHY do we attribute it to this user?
 *     `attribution`. The question is not "is this plausible" but "what
 *     linked it to this person, and how forgeable is that link".
 *
 *  6. HOW can we trace it back?
 *     `externalId` - immutable at the source - plus `sourceUrl`.
 *
 *  7. HOW COMPLETE was the observation?
 *     `completeness`. The value that matters is not COMPLETE; it is the
 *     ability to say NOT_SCANNED and ACCESS_LOST without either becoming
 *     "there is nothing there".
 *
 *  8. HOW was it transformed?
 *     `transformVersion`. Which normalization produced this row, so a
 *     change is detectable and rows can be re-derived.
 *
 *  9. IS it corroborated INDEPENDENTLY?
 *     `independenceKey` identifies the source INSTANCE. Corroboration
 *     counts distinct keys, never rows - see independence.ts.
 *
 * 10. WHAT does it NOT establish?
 *     Deliberately NOT a field here. A limitation is a property of an
 *     inference, not of an observation: the same repository supports
 *     "contributed to a TypeScript project" and refutes nothing at all.
 *     Limitations belong to the signal layer, which must emit what it
 *     does not establish alongside what it does.
 */

/** How directly the information came from the thing it describes. */
export type Authenticity =
  | 'DIRECT_API_OBSERVATION'
  | 'VERIFIED_ARTIFACT'
  | 'USER_PROVIDED_ARTIFACT'
  | 'USER_CLAIM'
  | 'MODEL_INTERPRETATION';

/** Why we believe this belongs to this user. */
export type Attribution =
  | 'AUTHENTICATED_ACCOUNT'
  | 'VERIFIED_OWNERSHIP'
  | 'EXPLICIT_AUTHORSHIP'
  | 'USER_ASSERTED'
  | 'WEAK_MATCH';

/** How much of the intended scope was actually seen. */
export type Completeness =
  | 'COMPLETE'
  | 'PARTIAL'
  | 'NOT_SCANNED'
  | 'ACCESS_LOST'
  | 'UNKNOWN';

/**
 * One evidence row, as the trust layer needs to see it.
 *
 * `userId` IS ABSENT, and that is the point. This module classifies
 * evidence; it must never be able to decide whose evidence it is. Identity
 * comes from the authenticated session and is enforced at the query, so a
 * bug here cannot reach across users - there is nothing here to reach
 * with. For the same reason nothing below is permitted to derive identity
 * from sourceUrl, externalId or metadata.
 *
 * Every field mirrors a persisted column. Nothing is invented, because a
 * derived value that looks like a stored one is how a score gets smuggled
 * into a schema.
 */
export type EvidenceRecord = {
  sourceType: string;
  title: string;
  description: string | null;
  sourceUrl: string | null;
  externalId: string | null;

  occurredAt: Date | null;
  capturedAt: Date;
  lastObservedAt: Date | null;

  authenticity: Authenticity;
  attribution: Attribution;
  completeness: Completeness;

  transformVersion: number;
  independenceKey: string | null;

  metadata: unknown;
};

/**
 * How precisely a row points at an identifiable thing.
 *
 * NOT a measure of skill, seniority or quality, and the naming is chosen
 * to make that hard to misread. A VAGUE row may describe outstanding
 * work; a SPECIFIC row may describe a one-line repository. Specificity
 * says only how much of the evidence can be checked by someone else.
 */
export type Specificity = 'SPECIFIC' | 'GENERAL' | 'VAGUE';

/** How recently the row was last confirmed - not when the work happened. */
export type Recency = 'FRESH' | 'STALE' | 'UNKNOWN';

/**
 * The one classification a UI may show.
 *
 * Five named states rather than a number, because a number invites
 * arithmetic - averaging, thresholding, ranking people - and every one of
 * those operations silently discards the reason behind the value. These
 * are derived at read time from transparent rules and are never stored.
 */
export type TrustClass =
  | 'VERY_STRONG'
  | 'STRONG'
  | 'MODERATE'
  | 'WEAK'
  | 'UNVERIFIED';
