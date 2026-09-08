import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../../common/canonical-json.js';
import { type ObservedPosting, projectSignals } from './signal-projection.js';

const FLOORS = { minDenominator: 3, minDistinctCompanies: 2 };

function posting(over: Partial<ObservedPosting> = {}): ObservedPosting {
  return {
    postingId: 'p1',
    roleId: 'role-backend',
    companyNormalized: 'acme',
    sourceId: 'src-1',
    eligibleForPrevalence: true,
    skillIds: ['typescript'],
    ...over,
  };
}

/** n postings for one role, spread across `companies` distinct employers. */
function cohort(
  count: number,
  skillsFor: (index: number) => string[],
  companies = 4,
): ObservedPosting[] {
  return Array.from({ length: count }, (_, index) =>
    posting({
      postingId: `p${index}`,
      companyNormalized: `company-${index % companies}`,
      skillIds: skillsFor(index),
    }),
  );
}

describe('prevalence', () => {
  it('reports a numerator and a denominator, and no ratio at all', () => {
    const { signals } = projectSignals(
      cohort(10, (index) => (index < 6 ? ['typescript'] : [])),
      FLOORS,
    );

    const prevalence = signals.find(
      (signal) => signal.signalType === 'ROLE_SKILL_PREVALENCE',
    );

    expect(prevalence).toMatchObject({
      skillId: 'typescript',
      numeratorCount: 6,
      denominatorCount: 10,
    });

    /*
     * The absence is the assertion. A stored float would detach the number
     * from its sample - 3/7 and 429/1001 both round to 0.4286 and only one
     * of them is a signal - and it is the surface a "demand score" grows
     * on. Every number here must be a whole count.
     */
    for (const [key, value] of Object.entries(prevalence ?? {})) {
      if (typeof value === 'number') {
        expect(
          `${key}=${Number.isInteger(value)}`,
          `${key} must be an integer count`,
        ).toBe(`${key}=true`);
      }
    }

    expect(prevalence).not.toHaveProperty('ratio');
    expect(prevalence).not.toHaveProperty('prevalence');
    expect(prevalence).not.toHaveProperty('score');
    expect(prevalence).not.toHaveProperty('confidence');
  });

  it('counts a posting once however many times it names a skill', () => {
    const { signals } = projectSignals(
      cohort(5, () => ['typescript', 'typescript', 'typescript']),
      FLOORS,
    );

    const prevalence = signals.find(
      (signal) => signal.signalType === 'ROLE_SKILL_PREVALENCE',
    );

    expect(prevalence?.numeratorCount).toBe(5);
  });

  /*
   * The denominator is the load-bearing part. A posting we could not read
   * is not a posting with no requirements, and counting it would make
   * prevalence a statement about our fetch strategy.
   */
  it('excludes unreadable postings from the denominator, not from volume', () => {
    const postings = [
      ...cohort(4, () => ['typescript']),
      posting({
        postingId: 'unreadable',
        companyNormalized: 'company-9',
        eligibleForPrevalence: false,
        skillIds: [],
      }),
    ];

    const { signals, stats } = projectSignals(postings, FLOORS);

    const prevalence = signals.find(
      (signal) => signal.signalType === 'ROLE_SKILL_PREVALENCE',
    );
    const volume = signals.find(
      (signal) => signal.signalType === 'ROLE_POSTING_VOLUME',
    );

    expect(prevalence?.denominatorCount).toBe(4);
    /* Still a posting, so still counted as one. */
    expect(volume?.numeratorCount).toBe(5);
    expect(stats.postingsExcludedNotEligible).toBe(1);
  });
});

describe('the publication floor', () => {
  it('writes no prevalence row below the minimum sample', () => {
    const { signals, stats } = projectSignals(
      cohort(2, () => ['typescript']),
      FLOORS,
    );

    expect(
      signals.filter((signal) => signal.signalType === 'ROLE_SKILL_PREVALENCE'),
    ).toHaveLength(0);
    expect(stats.prevalencePairsSuppressed).toBe(1);
  });

  /*
   * The floor that matters most: without it, one employer's board is
   * published as "the market".
   */
  it('writes no prevalence row drawn from a single employer', () => {
    const singleEmployer = cohort(10, () => ['typescript'], 1);

    const { signals, stats } = projectSignals(singleEmployer, FLOORS);

    expect(
      signals.filter((signal) => signal.signalType === 'ROLE_SKILL_PREVALENCE'),
    ).toHaveLength(0);
    expect(stats.prevalencePairsSuppressed).toBe(1);
  });

  it('still reports volume for a role too small to publish prevalence for', () => {
    const { signals } = projectSignals(
      cohort(2, () => ['typescript']),
      FLOORS,
    );

    const volume = signals.find(
      (signal) => signal.signalType === 'ROLE_POSTING_VOLUME',
    );

    /*
     * "We have barely seen this role" reads correctly. "This role requires
     * nothing" would not, which is why volume is never suppressed.
     */
    expect(volume?.numeratorCount).toBe(2);
  });
});

describe('volume', () => {
  /*
   * A numerator equal to its denominator would make any generic renderer
   * display every volume as 100%.
   */
  it('is a share of everything we tried to resolve, never a count of itself', () => {
    const postings = [
      ...cohort(4, () => []),
      posting({ postingId: 'x', roleId: null, skillIds: [] }),
    ];

    const { signals } = projectSignals(postings, FLOORS);
    const volume = signals.find(
      (signal) => signal.signalType === 'ROLE_POSTING_VOLUME',
    );

    expect(volume?.numeratorCount).toBe(4);
    expect(volume?.denominatorCount).toBe(5);
    expect(volume?.numeratorCount).not.toBe(volume?.denominatorCount);
  });

  it('counts an unresolved title without attaching it to a role', () => {
    const { stats } = projectSignals(
      [posting(), posting({ postingId: 'x', roleId: null })],
      FLOORS,
    );

    expect(stats.postingsRoleUnresolved).toBe(1);
    expect(stats.postingsRoleResolved).toBe(1);
  });
});

describe('company counting', () => {
  it('does not treat an unstated employer as a distinct one', () => {
    const { signals } = projectSignals(
      [
        posting({ postingId: 'a', companyNormalized: 'acme' }),
        posting({ postingId: 'b', companyNormalized: null }),
        posting({ postingId: 'c', companyNormalized: null }),
      ],
      { minDenominator: 1, minDistinctCompanies: 1 },
    );

    const volume = signals.find(
      (signal) => signal.signalType === 'ROLE_POSTING_VOLUME',
    );

    /*
     * Counting nulls would inflate the very number that exists to reveal
     * a single-employer sample.
     */
    expect(volume?.distinctCompanyCount).toBe(1);
  });
});

describe('determinism', () => {
  it('produces byte-identical output from a reversed input', () => {
    const postings = cohort(8, (index) =>
      index % 2 === 0 ? ['typescript', 'react'] : ['postgresql'],
    );

    const forward = projectSignals(postings, FLOORS);
    const reversed = projectSignals([...postings].reverse(), FLOORS);

    expect(canonicalJson(reversed)).toBe(canonicalJson(forward));
  });

  it('emits signals in an order it decided, not the order they arrived', () => {
    const { signals } = projectSignals(
      cohort(6, () => ['typescript', 'aws', 'postgresql']),
      FLOORS,
    );

    const prevalence = signals
      .filter((signal) => signal.signalType === 'ROLE_SKILL_PREVALENCE')
      .map((signal) => signal.skillId);

    expect(prevalence).toEqual(['aws', 'postgresql', 'typescript']);
  });

  it('is unaffected by the order one posting lists its own skills', () => {
    const forward = projectSignals(
      cohort(4, () => ['typescript', 'aws']),
      FLOORS,
    );
    const swapped = projectSignals(
      cohort(4, () => ['aws', 'typescript']),
      FLOORS,
    );

    expect(canonicalJson(swapped)).toBe(canonicalJson(forward));
  });

  it('returns nothing at all rather than guessing from no observations', () => {
    const { signals, stats } = projectSignals([], FLOORS);

    expect(signals).toEqual([]);
    expect(stats.postingsInWindow).toBe(0);
  });
});
