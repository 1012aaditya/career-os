/*
 * The search query string, built here and nowhere else.
 *
 * Its own module so it can be tested in plain Node. It imports nothing
 * at runtime - no API client, no Supabase, no environment - which is what
 * lets the pure suite cover it without a React Native harness. Putting it
 * next to `apiRequest` would have made testing it require booting the
 * client, and the thing worth testing is exactly this: which parameters
 * are sent, how they are escaped, and which are left out.
 */

import type { FreshnessVerdict } from './market-search-api';

export type MarketSearchParams = {
  q?: string;
  location?: string;
  role?: string;
  skills?: string[];
  sources?: string[];
  freshness?: FreshnessVerdict[];
  sort?: 'relevance' | 'published';
  limit?: number;
  cursor?: string;
};

/**
 * The query string, built here and nowhere else.
 *
 * Exported so it can be tested without a network. Empty values are
 * omitted rather than sent blank: the API refuses an unknown parameter,
 * and `?q=` is a filter on the empty string rather than an absent filter.
 */
export function buildSearchQuery(params: MarketSearchParams): string {
  const parts: string[] = [];

  const append = (key: string, value: string) => {
    if (value.trim() === '') {
      return;
    }

    parts.push(`${key}=${encodeURIComponent(value)}`);
  };

  if (params.q !== undefined) append('q', params.q);
  if (params.location !== undefined) append('location', params.location);
  if (params.role !== undefined) append('role', params.role);
  if (params.sort !== undefined) append('sort', params.sort);
  if (params.cursor !== undefined) append('cursor', params.cursor);

  if (params.limit !== undefined) {
    parts.push(`limit=${params.limit}`);
  }

  /* Repeated, not comma-joined: the API reads a repeated parameter. */
  for (const skill of params.skills ?? []) append('skills', skill);
  for (const source of params.sources ?? []) append('sources', source);
  for (const verdict of params.freshness ?? []) append('freshness', verdict);

  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}
