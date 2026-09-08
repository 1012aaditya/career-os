import { describe, expect, it } from 'vitest';

import type { MarketSearchResult } from './market-search-api';
import { buildSearchQuery } from './market-search-query';
import {
  employerLabel,
  expansionNote,
  explainRelevance,
  freshnessCaveat,
  freshnessLabel,
  groupingNote,
  publishedLabel,
  resultCountLabel,
  resultSubtitle,
} from './market-search-view';

/*
 * What the screen is allowed to say.
 *
 * The Market Graph is heterogeneous on purpose - 70% of this corpus has
 * no employer name, 41% has no canonical role, 96% has no extracted skill
 * - so the interesting cases here are all the ABSENT ones. Every test
 * below is a check that a missing fact renders as missing rather than as
 * a plausible-looking invention.
 */

function result(over: Partial<MarketSearchResult> = {}): MarketSearchResult {
  return {
    id: 'p1',
    title: 'Backend Engineer',
    company: 'Acme',
    location: 'Toronto',
    role: 'backend-engineer',
    skills: [],
    sourcePublishedAt: '2026-09-01T00:00:00.000Z',
    source: { slug: 'jobtech' },
    freshness: {
      verdict: 'FRESH',
      lifetimeBasis: 'SOURCE_STATED',
      lastObservedAt: '2026-09-08T00:00:00.000Z',
      expectedLiveUntil: '2026-10-01T00:00:00.000Z',
    },
    grouping: { postings: 1, basis: 'NONE' },
    relevance: { total: 0, components: [] },
    applyUrl: 'https://example.invalid/apply',
    ...over,
  };
}

describe('a missing fact renders as missing', () => {
  it('drops an absent employer rather than naming one', () => {
    expect(employerLabel(result({ company: null }))).toBeNull();
    expect(resultSubtitle(result({ company: null }))).toBe('Toronto');
  });

  it('treats a blank employer the same as an absent one', () => {
    expect(employerLabel(result({ company: '   ' }))).toBeNull();
  });

  it('drops an absent location', () => {
    expect(resultSubtitle(result({ location: null }))).toBe('Acme');
  });

  it('says nothing at all when both are absent', () => {
    expect(resultSubtitle(result({ company: null, location: null }))).toBe('');
  });

  it('returns no date label rather than calling an undated posting recent', () => {
    expect(
      publishedLabel(null, new Date('2026-09-09T00:00:00.000Z')),
    ).toBeNull();
  });

  it('returns no date label for an unparseable date', () => {
    expect(
      publishedLabel('not-a-date', new Date('2026-09-09T00:00:00.000Z')),
    ).toBeNull();
  });
});

describe('dates are relative to a clock that is passed in', () => {
  const now = new Date('2026-09-09T12:00:00.000Z');

  it.each([
    ['2026-09-09T00:00:00.000Z', 'Posted today'],
    ['2026-09-08T00:00:00.000Z', 'Posted yesterday'],
    ['2026-09-02T00:00:00.000Z', 'Posted 7 days ago'],
    ['2026-07-09T00:00:00.000Z', 'Posted 2 months ago'],
    ['2014-12-18T00:00:00.000Z', 'Posted 11 years ago'],
  ])('renders %s as %s', (published, expected) => {
    expect(publishedLabel(published, now)).toBe(expected);
  });

  it('does not render a future date as an age', () => {
    expect(publishedLabel('2026-12-01T00:00:00.000Z', now)).toBe(
      'Posted today',
    );
  });
});

describe('freshness is reported, never reinterpreted', () => {
  it.each([
    ['FRESH', 'Seen recently'],
    ['AGING', 'May still be open'],
    ['STALE', 'Likely closed'],
    ['UNAVAILABLE', 'Not recently checked'],
  ] as const)('labels %s as %s', (verdict, text) => {
    expect(freshnessLabel(verdict).text).toBe(text);
  });

  /*
   * The one that matters. UNAVAILABLE is a statement about OUR coverage,
   * not about the job, and rendering it as "no longer listed" would
   * report a rate limit as a closed vacancy.
   */
  it('never says an unavailable posting is closed', () => {
    const label = freshnessLabel('UNAVAILABLE');

    expect(label.text.toLowerCase()).not.toContain('closed');
    expect(label.text.toLowerCase()).not.toContain('expired');
    expect(label.text.toLowerCase()).not.toContain('gone');
  });

  it('explains an unavailable verdict in words', () => {
    expect(
      freshnessCaveat({ verdict: 'UNAVAILABLE', lifetimeBasis: 'DEFAULT' }),
    ).toContain('not been able to confirm');
  });

  it('says when a stale verdict rests on our guess rather than the employer', () => {
    expect(
      freshnessCaveat({ verdict: 'STALE', lifetimeBasis: 'DEFAULT' }),
    ).toContain('not on a date the employer gave');
  });

  it('adds no caveat where the employer stated the deadline', () => {
    expect(
      freshnessCaveat({ verdict: 'STALE', lifetimeBasis: 'SOURCE_STATED' }),
    ).toBeNull();
  });

  it('adds no caveat to a healthy posting', () => {
    expect(
      freshnessCaveat({ verdict: 'FRESH', lifetimeBasis: 'SOURCE_STATED' }),
    ).toBeNull();
  });
});

describe('counts say what they count', () => {
  it('reports groups, and postings only when the two differ', () => {
    expect(
      resultCountLabel({
        limit: 20,
        returned: 20,
        totalGroups: 1284,
        totalPostings: 1284,
        hasMore: true,
        nextCursor: 'x',
      }),
    ).toBe('1,284 jobs');

    expect(
      resultCountLabel({
        limit: 20,
        returned: 20,
        totalGroups: 1100,
        totalPostings: 1284,
        hasMore: true,
        nextCursor: 'x',
      }),
    ).toBe('1,100 jobs · 1,284 postings');
  });

  it('says none rather than zero', () => {
    expect(
      resultCountLabel({
        limit: 20,
        returned: 0,
        totalGroups: 0,
        totalPostings: 0,
        hasMore: false,
        nextCursor: null,
      }),
    ).toBe('No jobs found');
  });

  it('uses the singular for one job', () => {
    expect(
      resultCountLabel({
        limit: 20,
        returned: 1,
        totalGroups: 1,
        totalPostings: 1,
        hasMore: false,
        nextCursor: null,
      }),
    ).toBe('1 job');
  });
});

describe('the reader is told why unexpected results appear', () => {
  it('names the canonical role when the query resolved to one', () => {
    expect(
      expansionNote({
        q: 'backend developer',
        normalized: 'backend developer',
        tokens: ['backend', 'developer'],
        resolvedRole: 'backend-engineer',
        roleResolution: 'ALIAS',
        location: null,
      }),
    ).toBe('Also showing related titles for backend engineer.');
  });

  it('says nothing when the query resolved to no role', () => {
    expect(
      expansionNote({
        q: 'widget wrangler',
        normalized: 'widget wrangler',
        tokens: ['widget', 'wrangler'],
        resolvedRole: null,
        roleResolution: 'UNRESOLVED',
        location: null,
      }),
    ).toBeNull();
  });

  it('notes a grouping only where the source asserted one', () => {
    expect(
      groupingNote(
        result({ grouping: { postings: 3, basis: 'SOURCE_ASSERTED_GROUP' } }),
      ),
    ).toContain('3 listings');

    expect(groupingNote(result())).toBeNull();
  });

  it('renders a ranking component the client does not recognise, rather than hiding it', () => {
    /*
     * An explanation that silently omits a component is an explanation
     * that does not add up to the total beside it.
     */
    const lines = explainRelevance(
      result({
        relevance: {
          total: 1200,
          components: [
            { code: 'TITLE_EXACT', count: 1, weight: 1000, points: 1000 },
            { code: 'SOME_FUTURE_SIGNAL', count: 1, weight: 200, points: 200 },
          ],
        },
      }),
    );

    expect(lines).toEqual([
      { label: 'Title matches exactly', points: 1000 },
      { label: 'SOME_FUTURE_SIGNAL', points: 200 },
    ]);
  });
});

describe('the query string', () => {
  it('omits an absent filter rather than sending it blank', () => {
    expect(buildSearchQuery({ q: 'cook', location: '' })).toBe('?q=cook');
  });

  it('repeats a multi-valued filter, as the API reads it', () => {
    expect(buildSearchQuery({ skills: ['python', 'sql'] })).toBe(
      '?skills=python&skills=sql',
    );
  });

  it('escapes a value that would otherwise change the query', () => {
    expect(buildSearchQuery({ q: 'c++ & rust' })).toBe(
      '?q=c%2B%2B%20%26%20rust',
    );
  });

  it('carries a cursor verbatim', () => {
    expect(buildSearchQuery({ q: 'cook', cursor: 'abc-_123' })).toBe(
      '?q=cook&cursor=abc-_123',
    );
  });

  it('is empty when nothing was asked for', () => {
    expect(buildSearchQuery({})).toBe('');
  });
});
