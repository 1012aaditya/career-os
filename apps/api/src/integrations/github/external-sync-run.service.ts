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
 * The status is therefore NOT a parameter. finish() derives it from the
 * completeness of the observation it is given, so there is no code path -
 * present or future - through which a caller can hand this service a
 * partial scan and the word SUCCEEDED. A boolean argument would have been
 * simpler and would have lasted until the first person in a hurry.
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
    const complete = isCompleteScan(
      observation.completeness,
    );

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
