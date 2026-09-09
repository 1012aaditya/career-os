import { apiRequest } from '../api/client';
import {
  buildSearchQuery,
  type MarketSearchParams,
} from './market-search-query';

/*
 * Market Search, as the app reads it.
 *
 * Every type mirrors what the API actually returns. Two things survive the
 * trip deliberately, because they are the difference between a job board
 * and Shipaton's market view:
 *
 *   `relevance.components` - why this result is where it is. The server
 *   ranks deterministically and explains itself; a client that kept only
 *   the total would throw the explanation away and there is no way to get
 *   it back.
 *
 *   `freshness` - a verdict AND the basis it rests on. "Posted 3 days ago"
 *   is a different claim from "we last saw this 3 days ago", and the app
 *   must never render the second as the first.
 *
 * Nothing here sends anything about the user. The market is the same for
 * everybody, and a search request that carried a profile would have
 * quietly become a recommendation.
 */

/** The Phase 8 vocabulary, unchanged. */
export type FreshnessVerdict = 'FRESH' | 'AGING' | 'STALE' | 'UNAVAILABLE';

export type MarketFreshness = {
  verdict: FreshnessVerdict;
  /**
   * SOURCE_STATED when the employer's own deadline decided the verdict,
   * DEFAULT when it rests on our configured guess at how long a posting
   * stays live. Rendered, not hidden: a verdict resting on a guess is
   * identifiable at the point somebody reads it.
   */
  lifetimeBasis: 'SOURCE_STATED' | 'DEFAULT';
  lastObservedAt: string;
  expectedLiveUntil: string;
};

export type RelevanceComponent = {
  code: string;
  count: number;
  weight: number;
  points: number;
};

export type MarketSearchResult = {
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  role: string | null;
  skills: string[];
  sourcePublishedAt: string | null;
  source: { slug: string };
  freshness: MarketFreshness;
  /**
   * How many postings this one result stands for. Greater than 1 only
   * where the SOURCE itself said they are one requisition.
   */
  grouping: { postings: number; basis: 'SOURCE_ASSERTED_GROUP' | 'NONE' };
  relevance: { total: number; components: RelevanceComponent[] };
  applyUrl: string | null;
};

export type MarketSearchPage = {
  query: {
    q: string | null;
    normalized: string | null;
    tokens: string[];
    /**
     * The canonical role the QUERY resolved to.
     *
     * Rendered when present, because a result set widened by a role
     * expansion is otherwise inexplicable: the reader sees postings whose
     * titles do not contain their words and has no way to know why.
     */
    resolvedRole: string | null;
    roleResolution: 'ALIAS' | 'UNRESOLVED' | null;
    location: string | null;
  };
  results: MarketSearchResult[];
  page: {
    limit: number;
    returned: number;
    /** Distinct results, which is what the reader is shown. */
    totalGroups: number;
    /** Postings behind them. Always >= totalGroups. */
    totalPostings: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
  basis: {
    projectionVersion: number;
    rulesetVersion: number;
    rankingVersion: number;
    sort: string;
    asOf: string;
    asOfDay: string;
    searchableSources: string[];
  };
};

export type MarketPostingDetail = {
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  role: { slug: string; label: string } | null;
  skills: Array<{ slug: string; label: string }>;
  description: string | null;
  sourcePublishedAt: string | null;
  sourceValidThrough: string | null;
  freshness: MarketFreshness & { asOf: string };
  provenance: {
    source: {
      slug: string;
      displayName: string;
      licenceBasis: string;
      /*
       * The credit this source's permission obliges us to display, or
       * null where none is required.
       *
       * This field used to be `licenceNote`, which was our own internal
       * reasoning about a licence and was never rendered. Phase 11
       * replaced it with the string a licence actually asks for - and the
       * screen now shows it, because several of these sources are used
       * under licences whose only condition is that the credit appears.
       */
      attribution: string | null;
    } | null;
    firstObservedAt: string;
    lastObservedAt: string;
  };
  applyUrl: string | null;
};

export async function searchMarket(
  params: MarketSearchParams,
): Promise<MarketSearchPage> {
  const response = await apiRequest<{ data: MarketSearchPage }>(
    `/market/search${buildSearchQuery(params)}`,
  );

  return response.data;
}

export async function fetchPosting(id: string): Promise<MarketPostingDetail> {
  const response = await apiRequest<{ data: MarketPostingDetail }>(
    `/market/postings/${encodeURIComponent(id)}`,
  );

  return response.data;
}

export { buildSearchQuery, type MarketSearchParams };
