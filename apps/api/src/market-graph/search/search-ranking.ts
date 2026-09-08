import {
  RECENCY_BANDS,
  RECENCY_UNKNOWN_POINTS,
  RELEVANCE_WEIGHTS,
} from './search-ruleset.js';

/*
 * Relevance: what it is made of, and how to say so out loud.
 *
 * The requirement is that "why did A rank above B" always has an answer,
 * so the score is never computed as an opaque number. It is computed from
 * a record of FACTS - each one a yes/no or a count that a reader can check
 * against the posting in front of them - and the number is only ever the
 * sum of those facts times fixed weights.
 *
 * The facts are established by the database, because ranking has to happen
 * where the rows are. The arithmetic is done here, in TypeScript, twice:
 * once by the SQL expression the service builds from RELEVANCE_WEIGHTS to
 * get an ORDER BY, and once by `relevanceFrom` on the rows that come back.
 * A test asserts the two agree on real corpus rows. That is the guard
 * against the failure this design is otherwise wide open to - a scoring
 * expression in SQL and an explanation in TypeScript drifting apart until
 * the explanation is fiction.
 *
 * This is NOT an opportunity score, a fit score or a match score. It says
 * nothing about a person. It is a statement about one string's
 * relationship to one posting, and it is thrown away at the end of the
 * request.
 *
 * Pure: no clock, no database.
 */

/**
 * What the database found. Every field is checkable by hand against the
 * posting and the query.
 */
export type RelevanceFacts = {
  /** titleNormalized equals the normalized query. */
  titleExact: boolean;
  /** titleNormalized begins with the normalized query. */
  titlePrefix: boolean;
  /** Every query token appears among the title's tokens. */
  titleAllTokens: boolean;
  /** The posting's canonical role is the one the query resolved to. */
  roleExact: boolean;
  /** How many query tokens appear in the title. */
  titleTokenHits: number;
  /** How many query tokens appear anywhere in the document. */
  searchTokenHits: number;
  /** How many of the requested skills the posting mentions. */
  skillHits: number;
  /** locationNormalized equals the normalized location query. */
  locationExact: boolean;
  /** Every location token appears in the posting's location. */
  locationAllTokens: boolean;
  /** Which recency band the publisher's date fell in. Already in points. */
  recencyPoints: number;
};

/** One line of the explanation. */
export type RelevanceComponent = {
  /** Stable machine-readable code. Safe to render, safe to assert on. */
  code: string;
  /** What contributed: a count, or 1 for a yes/no. */
  count: number;
  /** Points per unit. */
  weight: number;
  /** count * weight. */
  points: number;
};

export type Relevance = {
  total: number;
  /** Only the components that actually contributed. Ordered by points. */
  components: RelevanceComponent[];
};

/*
 * The component table. The SINGLE place a weight is attached to a fact.
 *
 * The service builds its SQL sum by walking this same array, so a
 * component cannot exist in the ordering and be missing from the
 * explanation, or the reverse.
 */
const COMPONENTS: ReadonlyArray<{
  code: string;
  weight: number;
  count: (facts: RelevanceFacts) => number;
}> = [
  {
    code: 'TITLE_EXACT',
    weight: RELEVANCE_WEIGHTS.TITLE_EXACT,
    count: (f) => (f.titleExact ? 1 : 0),
  },
  {
    code: 'TITLE_PREFIX',
    weight: RELEVANCE_WEIGHTS.TITLE_PREFIX,
    count: (f) => (f.titlePrefix ? 1 : 0),
  },
  {
    code: 'TITLE_ALL_TOKENS',
    weight: RELEVANCE_WEIGHTS.TITLE_ALL_TOKENS,
    count: (f) => (f.titleAllTokens ? 1 : 0),
  },
  {
    code: 'ROLE_EXACT',
    weight: RELEVANCE_WEIGHTS.ROLE_EXACT,
    count: (f) => (f.roleExact ? 1 : 0),
  },
  {
    code: 'TITLE_TOKEN',
    weight: RELEVANCE_WEIGHTS.TITLE_TOKEN,
    count: (f) => f.titleTokenHits,
  },
  {
    code: 'SEARCH_TOKEN',
    weight: RELEVANCE_WEIGHTS.SEARCH_TOKEN,
    count: (f) => f.searchTokenHits,
  },
  {
    code: 'SKILL',
    weight: RELEVANCE_WEIGHTS.SKILL,
    count: (f) => f.skillHits,
  },
  {
    code: 'LOCATION_EXACT',
    weight: RELEVANCE_WEIGHTS.LOCATION_EXACT,
    count: (f) => (f.locationExact ? 1 : 0),
  },
  {
    code: 'LOCATION_TOKENS',
    weight: RELEVANCE_WEIGHTS.LOCATION_TOKENS,
    count: (f) => (f.locationAllTokens ? 1 : 0),
  },
  /*
   * Recency arrives already converted to points, because the band
   * boundaries are days and the weight IS the band. Modelled with a
   * weight of 1 so it sums like everything else rather than needing a
   * special case in two places.
   */
  {
    code: 'RECENCY',
    weight: 1,
    count: (f) => f.recencyPoints,
  },
];

/** The component codes, in scoring order. Used to build the SQL sum. */
export const RELEVANCE_COMPONENT_CODES: readonly string[] = COMPONENTS.map(
  (component) => component.code,
);

/**
 * The score, and the reason for it.
 *
 * Components contributing nothing are omitted: an explanation listing
 * eight zeroes buries the two lines that mattered.
 *
 * Ordered by points descending, then by code, so the same facts always
 * produce the same explanation in the same order - the explanation is
 * part of the response, so it is part of what determinism has to cover.
 */
export function relevanceFrom(facts: RelevanceFacts): Relevance {
  const components: RelevanceComponent[] = [];
  let total = 0;

  for (const component of COMPONENTS) {
    const count = component.count(facts);
    const points = count * component.weight;

    total += points;

    if (points !== 0) {
      components.push({
        code: component.code,
        count,
        weight: component.weight,
        points,
      });
    }
  }

  components.sort((a, b) =>
    b.points === a.points ? (a.code < b.code ? -1 : 1) : b.points - a.points,
  );

  return { total, components };
}

/**
 * The recency band a publication date falls in, in points.
 *
 * `asOfDay` is a UTC day boundary, not an instant, and that is what keeps
 * an ordering stable for the length of a day. With a live clock the band
 * edge moves continuously, so a posting published exactly seven days ago
 * would cross from 40 points to 20 mid-session - reordering a result set
 * underneath a cursor that had already been handed out.
 *
 * Exported for the test that checks the SQL agrees with it.
 */
export function recencyPoints(
  sourcePublishedAt: Date | null,
  asOfDay: Date,
): number {
  if (sourcePublishedAt === null) {
    return RECENCY_UNKNOWN_POINTS;
  }

  const ageDays = Math.floor(
    (asOfDay.getTime() - sourcePublishedAt.getTime()) / 86_400_000,
  );

  /*
   * A posting the publisher dates in the future scores the top band
   * rather than nothing. It happens - a deadline-shaped field, a timezone
   * an adapter read generously - and treating it as maximally old would
   * bury a posting for being too new.
   */
  for (const band of RECENCY_BANDS) {
    if (ageDays <= band.withinDays) {
      return band.points;
    }
  }

  return 0;
}

/**
 * Midnight UTC on the day of `asOf`.
 *
 * The quantization that makes an ordering reproducible. Takes an explicit
 * instant; reads no clock.
 */
export function asOfDay(asOf: Date): Date {
  return new Date(
    Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()),
  );
}
