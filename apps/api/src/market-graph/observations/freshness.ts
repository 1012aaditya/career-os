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
 * Which figure decided the verdict.
 *
 * Recorded and returned with every verdict, because the basis is
 * falsifiable and the verdict is not. DEFAULT means the verdict rests on a
 * configured guess at how long a posting stays live, so once a real figure
 * is measured, every verdict resting on the guess is identifiable at the
 * point it is read.
 *
 * It names the figure that actually BOUND the answer, not merely the one
 * the source happened to supply. An employer deadline a year away decides
 * nothing when our own expectation expires first, and calling that verdict
 * SOURCE_STATED would credit the source for a number it did not determine.
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
  pollIntervalHours: number;
  expectedPostingLifetimeDays: number;
};

export type Freshness = {
  verdict: FreshnessVerdict;
  ageMs: number;
  lifetimeBasis: LifetimeBasis;
  lastSeenAt: Date;
  lastCompleteCoverageAt: Date | null;
  /**
   * The instant after which this posting is no longer expected to be live.
   * Returned so a reader can reproduce the verdict by hand rather than
   * trusting it - the same reason every caller echoes `asOf`.
   */
  expectedLiveUntil: Date;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function classifyFreshness(input: FreshnessInput): Freshness {
  const ageMs = input.asOf.getTime() - input.lastSeenAt.getTime();

  /*
   * How long we expect a posting to stay live, counted from when we last
   * SAW it rather than from when we first did.
   *
   * Counting from first sight was wrong in a way only a second source made
   * visible. Greenhouse states an expiry on 16 of 2957 postings, so the
   * branch was effectively dead; JobTech states one on effectively all
   * 6671, and `sourceValidThrough - firstSeenAt` then makes a posting's
   * advertised life a function of when OUR crawler started looking. An ad
   * first seen the day before its deadline got a one-day lifetime, and an
   * ad already expired when we found it got a NEGATIVE one - which
   * `Math.max(lifetimeMs, freshWindowMs)` silently absorbed, making AGING
   * unreachable for it.
   *
   * The two figures are combined as a minimum rather than a preference.
   * Each is an upper bound on liveness from a different direction: the
   * employer's deadline is when the advert stops being valid, and our
   * configured lifetime is how long we are willing to believe a posting we
   * can no longer see is still open. A deadline six months out does not
   * make a posting we stopped seeing in March still live in September.
   */
  const defaultExpiry = new Date(
    input.lastSeenAt.getTime() + input.expectedPostingLifetimeDays * DAY_MS,
  );

  const stated = input.sourceValidThrough;

  const sourceBinds =
    stated !== null && stated.getTime() < defaultExpiry.getTime();

  const expectedLiveUntil =
    sourceBinds && stated !== null ? stated : defaultExpiry;

  const lifetimeBasis: LifetimeBasis = sourceBinds
    ? 'SOURCE_STATED'
    : 'DEFAULT';

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
      lifetimeBasis,
      lastSeenAt: input.lastSeenAt,
      lastCompleteCoverageAt: input.lastCompleteCoverageAt,
      expectedLiveUntil,
    };
  }

  /*
   * Two poll intervals rather than one, so a single missed or delayed run
   * does not flip a healthy posting. This threshold is a statement about
   * OUR sampling cadence, not about the job market, which is why it needs
   * no market evidence to justify it.
   */
  const freshWindowMs = 2 * input.pollIntervalHours * HOUR_MS;

  const verdict: FreshnessVerdict =
    ageMs <= freshWindowMs
      ? 'FRESH'
      : input.asOf.getTime() <= expectedLiveUntil.getTime()
        ? 'AGING'
        : 'STALE';

  return {
    verdict,
    ageMs,
    lifetimeBasis,
    lastSeenAt: input.lastSeenAt,
    lastCompleteCoverageAt: input.lastCompleteCoverageAt,
    expectedLiveUntil,
  };
}
