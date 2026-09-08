import type {
  FreshnessVerdict,
  MarketSearchPage,
  MarketSearchResult,
} from './market-search-api';

/*
 * What a search result SAYS, decided away from React.
 *
 * Every function here is pure and takes its inputs explicitly, including
 * the clock. That is not tidiness: "posted 3 days ago" is a claim, and a
 * claim computed inside a component is one no test can pin down. The
 * screens render what these return and make no judgements of their own.
 *
 * The rule these all serve: never state something the data does not say.
 * A posting with no company is not "Unknown Company", a posting with no
 * date is not "just now", and a posting we have stopped being able to
 * check is not "active".
 */

/**
 * The line under a job title.
 *
 * Built from the parts that are actually present, joined by a middot.
 * Absent parts are DROPPED rather than filled with a placeholder: 70% of
 * this corpus carries no employer name, because Canada Job Bank's open
 * data does not publish one, and rendering "Unknown employer" 53,799
 * times would be inventing a fact about every one of them.
 */
export function resultSubtitle(result: MarketSearchResult): string {
  const parts = [result.company, result.location].filter(
    (part): part is string => part !== null && part.trim() !== '',
  );

  return parts.join(' · ');
}

/**
 * What to show where the employer's name would go.
 *
 * Null, and the caller renders nothing. Kept as a named function so the
 * decision is in one place and a future "Unknown" cannot creep in through
 * a template.
 */
export function employerLabel(result: {
  company: string | null;
}): string | null {
  return result.company === null || result.company.trim() === ''
    ? null
    : result.company;
}

export type FreshnessLabel = {
  text: string;
  /** Which of the theme's roles this should be painted in. */
  tone: 'neutral' | 'positive' | 'caution' | 'unknown';
};

/**
 * The freshness verdict, in words a reader can act on.
 *
 * UNAVAILABLE is the one that matters and the one most systems get
 * wrong. It does NOT mean the job is gone - it means no complete read of
 * this posting's scope has finished since we last saw it, so its absence
 * from recent runs is our failure rather than its disappearance. Saying
 * "no longer listed" there would report a rate limit as a closed job.
 */
export function freshnessLabel(verdict: FreshnessVerdict): FreshnessLabel {
  switch (verdict) {
    case 'FRESH':
      return { text: 'Seen recently', tone: 'positive' };
    case 'AGING':
      return { text: 'May still be open', tone: 'neutral' };
    case 'STALE':
      return { text: 'Likely closed', tone: 'caution' };
    case 'UNAVAILABLE':
      return { text: 'Not recently checked', tone: 'unknown' };
  }
}

/**
 * The sentence that keeps a freshness verdict honest.
 *
 * Returned only when there is something a reader would otherwise get
 * wrong. A verdict resting on our configured guess rather than on the
 * employer's own deadline says so.
 */
export function freshnessCaveat(freshness: {
  verdict: FreshnessVerdict;
  lifetimeBasis: 'SOURCE_STATED' | 'DEFAULT';
}): string | null {
  if (freshness.verdict === 'UNAVAILABLE') {
    return 'We have not been able to confirm this listing recently. It may or may not still be open.';
  }

  if (freshness.verdict === 'STALE' && freshness.lifetimeBasis === 'DEFAULT') {
    return 'Based on how long postings usually stay live, not on a date the employer gave.';
  }

  return null;
}

/**
 * When the PUBLISHER said this was posted, relative to now.
 *
 * Takes `now` as a parameter and reads no clock. Whole days only, because
 * the underlying dates are day-precision on several sources and "7 hours
 * ago" would be a precision the data does not have.
 */
export function publishedLabel(
  sourcePublishedAt: string | null,
  now: Date,
): string | null {
  if (sourcePublishedAt === null) {
    /* Not "recently". A missing date is not a recent one. */
    return null;
  }

  const published = new Date(sourcePublishedAt);

  if (Number.isNaN(published.getTime())) {
    return null;
  }

  const days = Math.floor(
    (now.getTime() - published.getTime()) / (24 * 60 * 60 * 1000),
  );

  if (days < 0) return 'Posted today';
  if (days === 0) return 'Posted today';
  if (days === 1) return 'Posted yesterday';
  if (days < 30) return `Posted ${days} days ago`;
  if (days < 365) return `Posted ${Math.floor(days / 30)} months ago`;

  return `Posted ${Math.floor(days / 365)} years ago`;
}

/**
 * The line that says how many jobs were found.
 *
 * Reports GROUPS, because that is what the reader is shown, and mentions
 * the postings behind them only when the two differ. Saying "1,284 jobs"
 * when 1,284 is a posting count and 1,100 rows are displayed would be a
 * number the screen contradicts.
 */
export function resultCountLabel(page: MarketSearchPage['page']): string {
  if (page.totalGroups === 0) {
    return 'No jobs found';
  }

  const jobs = `${page.totalGroups.toLocaleString('en-US')} ${
    page.totalGroups === 1 ? 'job' : 'jobs'
  }`;

  if (page.totalPostings === page.totalGroups) {
    return jobs;
  }

  return `${jobs} · ${page.totalPostings.toLocaleString('en-US')} postings`;
}

/**
 * Why the results include things the query did not literally say.
 *
 * Shown when the query resolved to a canonical role, because that is the
 * moment a reader sees a posting whose title contains none of their words
 * and concludes the search is broken.
 */
export function expansionNote(query: MarketSearchPage['query']): string | null {
  if (query.resolvedRole === null || query.q === null) {
    return null;
  }

  return `Also showing related titles for ${query.resolvedRole.replace(/-/g, ' ')}.`;
}

/**
 * The grouping note on a card, when one is needed.
 *
 * Only where the source itself grouped the postings. Never inferred.
 */
export function groupingNote(result: MarketSearchResult): string | null {
  return result.grouping.postings > 1
    ? `${result.grouping.postings} listings for this role at this employer`
    : null;
}

/**
 * The ranking explanation, as short readable lines.
 *
 * The server returns machine codes; this maps them to phrases. An unknown
 * code renders as itself rather than being dropped - a component the
 * client has not been taught about is still a reason the result is where
 * it is, and hiding it would make the explanation incomplete without
 * saying so.
 */
const COMPONENT_PHRASES: Record<string, string> = {
  TITLE_EXACT: 'Title matches exactly',
  TITLE_PREFIX: 'Title starts with your search',
  TITLE_ALL_TOKENS: 'Title contains every word',
  ROLE_EXACT: 'Same canonical role',
  TITLE_TOKEN: 'Words matched in the title',
  SEARCH_TOKEN: 'Words matched elsewhere',
  SKILL: 'Skills you asked for',
  LOCATION_EXACT: 'Location matches exactly',
  LOCATION_TOKENS: 'Location matches',
  RECENCY: 'Recently published',
};

export function explainRelevance(
  result: MarketSearchResult,
): Array<{ label: string; points: number }> {
  return result.relevance.components.map((component) => ({
    label: COMPONENT_PHRASES[component.code] ?? component.code,
    points: component.points,
  }));
}
