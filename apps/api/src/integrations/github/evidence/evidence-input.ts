/*
 * The contract between projection (7.4 A) and persistence (7.4 B).
 *
 * Written by the integrator ahead of both so the two halves are built
 * against a fixed shape rather than negotiated afterwards. It maps
 * one-to-one onto the columns of the existing Evidence model - no schema
 * change is needed for Phase 7.4, and none is made.
 *
 * One row per REPOSITORY. Not per commit, pull request, issue or
 * language: those are counted observations inside metadata. A commit
 * proves almost nothing on its own, and thousands of rows each asserting
 * that one exists is volume dressed as evidence - exactly the shape that
 * invites "1,000 commits, therefore expert".
 */

/**
 * Everything needed to write one Evidence row, and nothing else.
 *
 * `userId` is absent on purpose: the projection never sees it. Ownership
 * is supplied by the persistence layer from the authenticated connection,
 * so a projection bug cannot write a row onto the wrong account.
 */
export type EvidenceInput = {
  /*
   * Always 'GITHUB' here. Present as a field rather than assumed so the
   * persistence layer keys its upsert on the same value the caller
   * intended, and so a Portfolio projection can reuse this type unchanged.
   */
  sourceType: 'GITHUB';

  /*
   * The deduplication key, together with userId and sourceType. Built
   * from the immutable numeric repository id: names, URLs and node_id all
   * move under a rename or transfer, and keying on any of them would make
   * a renamed repository look like a new one and duplicate its evidence.
   */
  externalId: string;

  title: string;
  description: string | null;

  /** Canonical html_url. Display and verification, never identity. */
  sourceUrl: string | null;

  /*
   * When the thing being evidenced happened, as GitHub reports it - not
   * when we looked. Null when GitHub gives no usable timestamp, because
   * an invented date is worse than an absent one.
   */
  occurredAt: Date | null;

  /*
   * When we observed it. Distinct from occurredAt and never a substitute:
   * conflating them would date a decade-old repository to today.
   */
  capturedAt: Date;

  /*
   * Deterministic. Built through the canonical-JSON primitive so two runs
   * over identical observations produce byte-identical metadata and a
   * re-sync does not read as a change.
   *
   * Carries the completeness record, the language byte-composition with
   * GitHub's spellings preserved, and activity counts that are null when
   * unestablished - never zero.
   */
  metadata: Record<string, unknown>;

  /*
   * -------------------------------------------------------------------
   * THE EVIDENCE RELIABILITY CONTRACT
   * -------------------------------------------------------------------
   * Declared by the producer rather than inferred by a consumer. Phase 7
   * already HELD every one of these properties - it simply had nowhere to
   * write them down except a metadata blob only this adapter can read.
   *
   * They are stated as literal types rather than the wider enums, so this
   * projection cannot accidentally emit a weaker or stronger claim than
   * GitHub actually supports: `attribution: 'WEAK_MATCH'` would not
   * compile here, and neither would `completeness: 'COMPLETE'`.
   */

  /** We called GitHub's API under the user's authorization and read it. */
  authenticity: 'DIRECT_API_OBSERVATION';

  /*
   * GitHub itself resolved the artifact to the authenticated ACCOUNT by
   * numeric id. See observations/attribution.ts, which refuses git author
   * email, login, repository ownership and name similarity - so this is a
   * statement of what already happens, not a new promise.
   */
  attribution: 'AUTHENTICATED_ACCOUNT';

  /*
   * COMPLETE is deliberately not in this union. GitHub's repository
   * endpoints expose only the default branch, so no run this producer can
   * make establishes complete coverage - and a type that cannot express
   * COMPLETE cannot drift into claiming it.
   */
  completeness: 'PARTIAL' | 'NOT_SCANNED' | 'ACCESS_LOST';

  /*
   * When this repository was SUCCESSFULLY re-observed, or null.
   *
   * Null is the load-bearing value. It means this run did not establish
   * the observation - it was skipped for budget, access was lost, or a
   * dimension of its activity failed to be read - and the persistence
   * layer must then leave any earlier, truthful value alone rather than
   * advancing it. A heartbeat that fires on an unsuccessful run turns
   * "the sync process ran" into "this evidence was verified", which is
   * the precise lie this column exists to prevent.
   */
  lastObservedAt: Date | null;

  /** Which projection produced the row, so a change is detectable. */
  transformVersion: number;

  /*
   * The source INSTANCE: one authenticated account, not one repository.
   * Fourteen repositories share this value, because they are fourteen
   * observations of one source.
   */
  independenceKey: string | null;
};
