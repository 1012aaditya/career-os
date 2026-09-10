import { describe, expect, it } from 'vitest';

import type {
  Attribution,
  Authenticity,
  Completeness,
  EvidenceRecord,
} from './contract.js';
import {
  FRESHNESS_WINDOW_MS,
  classify,
  classifyRecord,
  corroborationOf,
  recencyOf,
  specificityOf,
} from './trust.js';

const NOW = new Date('2026-09-10T12:00:00.000Z');

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function record(
  over: Partial<EvidenceRecord> = {},
): EvidenceRecord {
  return {
    sourceType: 'GITHUB',
    title: 'repo',
    description: null,
    sourceUrl: 'https://github.com/u/repo',
    externalId: '101',
    occurredAt: daysAgo(400),
    capturedAt: daysAgo(10),
    lastObservedAt: daysAgo(1),
    authenticity: 'DIRECT_API_OBSERVATION',
    attribution: 'AUTHENTICATED_ACCOUNT',
    completeness: 'PARTIAL',
    transformVersion: 1,
    independenceKey: 'github:555',
    metadata: null,
    ...over,
  };
}

const resume = (over: Partial<EvidenceRecord> = {}) =>
  record({
    sourceType: 'RESUME',
    externalId: null,
    sourceUrl: null,
    occurredAt: null,
    authenticity: 'USER_CLAIM',
    attribution: 'USER_ASSERTED',
    completeness: 'UNKNOWN',
    independenceKey: 'resume:aaaaaaaa-0000-0000-0000-000000000001',
    ...over,
  });

describe('disqualifiers, checked before anything can award a class', () => {
  it('never promotes a weak name match, however direct the observation', () => {
    expect(
      classifyRecord(record({ attribution: 'WEAK_MATCH' }), NOW),
    ).toBe('UNVERIFIED');

    /* Even fresh, complete and direct - the disqualifier runs first. */
    expect(
      classifyRecord(
        record({ attribution: 'WEAK_MATCH', completeness: 'COMPLETE' }),
        NOW,
      ),
    ).toBe('UNVERIFIED');
  });

  it('never shows NOT_SCANNED as verified', () => {
    expect(
      classifyRecord(record({ completeness: 'NOT_SCANNED' }), NOW),
    ).toBe('UNVERIFIED');
  });

  it('never shows UNKNOWN completeness as verified', () => {
    expect(
      classifyRecord(record({ completeness: 'UNKNOWN' }), NOW),
    ).toBe('UNVERIFIED');
  });

  it('fails closed on an unrecognised state', () => {
    expect(
      classifyRecord(
        record({
          authenticity: 'SOMETHING_NEW' as unknown as Authenticity,
          attribution: 'ALSO_NEW' as unknown as Attribution,
        }),
        NOW,
      ),
    ).toBe('UNVERIFIED');
  });
});

describe('claims stay claims', () => {
  it('classifies a user claim as WEAK', () => {
    expect(
      classifyRecord(
        record({ authenticity: 'USER_CLAIM', completeness: 'PARTIAL' }),
        NOW,
      ),
    ).toBe('WEAK');
  });

  it('classifies user-asserted attribution as WEAK', () => {
    expect(
      classifyRecord(
        record({ attribution: 'USER_ASSERTED', completeness: 'PARTIAL' }),
        NOW,
      ),
    ).toBe('WEAK');
  });

  /*
   * The gate ordering that matters most. A producer declaring a direct
   * API observation over self-reported content must not thereby earn
   * STRONG - a resume fetched over an API is still a resume.
   */
  it('does not let DIRECT_API_OBSERVATION upgrade self-reported content', () => {
    expect(
      classifyRecord(
        record({
          authenticity: 'DIRECT_API_OBSERVATION',
          attribution: 'USER_ASSERTED',
          completeness: 'COMPLETE',
        }),
        NOW,
      ),
    ).toBe('WEAK');
  });

  it('treats a model interpretation as no stronger than a claim', () => {
    expect(
      classifyRecord(
        record({
          authenticity: 'MODEL_INTERPRETATION',
          completeness: 'COMPLETE',
        }),
        NOW,
      ),
    ).toBe('WEAK');
  });
});

describe('direct authenticated observation', () => {
  it('is STRONG when fresh and actually scanned', () => {
    expect(classifyRecord(record(), NOW)).toBe('STRONG');
    expect(
      classifyRecord(record({ completeness: 'COMPLETE' }), NOW),
    ).toBe('STRONG');
  });

  /*
   * PARTIAL is the normal state of every GitHub row - only the default
   * branch is visible - so demoting it would make STRONG unreachable by
   * any producer that exists.
   */
  it('accepts PARTIAL as scanned, but never as complete', () => {
    expect(
      classifyRecord(record({ completeness: 'PARTIAL' }), NOW),
    ).toBe('STRONG');

    /* Partial is still recorded as partial for anyone who asks. */
    expect(record({ completeness: 'PARTIAL' }).completeness).toBe(
      'PARTIAL',
    );
  });

  it('demotes a stale observation to MODERATE', () => {
    expect(
      classifyRecord(record({ lastObservedAt: daysAgo(400) }), NOW),
    ).toBe('MODERATE');
  });

  it('demotes ACCESS_LOST even when recently attempted', () => {
    expect(
      classifyRecord(record({ completeness: 'ACCESS_LOST' }), NOW),
    ).toBe('MODERATE');
  });

  it('demotes a direct observation whose attribution is weaker', () => {
    expect(
      classifyRecord(
        record({ attribution: 'EXPLICIT_AUTHORSHIP' }),
        NOW,
      ),
    ).toBe('MODERATE');
  });
});

describe('artifacts', () => {
  it('classifies verified and user-provided artifacts as MODERATE', () => {
    for (const authenticity of [
      'VERIFIED_ARTIFACT',
      'USER_PROVIDED_ARTIFACT',
    ] as const) {
      expect(
        classifyRecord(
          record({ authenticity, attribution: 'VERIFIED_OWNERSHIP' }),
          NOW,
        ),
      ).toBe('MODERATE');
    }
  });
});

describe('recency', () => {
  it('reads lastObservedAt, not occurredAt', () => {
    /*
     * Old work confirmed this morning is FRESH. If occurredAt were
     * consulted, a repository created in 2015 would read as abandoned
     * however recently we checked it.
     */
    expect(
      recencyOf(
        record({ occurredAt: daysAgo(4000), lastObservedAt: daysAgo(1) }),
        NOW,
      ),
    ).toBe('FRESH');

    /* And recent work not checked in years is STALE. */
    expect(
      recencyOf(
        record({ occurredAt: daysAgo(1), lastObservedAt: daysAgo(400) }),
        NOW,
      ),
    ).toBe('STALE');
  });

  it('falls back to capturedAt when never re-observed', () => {
    expect(
      recencyOf(
        record({ lastObservedAt: null, capturedAt: daysAgo(2) }),
        NOW,
      ),
    ).toBe('FRESH');
  });

  it('closes the boundary on the stale side', () => {
    const exactly = new Date(NOW.getTime() - FRESHNESS_WINDOW_MS);
    const oneMsFresher = new Date(
      NOW.getTime() - FRESHNESS_WINDOW_MS + 1,
    );

    expect(recencyOf(record({ lastObservedAt: exactly }), NOW)).toBe(
      'STALE',
    );
    expect(
      recencyOf(record({ lastObservedAt: oneMsFresher }), NOW),
    ).toBe('FRESH');
  });

  /*
   * The arithmetic is epoch subtraction, so an instant expressed in any
   * offset classifies identically. Calendar-month arithmetic would not:
   * it depends on the machine's zone and on which side of a DST change
   * the two dates fall.
   */
  it('does not depend on how an instant is written or on the local zone', () => {
    const utc = new Date('2026-09-09T12:00:00.000Z');
    const sameInstantInSydney = new Date('2026-09-09T22:00:00.000+10:00');
    const sameInstantInNewYork = new Date('2026-09-09T08:00:00.000-04:00');

    expect(sameInstantInSydney.getTime()).toBe(utc.getTime());

    for (const observed of [utc, sameInstantInSydney, sameInstantInNewYork]) {
      expect(classifyRecord(record({ lastObservedAt: observed }), NOW)).toBe(
        'STRONG',
      );
    }
  });
});

describe('specificity', () => {
  it('is SPECIFIC only when the row can be checked by someone else', () => {
    expect(specificityOf(record())).toBe('SPECIFIC');
  });

  it('is GENERAL when identifiable but not anchored in time', () => {
    expect(specificityOf(record({ occurredAt: null }))).toBe('GENERAL');
  });

  it('is VAGUE for a claim with no referent', () => {
    expect(specificityOf(resume())).toBe('VAGUE');
  });

  /* Prose is where a generous account of one's own work lives. */
  it('ignores description length', () => {
    expect(
      specificityOf(resume({ description: 'x'.repeat(5_000) })),
    ).toBe('VAGUE');
  });

  it('does not change the trust class', () => {
    const vagueButDirect = record({
      externalId: null,
      sourceUrl: null,
      occurredAt: null,
    });

    expect(specificityOf(vagueButDirect)).toBe('VAGUE');
    expect(classifyRecord(vagueButDirect, NOW)).toBe('STRONG');
  });
});

describe('corroboration counts sources, not rows', () => {
  it('treats fourteen repositories from one account as one source', () => {
    const repos = Array.from({ length: 14 }, (_v, i) =>
      record({ externalId: String(i), independenceKey: 'github:555' }),
    );

    expect(corroborationOf(repos, NOW).independentSources).toBe(1);
  });

  it('counts a resume and a github account as two', () => {
    expect(
      corroborationOf([record(), resume()], NOW).independentSources,
    ).toBe(2);
  });

  it('gives no corroboration to a missing independence key', () => {
    const unkeyed = [
      record({ independenceKey: null }),
      record({ externalId: '2', independenceKey: null }),
      record({ externalId: '3', independenceKey: '' }),
    ];

    expect(corroborationOf(unkeyed, NOW).independentSources).toBe(0);
  });

  /*
   * A disqualified row must not supply the second source that promotes
   * everything else - the weakest thing the system recognises cannot be
   * the thing that produces its highest class.
   */
  it('ignores keys carried by disqualified rows', () => {
    const withWeakMatch = [
      record(),
      record({
        attribution: 'WEAK_MATCH',
        independenceKey: 'linkedin:abc',
      }),
    ];

    expect(
      corroborationOf(withWeakMatch, NOW).independentSources,
    ).toBe(1);
  });

  it('returns keys sorted, so the result is stable', () => {
    const shuffled = [
      record({ independenceKey: 'github:555' }),
      resume(),
      record({ externalId: '9', independenceKey: 'github:111' }),
    ];

    expect(corroborationOf(shuffled, NOW).keys).toEqual([
      'github:111',
      'github:555',
      'resume:aaaaaaaa-0000-0000-0000-000000000001',
    ]);
  });
});

describe('classifying a set', () => {
  it('is UNVERIFIED for no evidence at all', () => {
    expect(classify([], NOW)).toBe('UNVERIFIED');
  });

  it('needs two independent sources for VERY_STRONG', () => {
    expect(classify([record()], NOW)).toBe('STRONG');
    expect(classify([record(), resume()], NOW)).toBe('VERY_STRONG');
  });

  it('does not reach VERY_STRONG on volume from one source', () => {
    const many = Array.from({ length: 14 }, (_v, i) =>
      record({ externalId: String(i), independenceKey: 'github:555' }),
    );

    expect(classify(many, NOW)).toBe('STRONG');
  });

  it('does not reach VERY_STRONG when the strong row has gone stale', () => {
    expect(
      classify(
        [record({ lastObservedAt: daysAgo(400) }), resume()],
        NOW,
      ),
    ).toBe('MODERATE');
  });

  it('takes the best row, so weak rows never drag a set down', () => {
    expect(classify([resume(), record()], NOW)).toBe('VERY_STRONG');
  });

  it('never adds weak rows up into something stronger', () => {
    const tenClaims = Array.from({ length: 10 }, (_v, i) =>
      resume({
        independenceKey: `resume:aaaaaaaa-0000-0000-0000-00000000000${i}`,
      }),
    );

    expect(classify(tenClaims, NOW)).toBe('WEAK');
  });

  it('is deterministic regardless of input order', () => {
    const set = [record(), resume(), record({ externalId: '77' })];
    const reversed = [...set].reverse();

    expect(classify(set, NOW)).toBe(classify(reversed, NOW));
    expect(corroborationOf(set, NOW)).toEqual(
      corroborationOf(reversed, NOW),
    );
  });

  it('is UNVERIFIED when every row was disqualified', () => {
    expect(
      classify(
        [
          record({ completeness: 'NOT_SCANNED' }),
          record({ attribution: 'WEAK_MATCH' }),
        ],
        NOW,
      ),
    ).toBe('UNVERIFIED');
  });
});

describe('what the classification refuses to say', () => {
  /*
   * The vocabulary check. No amount of evidence may produce a word about
   * a person's level - the classes describe how well something is KNOWN,
   * never what it makes the person.
   */
  it('has no vocabulary for seniority, expertise or leadership', () => {
    const everything: Completeness[] = [
      'COMPLETE',
      'PARTIAL',
      'NOT_SCANNED',
      'ACCESS_LOST',
      'UNKNOWN',
    ];

    const produced = new Set<string>();

    for (const completeness of everything) {
      produced.add(classify([record({ completeness }), resume()], NOW));
    }

    for (const value of produced) {
      expect(value).toMatch(
        /^(VERY_STRONG|STRONG|MODERATE|WEAK|UNVERIFIED)$/,
      );
      expect(value).not.toMatch(/SENIOR|EXPERT|LEAD|PROFICIEN|MASTER/i);
    }
  });
});
