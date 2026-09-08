/*
 * Observations in, signals out. Pure.
 *
 * No database, no clock, no randomness. Every number here is an integer
 * count, and the arithmetic is addition of integers - so two runs over the
 * same inputs produce byte-identical output regardless of the order the
 * inputs arrive in or the order a database returned them.
 *
 * There is no ratio anywhere in this file. A ratio is a lossy projection:
 * 3/7 and 429/1001 both round to 0.4286 and only one of them is a signal.
 * Consumers divide at the point of display, where the denominator is still
 * in front of them.
 */

/** Bumped when this file would compute a different number from the same rows. */
export const COMPUTATION_VERSION = 1;

export type SignalType = 'ROLE_POSTING_VOLUME' | 'ROLE_SKILL_PREVALENCE';

/**
 * One posting, as of the version of its latest sighting inside the window.
 */
export type ObservedPosting = {
  postingId: string;
  /** Null when the title did not resolve. Counted, never dropped. */
  roleId: string | null;
  companyNormalized: string | null;
  sourceId: string;
  /**
   * Whether this posting was in a position to express skills at all -
   * the description was readable AND complete.
   *
   * A posting we could not read is not a posting with no requirements, so
   * it is excluded from the prevalence denominator rather than counted as
   * a zero. It still counts toward volume, because it is still a posting.
   */
  eligibleForPrevalence: boolean;
  /** Distinct canonical skills mentioned. Order is irrelevant to the result. */
  skillIds: readonly string[];
};

export type ProjectedSignal = {
  signalType: SignalType;
  roleId: string;
  skillId: string | null;
  numeratorCount: number;
  denominatorCount: number;
  distinctCompanyCount: number;
  distinctSourceCount: number;
};

export type ProjectionStats = {
  postingsInWindow: number;
  postingsRoleResolved: number;
  postingsRoleUnresolved: number;
  postingsEligibleForPrevalence: number;
  postingsExcludedNotEligible: number;
  rolesEmitted: number;
  prevalencePairsConsidered: number;
  prevalencePairsSuppressed: number;
};

export type ProjectionResult = {
  signals: ProjectedSignal[];
  stats: ProjectionStats;
};

export type Floors = {
  /**
   * Below this, a prevalence row is not written at all.
   *
   * Suppression rather than a lowConfidence flag. A flag relies on every
   * consumer remembering to check it, and one day something renders "100%
   * of Backend Engineer postings require COBOL" over a sample of one.
   * Suppression fails closed. The suppressed pairs are counted, so the gap
   * is visible rather than silent.
   */
  minDenominator: number;
  /**
   * Below this, likewise. This is the one that stops a single employer's
   * board being published as "the market": a prevalence drawn from one
   * company is a fact about that company.
   */
  minDistinctCompanies: number;
};

function compareSignals(a: ProjectedSignal, b: ProjectedSignal): number {
  if (a.signalType !== b.signalType) {
    return a.signalType < b.signalType ? -1 : 1;
  }

  if (a.roleId !== b.roleId) {
    return a.roleId < b.roleId ? -1 : 1;
  }

  const left = a.skillId ?? '';
  const right = b.skillId ?? '';

  /*
   * Total: (type, role, skill) is the signal's whole identity, so this
   * comparator never returns 0 for two distinct signals and the output
   * order can never be decided by input order.
   */
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Projects observed postings into the signals for one window.
 *
 * `ROLE_POSTING_VOLUME` is deliberately not "count over itself". Its
 * denominator is every posting that entered role resolution, so the number
 * reads as "share of observed postings that were this role" - a real
 * statistic that is never trivially 1.0, and that rolls up correctly when
 * two windows are summed. A numerator equal to its denominator would make
 * any generic renderer display every volume as 100%.
 */
export function projectSignals(
  postings: readonly ObservedPosting[],
  floors: Floors,
): ProjectionResult {
  const resolved = postings.filter(
    (posting): posting is ObservedPosting & { roleId: string } =>
      posting.roleId !== null,
  );

  const byRole = new Map<string, (ObservedPosting & { roleId: string })[]>();

  for (const posting of resolved) {
    const bucket = byRole.get(posting.roleId);

    if (bucket === undefined) {
      byRole.set(posting.roleId, [posting]);
    } else {
      bucket.push(posting);
    }
  }

  const signals: ProjectedSignal[] = [];

  /* The denominator for volume: every posting we tried to resolve. */
  const roleResolutionDenominator = postings.length;

  let prevalencePairsConsidered = 0;
  let prevalencePairsSuppressed = 0;
  let eligibleTotal = 0;

  for (const [roleId, rolePostings] of byRole) {
    signals.push({
      signalType: 'ROLE_POSTING_VOLUME',
      roleId,
      skillId: null,
      numeratorCount: rolePostings.length,
      denominatorCount: roleResolutionDenominator,
      distinctCompanyCount: countDistinct(
        rolePostings.map((posting) => posting.companyNormalized),
      ),
      distinctSourceCount: countDistinct(
        rolePostings.map((posting) => posting.sourceId),
      ),
    });

    const eligible = rolePostings.filter(
      (posting) => posting.eligibleForPrevalence,
    );

    eligibleTotal += eligible.length;

    if (eligible.length === 0) {
      continue;
    }

    /*
     * Binary per posting. A posting naming a skill ten times counts once:
     * counting occurrences would turn prose style into a market signal.
     */
    const numeratorBySkill = new Map<string, ObservedPosting[]>();

    for (const posting of eligible) {
      for (const skillId of new Set(posting.skillIds)) {
        const bucket = numeratorBySkill.get(skillId);

        if (bucket === undefined) {
          numeratorBySkill.set(skillId, [posting]);
        } else {
          bucket.push(posting);
        }
      }
    }

    const roleDistinctCompanies = countDistinct(
      eligible.map((posting) => posting.companyNormalized),
    );

    for (const [skillId, mentioning] of numeratorBySkill) {
      prevalencePairsConsidered += 1;

      const mentioningCompanies = countDistinct(
        mentioning.map((posting) => posting.companyNormalized),
      );

      /*
       * The floor guards BOTH company counts, and that is a correction.
       *
       * It previously guarded only the eligible cohort's company count
       * while publishing the mentioning subset's - two different numbers.
       * The consequence was measured on real data: 98 of 230 published
       * prevalence rows carried distinctCompanyCount = 1, below the run's
       * own recorded minDistinctCompanies of 2. So the rule "a row is
       * written only if distinctCompanyCount >= minDistinctCompanies" was
       * false of the very column it named, and a figure drawn from one
       * employer was published as a market statistic.
       *
       * Guarding the cohort alone is not enough and guarding the subset
       * alone is not either: the first decides whether the SAMPLE is broad
       * enough to ask the question, the second whether the ANSWER rests on
       * more than one employer. Both must hold, and now the published
       * number is the one the floor checked.
       */
      if (
        eligible.length < floors.minDenominator ||
        roleDistinctCompanies < floors.minDistinctCompanies ||
        mentioningCompanies < floors.minDistinctCompanies
      ) {
        prevalencePairsSuppressed += 1;
        continue;
      }

      signals.push({
        signalType: 'ROLE_SKILL_PREVALENCE',
        roleId,
        skillId,
        numeratorCount: mentioning.length,
        denominatorCount: eligible.length,
        distinctCompanyCount: mentioningCompanies,
        distinctSourceCount: countDistinct(
          mentioning.map((posting) => posting.sourceId),
        ),
      });
    }
  }

  signals.sort(compareSignals);

  return {
    signals,
    stats: {
      postingsInWindow: postings.length,
      postingsRoleResolved: resolved.length,
      postingsRoleUnresolved: postings.length - resolved.length,
      postingsEligibleForPrevalence: eligibleTotal,
      postingsExcludedNotEligible: resolved.length - eligibleTotal,
      rolesEmitted: byRole.size,
      prevalencePairsConsidered,
      prevalencePairsSuppressed,
    },
  };
}

/*
 * Nulls are not a company.
 *
 * A posting whose employer the source did not state is not evidence of an
 * additional distinct employer, and counting it as one would inflate the
 * exact number that exists to reveal single-employer samples.
 */
function countDistinct(values: readonly (string | null)[]): number {
  const seen = new Set<string>();

  for (const value of values) {
    if (value !== null) {
      seen.add(value);
    }
  }

  return seen.size;
}
