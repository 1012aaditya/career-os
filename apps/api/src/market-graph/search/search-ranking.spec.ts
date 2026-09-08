import { describe, expect, it } from 'vitest';

import {
  asOfDay,
  recencyPoints,
  relevanceFrom,
  RELEVANCE_COMPONENT_CODES,
  type RelevanceFacts,
} from './search-ranking.js';
import {
  MAX_FILTER_VALUES,
  RECENCY_BANDS,
  RELEVANCE_WEIGHTS,
} from './search-ruleset.js';

/*
 * The ordering, as arithmetic.
 *
 * The claim this file defends is that "why did A rank above B" always has
 * an answer a reader can check by hand. That is only true if the score is
 * a sum of named facts, if the sum is integer, and if the tiers are far
 * enough apart that a strong signal cannot be outvoted by an accumulation
 * of weak ones. Each of those is asserted here.
 */

function facts(over: Partial<RelevanceFacts> = {}): RelevanceFacts {
  return {
    titleExact: false,
    titlePrefix: false,
    titleAllTokens: false,
    roleExact: false,
    titleTokenHits: 0,
    searchTokenHits: 0,
    skillHits: 0,
    locationExact: false,
    locationAllTokens: false,
    recencyPoints: 0,
    ...over,
  };
}

describe('the score is a sum of named facts', () => {
  it('is zero when nothing matched, rather than a floor', () => {
    const relevance = relevanceFrom(facts());

    expect(relevance.total).toBe(0);
    expect(relevance.components).toEqual([]);
  });

  it('lists only the components that actually contributed', () => {
    const relevance = relevanceFrom(facts({ roleExact: true, skillHits: 2 }));

    expect(relevance.components.map((component) => component.code)).toEqual([
      'ROLE_EXACT',
      'SKILL',
    ]);
  });

  it('reports each component as count times weight, so it can be checked', () => {
    const relevance = relevanceFrom(facts({ skillHits: 3 }));
    const skill = relevance.components[0];

    expect(skill).toEqual({
      code: 'SKILL',
      count: 3,
      weight: RELEVANCE_WEIGHTS.SKILL,
      points: 3 * RELEVANCE_WEIGHTS.SKILL,
    });
    expect(relevance.total).toBe(skill?.points);
  });

  it('produces a total that is exactly the sum of its parts', () => {
    const relevance = relevanceFrom(
      facts({
        titleExact: true,
        titleAllTokens: true,
        roleExact: true,
        titleTokenHits: 2,
        searchTokenHits: 2,
        locationExact: true,
        recencyPoints: 40,
      }),
    );

    expect(relevance.total).toBe(
      relevance.components.reduce((sum, part) => sum + part.points, 0),
    );
  });

  it('is always an integer, whatever the facts', () => {
    const relevance = relevanceFrom(
      facts({ titleTokenHits: 7, searchTokenHits: 11, skillHits: 5 }),
    );

    expect(Number.isInteger(relevance.total)).toBe(true);
  });
});

describe('exact match beats weaker match', () => {
  /*
   * The property section 10 asks for, stated as an inequality over the
   * WEIGHTS rather than demonstrated on one example - so it holds for
   * every query length and every corpus rather than for the case that
   * happened to be written down.
   *
   * A document whose title IS the query necessarily also matches the
   * prefix, contains every token, and hits every token in both token
   * lists. So those components are shared and cancel. What an exact match
   * might lack, and a rival might have, is exactly: the canonical role,
   * every requested skill, both location components, and the top recency
   * band. TITLE_EXACT has to beat all of those together.
   *
   * The first version of this test compared a bare exact match against a
   * saturated rival and failed - correctly, because it was asserting
   * something stronger than the design provides and stronger than it
   * needs to. The shared components are not optional extras a rival can
   * win; they come with the exact match by construction.
   */
  it('outweighs every component an exact title match does not already imply', () => {
    const bestRivalAdvantage =
      RELEVANCE_WEIGHTS.ROLE_EXACT +
      RELEVANCE_WEIGHTS.SKILL * MAX_FILTER_VALUES +
      RELEVANCE_WEIGHTS.LOCATION_EXACT +
      RELEVANCE_WEIGHTS.LOCATION_TOKENS +
      (RECENCY_BANDS[0]?.points ?? 0);

    expect(RELEVANCE_WEIGHTS.TITLE_EXACT).toBeGreaterThan(bestRivalAdvantage);
  });

  it('ranks an exact title above the strongest possible non-exact rival', () => {
    /*
     * The same claim as a scenario, on a two-token query. The exact match
     * has nothing but its title; the rival has everything else a posting
     * can have.
     */
    const exact = relevanceFrom(
      facts({
        titleExact: true,
        titlePrefix: true,
        titleAllTokens: true,
        titleTokenHits: 2,
        searchTokenHits: 2,
      }),
    ).total;

    const rival = relevanceFrom(
      facts({
        titlePrefix: true,
        titleAllTokens: true,
        roleExact: true,
        titleTokenHits: 2,
        searchTokenHits: 2,
        skillHits: MAX_FILTER_VALUES,
        locationExact: true,
        locationAllTokens: true,
        recencyPoints: RECENCY_BANDS[0]?.points ?? 0,
      }),
    ).total;

    expect(exact).toBeGreaterThan(rival);
  });

  it('ranks a title match above a role-only match', () => {
    expect(relevanceFrom(facts({ titleExact: true })).total).toBeGreaterThan(
      relevanceFrom(facts({ roleExact: true })).total,
    );
  });

  it('ranks a prefix match above token hits alone', () => {
    expect(relevanceFrom(facts({ titlePrefix: true })).total).toBeGreaterThan(
      relevanceFrom(facts({ titleTokenHits: 3, searchTokenHits: 3 })).total,
    );
  });

  it('ranks a location match above recency, so where beats when', () => {
    expect(relevanceFrom(facts({ locationExact: true })).total).toBeGreaterThan(
      relevanceFrom(facts({ recencyPoints: RECENCY_BANDS[0]?.points ?? 0 }))
        .total,
    );
  });
});

describe('the explanation is itself deterministic', () => {
  it('orders components identically for identical facts', () => {
    const input = facts({ roleExact: true, skillHits: 8, recencyPoints: 20 });

    expect(relevanceFrom(input)).toEqual(relevanceFrom(input));
  });

  it('breaks a points tie by code, never by insertion order', () => {
    /*
     * ROLE_EXACT is 200. Eight skills at 25 is also 200. Without an
     * explicit tie-break the two would appear in whichever order the
     * component table happens to list them, and the explanation would
     * differ between builds for the same facts.
     */
    const relevance = relevanceFrom(facts({ roleExact: true, skillHits: 8 }));
    const tied = relevance.components.filter(
      (component) => component.points === 200,
    );

    expect(tied.map((component) => component.code)).toEqual([
      'ROLE_EXACT',
      'SKILL',
    ]);
  });

  it('names every component the ruleset declares, so none can go unexplained', () => {
    expect(RELEVANCE_COMPONENT_CODES).toEqual([
      'TITLE_EXACT',
      'TITLE_PREFIX',
      'TITLE_ALL_TOKENS',
      'ROLE_EXACT',
      'TITLE_TOKEN',
      'SEARCH_TOKEN',
      'SKILL',
      'LOCATION_EXACT',
      'LOCATION_TOKENS',
      'RECENCY',
    ]);
  });
});

describe('recency is measured from the publisher, and quantized', () => {
  const day = asOfDay(new Date('2026-09-09T17:43:11.004Z'));

  it('quantizes an instant to midnight UTC', () => {
    expect(day.toISOString()).toBe('2026-09-09T00:00:00.000Z');
  });

  it('gives the same answer at any hour of the same day', () => {
    /*
     * The property that makes a cursor survive a session. With a live
     * clock a posting published exactly seven days ago would cross a band
     * edge mid-session, reordering results underneath a cursor already
     * handed out.
     */
    expect(asOfDay(new Date('2026-09-09T00:00:00.000Z'))).toEqual(
      asOfDay(new Date('2026-09-09T23:59:59.999Z')),
    );
  });

  it.each([
    ['2026-09-09T00:00:00.000Z', 40],
    ['2026-09-02T00:00:00.000Z', 40],
    ['2026-09-01T00:00:00.000Z', 20],
    ['2026-08-10T00:00:00.000Z', 20],
    ['2026-08-01T00:00:00.000Z', 5],
    ['2026-06-11T00:00:00.000Z', 5],
    ['2026-06-01T00:00:00.000Z', 0],
    ['2014-12-18T00:00:00.000Z', 0],
  ])('scores a posting published %s at %i', (published, points) => {
    expect(recencyPoints(new Date(published), day)).toBe(points);
  });

  it('scores an unstated publication date at zero, never at a middling guess', () => {
    expect(recencyPoints(null, day)).toBe(0);
  });

  it('does not bury a posting for being dated in the future', () => {
    expect(recencyPoints(new Date('2026-12-01T00:00:00.000Z'), day)).toBe(
      RECENCY_BANDS[0]?.points,
    );
  });
});
