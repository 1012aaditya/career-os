import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { canonicalHash } from '../../common/canonical-hash.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/*
 * The ingestion ledger: one row per attempt, and the only place a run's
 * status is decided.
 *
 * Modelled on ExternalSyncRunService, with one deliberate difference. That
 * service guards concurrency with a read-then-write in application code,
 * which its own documentation records as an accepted residual: under READ
 * COMMITTED two callers can both read "nothing in flight" and both insert.
 * Phase 8 has a partial unique index behind it - one RUNNING row per
 * source - so the race is answered by the database and surfaces as a
 * P2002 rather than as two runs quietly double-writing every posting.
 */

/** How long a RUNNING row is honoured before it is treated as abandoned. */
const STALE_RUN_MS = 30 * 60 * 1000;

export type BoardCoverage = {
  boardToken: string;
  /** Did the fetch complete? False means we do not know what is there. */
  fetched: boolean;
  /** Short stable code. Never a caught error. */
  failureReason: string | null;
  postingsSeen: number;
  postingsAccepted: number;
  postingsRejected: number;
  duplicatesDropped: number;
};

export type RunStats = {
  boards: BoardCoverage[];
  boardsRequested: number;
  boardsFetched: number;
  postingsAccepted: number;
  postingsRejected: number;
  duplicatesDropped: number;
  versionsCreated: number;
  postingsCreated: number;
  sightingsCreated: number;
};

/**
 * Derives a run's status from what it actually covered.
 *
 * Exported and pure so it can be tested directly, and so the rule is
 * stated in one place rather than at each call site.
 *
 * PARTIAL is not a failure. A run that read 3 of 10 boards succeeded at
 * what it did, and it must not report SUCCEEDED, because a board skipped
 * for a rate limit is not a board with no jobs on it.
 */
export function deriveRunStatus(
  stats: RunStats,
): 'SUCCEEDED' | 'PARTIAL' | 'FAILED' {
  if (stats.boardsRequested === 0 || stats.boardsFetched === 0) {
    return 'FAILED';
  }

  return stats.boardsFetched === stats.boardsRequested
    ? 'SUCCEEDED'
    : 'PARTIAL';
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

@Injectable()
export class MarketIngestionRunService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Opens a run, or refuses because one is already in flight.
   *
   * Abandoned runs are reclaimed first. Without this the partial unique
   * index would be a permanent lock: a process killed mid-run leaves a
   * RUNNING row that no later run can get past, and the source goes dark
   * with no error anywhere. The lease is what makes a constraint safe to
   * put on a long-lived row at all.
   */
  async start(input: {
    sourceId: string;
    adapterVersion: number;
    rulesetVersion: number;
    queryParams: Record<string, unknown>;
    now: Date;
  }): Promise<{ id: string }> {
    const cutoff = new Date(input.now.getTime() - STALE_RUN_MS);

    await this.prisma.marketIngestionRun.updateMany({
      where: {
        sourceId: input.sourceId,
        status: 'RUNNING',
        startedAt: { lt: cutoff },
      },
      data: {
        status: 'FAILED',
        finishedAt: input.now,
        errorReason: 'abandoned',
      },
    });

    try {
      return await this.prisma.marketIngestionRun.create({
        data: {
          sourceId: input.sourceId,
          adapterVersion: input.adapterVersion,
          rulesetVersion: input.rulesetVersion,
          queryParams: input.queryParams as Prisma.InputJsonObject,
          /*
           * The identity of the sample. "62 of 100 postings" is
           * meaningless unless what the sample was drawn from is on the
           * record, and this is what later reveals that two runs believed
           * comparable actually asked different questions.
           */
          queryFingerprint: canonicalHash(input.queryParams),
          startedAt: input.now,
          status: 'RUNNING',
        },
        select: { id: true },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'An ingestion run is already in flight for this source',
        );
      }

      throw error;
    }
  }

  /**
   * Closes a run.
   *
   * The status is NOT a parameter. It is re-derived here from the coverage
   * records, because a derivation that trusts a supplied summary is only
   * as good as the caller - and the caller is the code most motivated to
   * believe its run went well.
   *
   * Written under a compare-and-swap on RUNNING, so a second close, or a
   * close racing the stale-run reclaim above, fails loudly instead of
   * silently rewriting a terminal row.
   */
  async finish(input: {
    runId: string;
    stats: RunStats;
    now: Date;
  }): Promise<{ status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED' }> {
    const status = deriveRunStatus(input.stats);

    const updated = await this.prisma.marketIngestionRun.updateMany({
      where: { id: input.runId, status: 'RUNNING' },
      data: {
        status,
        finishedAt: input.now,
        stats: input.stats as unknown as Prisma.InputJsonObject,
      },
    });

    if (updated.count !== 1) {
      throw new ConflictException('Ingestion run is no longer running');
    }

    return { status };
  }

  /** Marks a run failed. The reason is a short code the caller chose. */
  async fail(input: {
    runId: string;
    reason: string;
    now: Date;
  }): Promise<void> {
    await this.prisma.marketIngestionRun.updateMany({
      where: { id: input.runId, status: 'RUNNING' },
      data: {
        status: 'FAILED',
        finishedAt: input.now,
        errorReason: input.reason,
      },
    });
  }
}
