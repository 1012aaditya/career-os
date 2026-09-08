import { describe, expect, it } from 'vitest';

import { classifyFreshness, type FreshnessInput } from './freshness.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const NOW = new Date('2026-09-08T12:00:00.000Z');

function input(over: Partial<FreshnessInput> = {}): FreshnessInput {
  return {
    asOf: NOW,
    lastSeenAt: new Date(NOW.getTime() - HOUR),
    lastCompleteCoverageAt: new Date(NOW.getTime() - HOUR / 2),
    sourceValidThrough: null,
    firstSeenAt: new Date(NOW.getTime() - 10 * DAY),
    pollIntervalHours: 24,
    expectedPostingLifetimeDays: 30,
    ...over,
  };
}

describe('freshness', () => {
  it('is FRESH inside two poll intervals', () => {
    expect(
      classifyFreshness(
        input({ lastSeenAt: new Date(NOW.getTime() - 47 * HOUR) }),
      ).verdict,
    ).toBe('FRESH');
  });

  it('is AGING past two poll intervals but inside the expected lifetime', () => {
    expect(
      classifyFreshness(
        input({ lastSeenAt: new Date(NOW.getTime() - 5 * DAY) }),
      ).verdict,
    ).toBe('AGING');
  });

  it('is STALE past the expected lifetime', () => {
    expect(
      classifyFreshness(
        input({ lastSeenAt: new Date(NOW.getTime() - 40 * DAY) }),
      ).verdict,
    ).toBe('STALE');
  });

  it.each([
    ['exactly two poll intervals', 48 * HOUR, 'FRESH'],
    ['one millisecond past two poll intervals', 48 * HOUR + 1, 'AGING'],
    ['exactly the expected lifetime', 30 * DAY, 'AGING'],
    ['one millisecond past the lifetime', 30 * DAY + 1, 'STALE'],
  ])('at %s it is %s', (_label, age, verdict) => {
    expect(
      classifyFreshness(input({ lastSeenAt: new Date(NOW.getTime() - age) }))
        .verdict,
    ).toBe(verdict);
  });

  /*
   * The state most systems omit, and the reason the coverage ledger exists.
   *
   * A posting missing from recent runs because we never finished reading
   * its board has not gone anywhere. Reporting STALE there would announce
   * that a job closed on the strength of our own rate limit - which is
   * Phase 7's NOT_SCANNED rule, in the time dimension.
   */
  it('is UNAVAILABLE when no complete read has finished since we last looked', () => {
    const result = classifyFreshness(
      input({
        lastSeenAt: new Date(NOW.getTime() - 40 * DAY),
        lastCompleteCoverageAt: new Date(NOW.getTime() - 41 * DAY),
      }),
    );

    expect(result.verdict).toBe('UNAVAILABLE');
    expect(result.verdict).not.toBe('STALE');
  });

  it('is UNAVAILABLE when the scope has never been completely read', () => {
    expect(
      classifyFreshness(input({ lastCompleteCoverageAt: null })).verdict,
    ).toBe('UNAVAILABLE');
  });

  /*
   * The distinction the coverage gate is for: two postings the same age,
   * one of which we have simply failed to look for.
   */
  it('separates a job that went away from a board we failed to read', () => {
    const age = 40 * DAY;

    const covered = classifyFreshness(
      input({
        lastSeenAt: new Date(NOW.getTime() - age),
        lastCompleteCoverageAt: new Date(NOW.getTime() - HOUR),
      }),
    );

    const uncovered = classifyFreshness(
      input({
        lastSeenAt: new Date(NOW.getTime() - age),
        lastCompleteCoverageAt: new Date(NOW.getTime() - age - HOUR),
      }),
    );

    expect(covered.verdict).toBe('STALE');
    expect(uncovered.verdict).toBe('UNAVAILABLE');
  });
});

describe('the basis of the verdict', () => {
  /*
   * The lifetime is a configured guess, and a verdict that rests on a
   * guess must say so - otherwise there is no way to find the verdicts
   * that need revisiting once a real figure is measured.
   */
  it('says DEFAULT when it used the configured lifetime', () => {
    expect(classifyFreshness(input()).lifetimeBasis).toBe('DEFAULT');
  });

  it('says SOURCE_STATED when the employer supplied an expiry', () => {
    expect(
      classifyFreshness(
        input({ sourceValidThrough: new Date(NOW.getTime() + 5 * DAY) }),
      ).lifetimeBasis,
    ).toBe('SOURCE_STATED');
  });

  it('prefers the employer expiry over the configured guess', () => {
    const shortLived = classifyFreshness(
      input({
        lastSeenAt: new Date(NOW.getTime() - 5 * DAY),
        firstSeenAt: new Date(NOW.getTime() - 10 * DAY),
        /* Expired eight days ago: a two-day advertised life. */
        sourceValidThrough: new Date(NOW.getTime() - 8 * DAY),
      }),
    );

    /* Under the 30-day default this would still be AGING. */
    expect(shortLived.verdict).toBe('STALE');
    expect(shortLived.lifetimeBasis).toBe('SOURCE_STATED');
  });
});

describe('determinism', () => {
  it('reads no clock of its own', () => {
    const later = classifyFreshness(
      input({ asOf: new Date(NOW.getTime() + 40 * DAY) }),
    );
    const now = classifyFreshness(input());

    /*
     * The same stored row yields two different verdicts for two different
     * asOf values, and neither required a write. That is the whole reason
     * freshness is derived rather than stored.
     */
    expect(now.verdict).toBe('FRESH');
    expect(later.verdict).toBe('STALE');
  });

  it('returns the same verdict for the same inputs every time', () => {
    expect(classifyFreshness(input())).toEqual(classifyFreshness(input()));
  });
});
