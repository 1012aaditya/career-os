/*
 * What Market Search is allowed to do, as constants.
 *
 * Everything that decides an ordering lives in this file, for the same
 * reason RULESET_VERSION exists one directory over: a ranking whose
 * weights are scattered through a query builder is one nobody can explain
 * afterwards, and "why did A beat B" is the only question a search API is
 * ever really asked.
 *
 * Pure. No clock, no database, no Intl.
 */

/**
 * The version of the projection contract.
 *
 * Bumped when the SHAPE of a search document changes - a new token
 * source, a different tokenizer, a column that changes meaning. A
 * document built under an older projection version is rebuilt rather than
 * read, so a half-finished rebuild serves consistent rows or none.
 *
 * Deliberately separate from RULESET_VERSION. They move for different
 * reasons: adding a canonical role changes normalization and leaves the
 * projection's shape untouched, and re-running one should not invalidate
 * the other's output.
 */
export const SEARCH_PROJECTION_VERSION = 1;

/**
 * The version of the weights below.
 *
 * Not folded into the document hash, because it changes no stored value -
 * it changes how stored values are ORDERED. It is returned on every
 * response and carried inside every cursor, so a page fetched under one
 * ranking can never be continued under another.
 */
export const RANKING_VERSION = 1;

/**
 * What each component contributes, in whole points.
 *
 * INTEGERS, and that is not a style preference. Floating point sums are
 * order-dependent at the last bit, so two rows whose components differ
 * only in summation order could compare unequal - and an ordering that
 * depends on the order of an addition is not an ordering. It is also the
 * rule the Market Graph schema already enforces on itself: no Float
 * column anywhere.
 *
 * The gaps between tiers are wide on purpose. TITLE_EXACT at 1000 cannot
 * be outvoted by any accumulation of weaker evidence: eleven skill hits
 * and a location match still lose to the posting whose title IS the query.
 * That is the property section 10 asks for - "exact match beats weaker
 * match" - expressed as arithmetic rather than as a hope.
 */
export const RELEVANCE_WEIGHTS = {
  /** The normalized title equals the normalized query, exactly. */
  TITLE_EXACT: 1000,
  /** The normalized title begins with the normalized query. */
  TITLE_PREFIX: 400,
  /** Every query token appears in the title. */
  TITLE_ALL_TOKENS: 250,
  /**
   * The posting's canonical role is the one the QUERY resolved to.
   *
   * Worth less than a title match, and that ordering is the guard against
   * the false merges section 9 names. A search for "Data Analyst" that
   * resolves to the data-analyst role gives every data-analyst posting
   * 200 points - but a posting actually titled "Data Analyst" also takes
   * TITLE_EXACT's 1000, so it cannot be displaced by a role sibling. The
   * role widens the result set; it does not reorder its head.
   */
  ROLE_EXACT: 200,
  /** Per query token found in the title. */
  TITLE_TOKEN: 50,
  /** Per query token found anywhere in the document's tokens. */
  SEARCH_TOKEN: 15,
  /** Per requested skill the posting mentions. */
  SKILL: 25,
  /** The normalized location equals the normalized location query. */
  LOCATION_EXACT: 150,
  /** Every location token appears in the posting's location. */
  LOCATION_TOKENS: 80,
} as const;

/**
 * Recency bands, in whole days, most recent first.
 *
 * Measured from the PUBLISHER's stated publication date and never from
 * our retrieval time. Section 29 is the rule and this is where it binds:
 * every posting in this corpus was retrieved inside one five-hour window
 * on 2026-09-08, so ranking by retrieval would order 76,968 postings by
 * the order our crawler happened to walk them - which is not a fact about
 * the market at all.
 *
 * Banded rather than continuous so the ordering is stable within a day.
 * A continuous decay would make every result's position a function of the
 * current millisecond, and a cursor issued at 11:59 would describe an
 * ordering that no longer existed at 12:00.
 */
export const RECENCY_BANDS: ReadonlyArray<{
  withinDays: number;
  points: number;
}> = [
  { withinDays: 7, points: 40 },
  { withinDays: 30, points: 20 },
  { withinDays: 90, points: 5 },
];

/**
 * What a posting with no stated publication date scores.
 *
 * Zero, not a middling default. Every source in this corpus states one,
 * so this branch is unreachable today - and if a future source does not,
 * the honest answer is "this contributes no evidence", never a guess that
 * would place it among postings whose date we actually know.
 */
export const RECENCY_UNKNOWN_POINTS = 0;

/** Page sizes. A caller may ask for less; it may not ask for more. */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

/**
 * Caps on what a caller may send.
 *
 * Section 24's "sane limits", chosen so that a hostile query costs no
 * more than an ordinary one. MAX_QUERY_TOKENS is the load-bearing one:
 * every token adds a term to the scoring expression, so an unbounded
 * token list is an unbounded query plan.
 */
export const MAX_QUERY_LENGTH = 200;
export const MAX_QUERY_TOKENS = 12;
export const MAX_FILTER_VALUES = 10;

/**
 * The only orderings a caller may ask for.
 *
 * A whitelist rather than a passthrough, because an ORDER BY taken from a
 * request body is a SQL injection with extra steps. Every entry here
 * resolves to a fixed expression in the service and none of them is
 * caller-supplied text.
 */
export const SORT_OPTIONS = ['relevance', 'published'] as const;

export type SortOption = (typeof SORT_OPTIONS)[number];

/**
 * The freshness verdicts a caller may filter on.
 *
 * Named from the Phase 8 vocabulary rather than reinvented. UNAVAILABLE
 * is included and means "no complete read of this posting's scope has
 * finished since we last saw it" - it is a statement about our coverage,
 * not about the job, and a caller filtering it out is filtering out our
 * ignorance rather than stale adverts.
 */
export const FRESHNESS_FILTERS = [
  'FRESH',
  'AGING',
  'STALE',
  'UNAVAILABLE',
] as const;
