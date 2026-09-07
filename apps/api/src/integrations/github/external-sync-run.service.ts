import {
  ConflictException,
  Injectable,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service.js';

import { isCompleteScan } from './observations/normalize.js';
import type {
  SyncCompleteness,
  SyncObservation,
} from './observations/types.js';

/*
 * The sync ledger.
 *
 * One row per attempt, and the row is the only durable record of what a
 * sync actually managed to read. Its whole job is to make an incomplete
 * run impossible to mistake for a complete one.
 *
 * The status is therefore NOT a parameter, and it is not read from the
 * caller's completeness block either. finish() recomputes it from the
 * repositories in the observation, because a derivation that trusts a
 * supplied count is only as good as the caller: "40 of 40 scanned" over
 * forty NOT_SCANNED repositories used to yield SUCCEEDED. Deriving from
 * the records themselves is what actually closes that path.
 */

/*
 * How long a RUNNING row may sit before it is presumed abandoned.
 *
 * There is a known failure of exactly this shape elsewhere in the
 * codebase: resume imports are claimed into PROCESSING with no lease and
 * no sweeper, so a worker crash strands the row permanently and nothing
 * can move it back. This avoids repeating that - a run that outlives the
 * window is reclaimable rather than terminal.
 */
const STALE_RUN_MS = 30 * 60 * 1000;

export type SyncRunStats = {
  completeness: SyncCompleteness;
  repositories: Array<{
    externalId: string;
    fullName: string;
    commits: string;
    truncated: boolean;
  }>;
};

@Injectable()
export class ExternalSyncRunService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Opens a run, refusing to start a second one alongside a live one.
   *
   * Two concurrent syncs for one connection would both walk the same
   * repositories, spend the same rate-limit budget twice, and race each
   * other's writes for no benefit.
   */
  async start(input: {
    connectionId: string;
    userId: string;
  }): Promise<{ id: string }> {
    const cutoff = new Date(
      Date.now() - STALE_RUN_MS,
    );

    /*
     * Reclaim abandoned runs before checking for a live one. A process
     * that died mid-sync leaves RUNNING behind; without this, the
     * connection could never sync again.
     */
    await this.prisma.externalSyncRun.updateMany(
      {
        where: {
          connectionId: input.connectionId,
          status: 'RUNNING',
          startedAt: { lt: cutoff },
        },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          errorMessage:
            'Abandoned: no completion recorded within the run window',
        },
      },
    );

    const live =
      await this.prisma.externalSyncRun.findFirst(
        {
          where: {
            connectionId: input.connectionId,
            status: 'RUNNING',
          },
          select: { id: true },
        },
      );

    if (live) {
      throw new ConflictException(
        'A sync is already running for this connection',
      );
    }

    const run =
      await this.prisma.externalSyncRun.create({
        data: {
          connectionId: input.connectionId,
          userId: input.userId,
          status: 'RUNNING',
        },
        select: { id: true },
      });

    return run;
  }

  /**
   * Closes a run that produced observations.
   *
   * SUCCEEDED requires that every listed repository was scanned AND that
   * the listing itself was not truncated. Anything short of that is
   * PARTIAL - which is not a failure, and must not be reported as one
   * either: the run did read what it read.
   */
  async finish(
    runId: string,
    observation: SyncObservation,
  ): Promise<{ status: string }> {
    /*
     * Derived from the repositories themselves, not from the completeness
     * block handed to us.
     *
     * The earlier version trusted observation.completeness.reposScanned.
     * That made the guarantee only as good as the caller: a fabricated
     * completeness saying "40 of 40 scanned" over forty NOT_SCANNED
     * repositories produced SUCCEEDED. The point of deriving the status
     * here was to make that unreachable, so the derivation has to start
     * from evidence rather than from a claim.
     *
     * Three conditions, each one a way a run can be incomplete:
     *
     *   - every repository actually observed. NOT_SCANNED is budget or
     *     rate limit; ACCESS_LOST is a repository we could not read. A run
     *     where every repository 404'd gathered nothing, and reporting
     *     that as SUCCEEDED would be the plainest possible false claim.
     *   - no repository's commit walk truncated. Per-repository truncation
     *     never reached the run status before, so a run whose every walk
     *     hit the page ceiling reported SUCCEEDED over counts that were
     *     all short of the truth.
     *   - the listing itself not truncated, which means repositories we
     *     never enumerated at all.
     */
    const observed = observation.repositories.filter(
      (repository) =>
        repository.completeness.commits ===
        'DEFAULT_BRANCH_ONLY',
    ).length;

    const anyRepositoryTruncated =
      observation.repositories.some(
        (repository) =>
          repository.completeness.truncated,
      );

    const complete =
      isCompleteScan(observation.completeness) &&
      !anyRepositoryTruncated &&
      observed ===
        observation.repositories.length &&
      observed >=
        observation.completeness.reposTotal;

    const stats: SyncRunStats = {
      completeness: observation.completeness,
      /*
       * A per-repository completeness record, so a later reader can tell
       * which repositories were skipped rather than only how many. Names
       * and flags only - nothing here is derived from a credential, and
       * no token, header or raw GitHub response reaches this column.
       */
      repositories: observation.repositories.map(
        (repository) => ({
          externalId: repository.externalId,
          fullName: repository.fullName,
          commits:
            repository.completeness.commits,
          truncated:
            repository.completeness.truncated,
        }),
      ),
    };

    const status = complete
      ? ('SUCCEEDED' as const)
      : ('PARTIAL' as const);

    /*
     * Compare-and-swap on RUNNING. A run that has already been closed -
     * by a reclaim sweep, or by a duplicate completion - must not be
     * reopened and rewritten.
     */
    const updated =
      await this.prisma.externalSyncRun.updateMany(
        {
          where: { id: runId, status: 'RUNNING' },
          data: {
            status,
            finishedAt: new Date(),
            errorMessage: null,
            stats,
          },
        },
      );

    if (updated.count !== 1) {
      throw new ConflictException(
        'Sync run is no longer running',
      );
    }

    return { status };
  }

  /**
   * Closes a run that could not produce observations.
   *
   * The reason is a short, already-sanitized string. Callers pass a code
   * and a status, never a caught error: an error from an HTTP client
   * carries the request that produced it, and that request carries the
   * Authorization header.
   */
  async fail(
    runId: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.externalSyncRun.updateMany(
      {
        where: { id: runId, status: 'RUNNING' },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          errorMessage: reason,
        },
      },
    );
  }
}
