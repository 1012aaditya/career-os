/*
 * Freshness, derived.
 *
 * There is no freshness column anywhere in Phase 8, and that is the whole
 * point of this file. A stored verdict is a judgement made at time T that
 * goes on asserting itself at T plus six months; keeping it honest needs a
 * sweeper rewriting rows that nothing observed, which is the write churn
 * that made re-syncs rewrite every row in Phase 7.
 *
 * Derived instead, from an explicit `asOf`. That also makes "was this
 * fresh at the moment that signal was computed?" answerable, which a
 * column holding only the latest verdict never can.
 *
 * Pure: no clock is read here. `asOf` is a parameter.
 */

export type FreshnessVerdict = 'FRESH' | 'AGING' | 'STALE' | 'UNAVAILABLE';

/**
 * Which figure the lifetime came from.
 *
 * Recorded and returned with every verdict, because the basis is
 * falsifiable and the verdict is not. DEFAULT means the verdict rests on a
 * configured guess at how long a posting stays live, so once a real figure
 * is measured, every verdict resting on the guess is identifiable at the
 * point it is read.
 */
export type LifetimeBasis = 'SOURCE_STATED' | 'DEFAULT';

export type FreshnessInput = {
  asOf: Date;
  lastSeenAt: Date;
  /**
   * The end of the most recent COMPLETE read of this posting's scope,
   * whether or not this posting was in it. Null means no complete read
   * has ever finished for that scope.
   */
  lastCompleteCoverageAt: Date | null;
  /** The employer's own stated expiry, when the source supplies one. */
  sourceValidThrough: Date | null;
  firstSeenAt: Date;
  pollIntervalHours: number;
  expectedPostingLifetimeDays: number;
};

export type Freshness = {
  verdict: FreshnessVerdict;
  ageMs: number;
  lifetimeBasis: LifetimeBasis;
  lastSeenAt: Date;
  lastCompleteCoverageAt: Date | null;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function classifyFreshness(input: FreshnessInput): Freshness {
  const ageMs = input.asOf.getTime() - input.lastSeenAt.getTime();

  /*
   * The coverage gate comes FIRST, and it is the state most systems omit.
   *
   * If no complete read of this posting's scope has finished since we last
   * saw it, then its absence from recent runs is OUR failure, not the
   * posting's disappearance. Saying STALE there would report a rate limit
   * as a closed job. This is Phase 7's NOT_SCANNED rule in the time
   * dimension: "we did not look" is never "there is nothing there".
   */
  if (
    input.lastCompleteCoverageAt === null ||
    input.lastCompleteCoverageAt.getTime() < input.lastSeenAt.getTime()
  ) {
    return {
      verdict: 'UNAVAILABLE',
      ageMs,
      lifetimeBasis:
        input.sourceValidThrough === null ? 'DEFAULT' : 'SOURCE_STATED',
      lastSeenAt: input.lastSeenAt,
      lastCompleteCoverageAt: input.lastCompleteCoverageAt,
    };
  }

  /*
   * Two poll intervals rather than one, so a single missed or delayed run
   * does not flip a healthy posting. This threshold is a statement about
   * OUR sampling cadence, not about the job market, which is why it needs
   * no market evidence to justify it.
   */
  const freshWindowMs = 2 * input.pollIntervalHours * HOUR_MS;

  /*
   * The employer's stated expiry beats our guess whenever we have it.
   * Greenhouse returned null for it on every posting sampled, so DEFAULT
   * is what actually fires today - and the basis says so rather than
   * letting a guessed number pass as a measured one.
   */
  const lifetimeBasis: LifetimeBasis =
    input.sourceValidThrough === null ? 'DEFAULT' : 'SOURCE_STATED';

  const lifetimeMs =
    input.sourceValidThrough === null
      ? input.expectedPostingLifetimeDays * DAY_MS
      : input.sourceValidThrough.getTime() - input.firstSeenAt.getTime();

  const verdict: FreshnessVerdict =
    ageMs <= freshWindowMs
      ? 'FRESH'
      : ageMs <= Math.max(lifetimeMs, freshWindowMs)
        ? 'AGING'
        : 'STALE';

  return {
    verdict,
    ageMs,
    lifetimeBasis,
    lastSeenAt: input.lastSeenAt,
    lastCompleteCoverageAt: input.lastCompleteCoverageAt,
  };
}
