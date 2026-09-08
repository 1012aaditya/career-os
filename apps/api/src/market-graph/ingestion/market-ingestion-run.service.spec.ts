import { describe, expect, it } from 'vitest';

import {
  deriveRunStatus,
  type RunStats,
} from './market-ingestion-run.service.js';

/*
 * The completeness contract, at the point where it is decided.
 *
 * Phase 7's hard-won lesson was that a status derived from a
 * caller-supplied summary is only as good as the caller: a fabricated
 * "40 of 40 scanned" over forty unscanned repositories produced SUCCEEDED.
 * So this function takes the coverage records and nothing else, and the
 * service never accepts a status as a parameter.
 */

function stats(over: Partial<RunStats> = {}): RunStats {
  return {
    scopes: [],
    scopesRequested: 0,
    scopesRead: 0,
    scopesComplete: 0,
    postingsAccepted: 0,
    postingsRejected: 0,
    duplicatesDropped: 0,
    versionsCreated: 0,
    postingsCreated: 0,
    sightingsCreated: 0,
    ...over,
  };
}

describe('run status', () => {
  it('is SUCCEEDED only when every scope asked for was read', () => {
    expect(
      deriveRunStatus(
        stats({ scopesRequested: 10, scopesRead: 10, scopesComplete: 10 }),
      ),
    ).toBe('SUCCEEDED');
  });

  /*
   * The rule the whole contract turns on. A board skipped for a rate limit
   * is not a board with no jobs on it, and a run that says SUCCEEDED is
   * claiming we know what is on all ten.
   */
  it('is PARTIAL when it read 3 of 10, and never SUCCEEDED', () => {
    const status = deriveRunStatus(
      stats({ scopesRequested: 10, scopesRead: 3, scopesComplete: 3 }),
    );

    expect(status).toBe('PARTIAL');
    expect(status).not.toBe('SUCCEEDED');
  });

  it('is PARTIAL when it missed exactly one scope', () => {
    expect(
      deriveRunStatus(
        stats({ scopesRequested: 11, scopesRead: 10, scopesComplete: 10 }),
      ),
    ).toBe('PARTIAL');
  });

  it('is FAILED when it read nothing at all', () => {
    expect(
      deriveRunStatus(
        stats({ scopesRequested: 10, scopesRead: 0, scopesComplete: 0 }),
      ),
    ).toBe('FAILED');
  });

  /*
   * The distinction a paginated source makes real: every scope was read
   * successfully, and one of them had more than the source would serve.
   */
  it('is PARTIAL when a scope was read but not read to the end', () => {
    expect(
      deriveRunStatus(
        stats({ scopesRequested: 5, scopesRead: 5, scopesComplete: 4 }),
      ),
    ).toBe('PARTIAL');
  });

  it('is FAILED when it was asked for nothing', () => {
    expect(
      deriveRunStatus(
        stats({ scopesRequested: 0, scopesRead: 0, scopesComplete: 0 }),
      ),
    ).toBe('FAILED');
  });

  /*
   * A complete run over boards that genuinely have no jobs is a success.
   * Reporting it as a failure would make "no openings" indistinguishable
   * from "we could not look", which is the confusion the whole contract
   * exists to prevent - in the other direction.
   */
  it('is SUCCEEDED when every scope was read and every scope was empty', () => {
    expect(
      deriveRunStatus(
        stats({
          scopesRequested: 3,
          scopesRead: 3,
          scopesComplete: 3,
          postingsAccepted: 0,
        }),
      ),
    ).toBe('SUCCEEDED');
  });

  /*
   * The mutation this exists to catch: deriving from the caller's summary
   * rather than from what was actually read.
   */
  it('ignores a postings count that disagrees with the scopes read', () => {
    expect(
      deriveRunStatus(
        stats({
          scopesRequested: 10,
          scopesRead: 3,
          scopesComplete: 3,
          postingsAccepted: 9_999,
        }),
      ),
    ).toBe('PARTIAL');
  });
});
