import { describe, expect, it } from 'vitest';

import type { EvidenceItem, TrustClass } from './evidence-api';
import {
  AGE_LABELS,
  NO_FILTERS,
  ageBucket,
  applyFilters,
  emptyReason,
  evidenceViewState,
  sourceOptions,
} from './evidence-filters';
import {
  overviewOf,
  overviewSummary,
  strongestEvidence,
} from './evidence-summary';
import {
  STRENGTH_ORDER,
  STRENGTH_SCOPE_NOTE,
  doesNotEstablishStatements,
  provenanceOf,
  relativeTime,
  reliabilityRows,
  sourceLabel,
  strengthLabel,
  supportedStatement,
  timelineOf,
} from './evidence-view';

const NOW = new Date('2026-09-10T12:00:00.000Z');

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function github(over: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: 'a',
    sourceType: 'GITHUB',
    title: 'acme/payments-service',
    description: 'Handles settlement',
    sourceUrl: 'https://github.com/acme/payments-service',
    externalId: 'github:repo:1',
    occurredAt: daysAgo(700),
    capturedAt: daysAgo(30),
    lastObservedAt: daysAgo(2),
    reliability: {
      authenticity: 'DIRECT_API_OBSERVATION',
      attribution: 'AUTHENTICATED_ACCOUNT',
      completeness: 'PARTIAL',
      specificity: 'SPECIFIC',
      recency: 'FRESH',
      trustClass: 'STRONG',
      transformVersion: 1,
    },
    ...over,
  };
}

const resume = (over: Partial<EvidenceItem> = {}): EvidenceItem =>
  github({
    id: 'b',
    sourceType: 'RESUME',
    title: 'Resume: cv.pdf',
    description: 'Career information extracted from a confirmed resume.',
    sourceUrl: null,
    externalId: null,
    occurredAt: null,
    reliability: {
      authenticity: 'USER_CLAIM',
      attribution: 'USER_ASSERTED',
      completeness: 'UNKNOWN',
      specificity: 'VAGUE',
      recency: 'FRESH',
      trustClass: 'WEAK',
      transformVersion: 1,
    },
    ...over,
  });

describe('strength is described, never scored', () => {
  it('has a label and a meaning for every class', () => {
    for (const trustClass of STRENGTH_ORDER) {
      const label = strengthLabel(trustClass);

      expect(label.label).toBeTruthy();
      expect(label.meaning).toBeTruthy();
      expect(label.label).not.toMatch(/\d/);
    }
  });

  /*
   * The product rule, enforced on the strings themselves: nothing the UI
   * can show about strength may read as a percentage, a rating or a level.
   */
  it('never renders a number, a percentage or a rating', () => {
    for (const trustClass of STRENGTH_ORDER) {
      const { label, meaning } = strengthLabel(trustClass);

      expect(`${label} ${meaning}`).not.toMatch(
        /%|\/100|\bscore\b|\brating\b|\bout of \d/i,
      );
    }
  });

  it('says plainly that strength is not a verdict on the person', () => {
    expect(STRENGTH_SCOPE_NOTE).toMatch(/not how good the work is/i);
    expect(STRENGTH_SCOPE_NOTE).toMatch(/not your level/i);
  });

  it('tells an unverified user it is a gap in our coverage, not in them', () => {
    expect(strengthLabel('UNVERIFIED').meaning).toMatch(
      /not a statement about you/i,
    );
  });
});

describe('what evidence supports, and what it does not', () => {
  it('states the limits on every item, however strong', () => {
    for (const item of [
      github(),
      github({
        reliability: {
          ...github().reliability,
          trustClass: 'VERY_STRONG' as TrustClass,
        },
      }),
      resume(),
    ]) {
      const limits = doesNotEstablishStatements(item).join(' ');

      expect(limits).toMatch(/seniority/i);
      expect(limits).toMatch(/expertise/i);
      expect(limits).toMatch(/leadership/i);
    }
  });

  /*
   * The support statement restates a contract field and infers nothing.
   * If it ever starts claiming a skill or a level, this fails.
   */
  it('claims no skill, level or ability', () => {
    for (const item of [github(), resume()]) {
      expect(supportedStatement(item)).not.toMatch(
        /senior|expert|proficien|leader|skilled|talented|excellent/i,
      );
    }
  });

  it('distinguishes observed evidence from evidence you provided', () => {
    expect(provenanceOf(github().reliability)).toBe('observed');
    expect(provenanceOf(resume().reliability)).toBe('provided');

    expect(supportedStatement(github())).toMatch(/authenticated/i);
    expect(supportedStatement(resume())).toMatch(/yourself/i);

    expect(doesNotEstablishStatements(resume()).join(' ')).toMatch(
      /independent verification/i,
    );
  });
});

describe('why we trust this', () => {
  it('shows five dimensions, and corroboration only when known', () => {
    expect(reliabilityRows(github().reliability)).toHaveLength(5);
    expect(reliabilityRows(github().reliability, 2)).toHaveLength(6);
  });

  it('never presents a dimension as a number', () => {
    for (const row of reliabilityRows(github().reliability, 2)) {
      expect(row.value).not.toMatch(/%|\/100/);
      expect(row.detail).toBeTruthy();
    }
  });

  it('says NOT_SCANNED is not the same as finding nothing', () => {
    const rows = reliabilityRows({
      ...github().reliability,
      completeness: 'NOT_SCANNED',
    });

    const completeness = rows.find(
      (row) => row.dimension === 'Completeness',
    )!;

    expect(completeness.detail).toMatch(/not the same as finding nothing/i);
  });

  it('says several items from one source count once', () => {
    const single = reliabilityRows(github().reliability, 1).find(
      (row) => row.dimension === 'Corroboration',
    )!;

    expect(single.value).toBe('1 source');
    expect(single.detail).toMatch(/do not corroborate each other/i);
  });

  it('refuses to call a name match attribution', () => {
    const rows = reliabilityRows({
      ...github().reliability,
      attribution: 'WEAK_MATCH',
    });

    expect(
      rows.find((row) => row.dimension === 'Attribution')!.detail,
    ).toMatch(/not attribution/i);
  });
});

describe('time', () => {
  it('reads recency from the last confirmation, not from when work happened', () => {
    /* Old work, confirmed two days ago, is recent. */
    expect(ageBucket(github(), NOW)).toBe('RECENT');

    /* Recent work not confirmed for two years is historical. */
    expect(
      ageBucket(
        github({ occurredAt: daysAgo(1), lastObservedAt: daysAgo(730) }),
        NOW,
      ),
    ).toBe('HISTORICAL');
  });

  it('falls back to capture when never re-observed', () => {
    expect(
      ageBucket(
        github({ lastObservedAt: null, capturedAt: daysAgo(120) }),
        NOW,
      ),
    ).toBe('AGING');
  });

  it('renders nothing rather than "never" for a missing timestamp', () => {
    expect(relativeTime(null, NOW)).toBeNull();
    expect(relativeTime('not-a-date', NOW)).toBeNull();
  });

  it('describes ages in words a person uses', () => {
    expect(relativeTime(daysAgo(0), NOW)).toBe('today');
    expect(relativeTime(daysAgo(1), NOW)).toBe('yesterday');
    expect(relativeTime(daysAgo(12), NOW)).toBe('12 days ago');
    expect(relativeTime(daysAgo(400), NOW)).toBe('1 year ago');
  });

  it('lists only the moments that exist', () => {
    expect(timelineOf(github()).map((e) => e.label)).toEqual([
      'Occurred',
      'Captured',
      'Last observed',
    ]);

    /* A resume has no occurrence date, so the row is absent - not blank. */
    expect(timelineOf(resume()).map((e) => e.label)).toEqual([
      'Captured',
      'Last observed',
    ]);
  });

  it('has a label for every age bucket', () => {
    for (const bucket of ['RECENT', 'AGING', 'HISTORICAL', 'UNKNOWN'] as const) {
      expect(AGE_LABELS[bucket]).toBeTruthy();
    }
  });
});

describe('filtering', () => {
  const items = [github(), resume()];

  it('returns everything when nothing is filtered', () => {
    expect(applyFilters(items, NO_FILTERS, NOW)).toHaveLength(2);
  });

  it('filters by source', () => {
    const filtered = applyFilters(
      items,
      { ...NO_FILTERS, sourceType: 'GITHUB' },
      NOW,
    );

    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.sourceType).toBe('GITHUB');
  });

  it('filters by strength', () => {
    const filtered = applyFilters(
      items,
      { ...NO_FILTERS, strength: 'WEAK' },
      NOW,
    );

    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.sourceType).toBe('RESUME');
  });

  it('filters by age', () => {
    const aged = github({ id: 'c', lastObservedAt: daysAgo(700) });

    expect(
      applyFilters([...items, aged], { ...NO_FILTERS, age: 'HISTORICAL' }, NOW),
    ).toHaveLength(1);
  });

  it('searches title, description and source name', () => {
    expect(
      applyFilters(items, { ...NO_FILTERS, search: 'payments' }, NOW),
    ).toHaveLength(1);

    expect(
      applyFilters(items, { ...NO_FILTERS, search: 'settlement' }, NOW),
    ).toHaveLength(1);

    expect(
      applyFilters(items, { ...NO_FILTERS, search: 'resume' }, NOW),
    ).toHaveLength(1);
  });

  /*
   * The server returns a total order and the client must not invent
   * another. Filtering removes; it never sorts.
   */
  it('preserves the server order exactly', () => {
    const many = [
      github({ id: '1' }),
      resume({ id: '2' }),
      github({ id: '3' }),
      resume({ id: '4' }),
    ];

    expect(applyFilters(many, NO_FILTERS, NOW).map((i) => i.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);

    expect(
      applyFilters(many, { ...NO_FILTERS, sourceType: 'GITHUB' }, NOW).map(
        (i) => i.id,
      ),
    ).toEqual(['1', '3']);
  });

  it('offers only sources that are actually present', () => {
    expect(sourceOptions([github()])).toEqual([
      { value: 'GITHUB', label: 'GitHub' },
    ]);

    expect(sourceOptions([]).length).toBe(0);
  });

  it('tells "you have none" apart from "none match"', () => {
    expect(emptyReason(0, NO_FILTERS)).toBe('no-evidence');
    expect(emptyReason(0, { ...NO_FILTERS, search: 'zzz' })).toBe(
      'no-matches',
    );
    expect(emptyReason(5, { ...NO_FILTERS, strength: 'VERY_STRONG' })).toBe(
      'no-matches',
    );
  });
});

describe('screen state', () => {
  const base = {
    loading: false,
    error: null as string | null,
    total: 2,
    visible: 2,
    filters: NO_FILTERS,
  };

  it('is ready when there is something to show', () => {
    expect(evidenceViewState(base)).toBe('ready');
  });

  it('is loading before the first response', () => {
    expect(
      evidenceViewState({ ...base, loading: true, total: 0, visible: 0 }),
    ).toBe('loading');
  });

  it('is empty for a user with no evidence at all', () => {
    expect(evidenceViewState({ ...base, total: 0, visible: 0 })).toBe(
      'empty',
    );
  });

  it('is no-matches when a filter hid everything', () => {
    expect(
      evidenceViewState({
        ...base,
        visible: 0,
        filters: { ...NO_FILTERS, strength: 'VERY_STRONG' },
      }),
    ).toBe('no-matches');
  });

  /*
   * A retry keeps the error visible rather than flashing a spinner over
   * it and returning to the same message.
   */
  it('keeps showing an error even while retrying', () => {
    expect(
      evidenceViewState({ ...base, loading: true, error: 'Network error' }),
    ).toBe('error');
  });
});

describe('the home overview', () => {
  it('counts only what the API returned', () => {
    const overview = overviewOf({
      evidence: [github(), resume()],
      independentSources: 2,
      truncated: false,
    });

    expect(overview).toEqual({
      evidenceCount: 2,
      sourceCount: 2,
      corroborated: true,
      strongest: 'STRONG',
      truncated: false,
    });
  });

  /*
   * Source count is the SERVER's number. Fourteen repositories from one
   * account are one source, and the client cannot tell - the grouping key
   * is deliberately not sent.
   */
  it('uses the server source count rather than counting source types', () => {
    const overview = overviewOf({
      evidence: [github({ id: '1' }), github({ id: '2' }), github({ id: '3' })],
      independentSources: 1,
      truncated: false,
    });

    expect(overview.evidenceCount).toBe(3);
    expect(overview.sourceCount).toBe(1);
    expect(overview.corroborated).toBe(false);
  });

  it('is honest and calm when there is nothing yet', () => {
    const overview = overviewOf({
      evidence: [],
      independentSources: 0,
      truncated: false,
    });

    expect(overview.strongest).toBeNull();
    expect(overviewSummary(overview)).toBe('No evidence yet.');
  });

  it('carries truncation through', () => {
    expect(
      overviewOf({
        evidence: [github()],
        independentSources: 1,
        truncated: true,
      }).truncated,
    ).toBe(true);
  });

  it('summarises without implying a target or a percentage', () => {
    const summary = overviewSummary(
      overviewOf({
        evidence: [github(), resume()],
        independentSources: 2,
        truncated: false,
      }),
    );

    expect(summary).toBe('2 pieces of evidence from 2 independent sources.');
    expect(summary).not.toMatch(/%|complete|score/i);
  });

  it('ranks strongest first, breaking ties by server order', () => {
    const items = [
      resume({ id: 'weak-1' }),
      github({
        id: 'very-strong',
        reliability: {
          ...github().reliability,
          trustClass: 'VERY_STRONG',
        },
      }),
      github({ id: 'strong-1' }),
      github({ id: 'strong-2' }),
    ];

    expect(strongestEvidence(items, 3).map((i) => i.id)).toEqual([
      'very-strong',
      'strong-1',
      'strong-2',
    ]);
  });
});

describe('source names', () => {
  it('names the sources the app knows', () => {
    expect(sourceLabel('GITHUB')).toBe('GitHub');
    expect(sourceLabel('RESUME')).toBe('Resume');
  });

  it('shows an unknown source type rather than hiding it', () => {
    expect(sourceLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});
