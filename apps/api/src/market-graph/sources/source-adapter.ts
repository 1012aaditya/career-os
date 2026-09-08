/*
 * The contract every market source adapter satisfies.
 *
 * This is the seam that makes seven sources possible without seven data
 * models. Below it, an adapter knows everything about one source's API -
 * its envelope, its pagination, its field names, its date format. Above
 * it, nothing does. The canonical layers (observations, normalization,
 * signals) import this file and never an adapter, and a test enforces
 * that by reading the source tree.
 *
 * Two properties are worth naming because they are what the contract is
 * actually for:
 *
 *   parse() is PURE. No network, no clock, no database, no randomness.
 *   Payload in, records out, deterministically. That is what lets the
 *   determinism tests run the whole chain without a stub whose behaviour
 *   would be the thing under test.
 *
 *   parse() does not throw on a bad record. A source that sends one
 *   malformed posting in a page of 600 has not failed, and a run that dies
 *   on it would be reporting our brittleness as their outage. Bad records
 *   are REJECTED individually, counted, and reported - never dropped
 *   silently, because a silent drop is indistinguishable from the source
 *   having fewer jobs.
 */

/** How complete the body text is. Load-bearing for signal denominators. */
export type DescriptionCompleteness = 'FULL' | 'TRUNCATED' | 'ABSENT';

export type IdentityBasis = 'SOURCE_ID' | 'SOURCE_URL' | 'CONTENT_FINGERPRINT';

/**
 * One posting as one source described it, in the shape every source is
 * flattened into.
 *
 * Every field is either something a source states or `null` meaning the
 * source did not state it. There is deliberately no field here for
 * seniority, skills, salary, quality or demand: three of those no source
 * in scope supplies, and a field that exists will eventually be filled in
 * with an inference by somebody who did not read this comment.
 */
export type RawPostingRecord = {
  /** The source's own key, verbatim as text. Unique within `sourceScope`. */
  externalKey: string;
  /**
   * The sub-scope within the source that this posting was found in: a
   * board token for an ATS, a country for an aggregator. Part of identity,
   * because a source's ids are only promised unique within one of these.
   */
  sourceScope: string;

  titleRaw: string;
  companyRaw: string | null;
  locationRaw: string | null;
  /** Verbatim, markup and all. Cleaning happens in normalization. */
  descriptionRaw: string | null;
  descriptionCompleteness: DescriptionCompleteness;

  /** ISO-8601 UTC, or null meaning the source did not say. Never `now`. */
  sourcePublishedAt: string | null;
  sourceUpdatedAt: string | null;
  sourceValidThrough: string | null;

  applyUrlRaw: string | null;
  /**
   * The source's own category labels, verbatim and unmapped. Not roles.
   *
   * An array because the sources have arrays. A singular field could only
   * be filled by taking element zero, which would make the value depend on
   * the source's array order - an order this design refuses to trust
   * anywhere else. Adapters order it before returning it.
   */
  sourceCategoriesRaw: string[];
  /**
   * The grouping the source itself asserts, where it asserts one - a
   * requisition id behind several city-specific posts. Null when the
   * source offers nothing.
   */
  externalGroupKey: string | null;

  /** The source's object for this posting, untouched. */
  payload: Record<string, unknown>;
};

export type RejectedRecord = {
  /** Position in the response, so the offending record is findable. */
  index: number;
  /** A short stable code. Never a caught error, never free text. */
  reason: string;
};

export type AdapterParseResult = {
  accepted: RawPostingRecord[];
  rejected: RejectedRecord[];
};

export interface SourceAdapter {
  /** Matches MarketSource.slug. Authored, immutable, ASCII. */
  readonly sourceSlug: string;
  /**
   * Bumped whenever this adapter would parse the same payload differently.
   * Stamped on the run, so a re-parse under a later adapter is a checkable
   * difference rather than an invisible one.
   */
  readonly adapterVersion: number;
  /** The strongest identity this source can support. */
  readonly identityBasis: IdentityBasis;

  /**
   * One response body into records. Pure and total: it returns rejections
   * rather than throwing, for any input at all including `null`.
   */
  parse(body: unknown, sourceScope: string): AdapterParseResult;
}
