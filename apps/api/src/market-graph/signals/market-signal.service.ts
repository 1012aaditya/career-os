import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { canonicalHash } from '../../common/canonical-hash.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RULESET_VERSION } from '../normalization/ruleset.js';
import {
  COMPUTATION_VERSION,
  type ObservedPosting,
  projectSignals,
} from './signal-projection.js';

/*
 * Turns stored observations into a snapshot of signals.
 *
 * Append-only: a recompute writes a NEW MarketSignalRun and a fresh set of
 * rows. Nothing is ever updated in place, so a number that has been shown
 * to somebody cannot silently become a different number, and staleness is
 * a visible fact - every signal carries its own window and computedAt -
 * rather than a bug to be patched away.
 */

/** A ceiling on one computation, so it can never walk an unbounded table. */
const MAX_POSTINGS_PER_RUN = 20_000;

export type ComputeInput = {
  sourceSlug: string;
  scopes: readonly string[];
  windowStart: Date;
  windowEnd: Date;
  minDenominator: number;
  minDistinctCompanies: number;
  now: Date;
};

@Injectable()
export class MarketSignalService {
  constructor(private readonly prisma: PrismaService) {}

  async compute(input: ComputeInput): Promise<{
    runId: string;
    signalCount: number;
    coverageComplete: boolean;
  }> {
    if (input.windowEnd <= input.windowStart) {
      throw new ConflictException('Window end must be after window start');
    }

    const scopes = [...new Set(input.scopes)].sort();

    /*
     * The checksum of the scope list, not a substitute for it. The list
     * itself is stored on the run, because a signal carrying only an
     * opaque hash cannot answer "which employers is this about?" - and
     * that question is the whole basis of the rule that a signal may never
     * be labelled "the market".
     */
    const sourceScopeKey = canonicalHash({
      source: input.sourceSlug,
      scopes,
    });

    let run: { id: string };

    try {
      run = await this.prisma.marketSignalRun.create({
        data: {
          status: 'RUNNING',
          rulesetVersion: RULESET_VERSION,
          computationVersion: COMPUTATION_VERSION,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          sourceScopeKey,
          scopes,
          minDenominator: input.minDenominator,
          minDistinctCompanies: input.minDistinctCompanies,
          computedAt: input.now,
        },
        select: { id: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'A signal computation is already running for this scope',
        );
      }

      throw error;
    }

    const coverageComplete = await this.isCoverageComplete({
      sourceSlug: input.sourceSlug,
      scopes,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
    });

    const postings = await this.observedPostings({
      sourceSlug: input.sourceSlug,
      scopes,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
    });

    const projected = projectSignals(postings, {
      minDenominator: input.minDenominator,
      minDistinctCompanies: input.minDistinctCompanies,
    });

    for (const signal of projected.signals) {
      await this.prisma.marketSignal.create({
        data: {
          runId: run.id,
          signalType: signal.signalType,
          roleId: signal.roleId,
          skillId: signal.skillId,
          numeratorCount: signal.numeratorCount,
          denominatorCount: signal.denominatorCount,
          distinctCompanyCount: signal.distinctCompanyCount,
          distinctSourceCount: signal.distinctSourceCount,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          rulesetVersion: RULESET_VERSION,
          computationVersion: COMPUTATION_VERSION,
          sourceScopeKey,
          dedupeMethod: 'NONE',
          coverageComplete,
          computedAt: input.now,
        },
      });
    }

    await this.prisma.marketSignalRun.updateMany({
      where: { id: run.id, status: 'RUNNING' },
      data: {
        status: 'SUCCEEDED',
        coverageComplete,
        finishedAt: input.now,
        stats: projected.stats as unknown as Prisma.InputJsonObject,
      },
    });

    return {
      runId: run.id,
      signalCount: projected.signals.length,
      coverageComplete,
    };
  }

  /**
   * Was every scope this computation draws on completely read, at least
   * once, inside the window?
   *
   * Scoped rather than global. A signal over {vercel, stripe} must not be
   * flagged because an unrelated board 404'd in the same run - if it were,
   * every signal would ship permanently flagged and the flag would become
   * noise nobody reads, which is the failure the suppression floor exists
   * to avoid elsewhere.
   */
  private async isCoverageComplete(input: {
    sourceSlug: string;
    scopes: readonly string[];
    windowStart: Date;
    windowEnd: Date;
  }): Promise<boolean> {
    for (const scope of input.scopes) {
      const complete = await this.prisma.marketRunScopeCoverage.findFirst({
        where: {
          sourceScope: scope,
          completeForScope: true,
          source: { slug: input.sourceSlug },
          finishedAt: { gte: input.windowStart, lt: input.windowEnd },
        },
        select: { runId: true },
      });

      if (complete === null) {
        return false;
      }
    }

    return true;
  }

  /**
   * The postings observed in the window, each read at the version of its
   * LATEST in-window sighting.
   *
   * "Latest in-window" and not "latest overall": a signal for a past window
   * must not change because the posting was edited afterwards, or windows
   * would stop tiling and a recomputation of an old window would answer
   * differently every time.
   *
   * The ordering is total. observedAt is millisecond-resolution and ties
   * are ordinary - a retry, two runs landing in the same millisecond - so
   * runSeq breaks the tie. runSeq is a database sequence rather than a
   * uuid: a uuid is unique but arbitrary and DIFFERENT between dev, CI and
   * production, so ordering by one would make the answer machine-local.
   */
  private async observedPostings(input: {
    sourceSlug: string;
    scopes: readonly string[];
    windowStart: Date;
    windowEnd: Date;
  }): Promise<ObservedPosting[]> {
    const sightings = await this.prisma.marketPostingSighting.findMany({
      where: {
        observedAt: { gte: input.windowStart, lt: input.windowEnd },
        posting: {
          sourceScope: { in: [...input.scopes] },
          source: { slug: input.sourceSlug },
        },
      },
      orderBy: [
        { postingId: 'asc' },
        { observedAt: 'desc' },
        { runSeq: 'desc' },
        { versionId: 'asc' },
      ],
      take: MAX_POSTINGS_PER_RUN,
      select: { postingId: true, versionId: true },
    });

    const latestVersionByPosting = new Map<string, string>();

    for (const sighting of sightings) {
      if (!latestVersionByPosting.has(sighting.postingId)) {
        latestVersionByPosting.set(sighting.postingId, sighting.versionId);
      }
    }

    if (latestVersionByPosting.size === 0) {
      return [];
    }

    const normalizations =
      await this.prisma.marketPostingNormalization.findMany({
        where: {
          rulesetVersion: RULESET_VERSION,
          versionId: { in: [...latestVersionByPosting.values()] },
        },
        orderBy: { versionId: 'asc' },
        select: {
          versionId: true,
          roleId: true,
          companyNormalized: true,
          skillExtractionStatus: true,
          version: {
            select: {
              descriptionCompleteness: true,
              posting: { select: { id: true, sourceId: true } },
            },
          },
          mentions: {
            where: { rulesetVersion: RULESET_VERSION, skillId: { not: null } },
            orderBy: { skillId: 'asc' },
            select: { skillId: true },
          },
        },
      });

    return (
      normalizations
        .map((row): ObservedPosting => {
          const skillIds = [
            ...new Set(
              row.mentions
                .map((mention) => mention.skillId)
                .filter((id): id is string => id !== null),
            ),
          ].sort();

          return {
            postingId: row.version.posting.id,
            roleId: row.roleId,
            companyNormalized: row.companyNormalized,
            sourceId: row.version.posting.sourceId,
            /*
             * Both conditions, and both are the same rule seen from two
             * sides: we could read the text, and the text was all of it.
             * A truncated description systematically undercounts skills, so
             * mixing truncated and full postings in one denominator would
             * produce a number about our fetch strategy rather than about
             * the market.
             */
            eligibleForPrevalence:
              row.skillExtractionStatus === 'EXTRACTED' &&
              row.version.descriptionCompleteness === 'FULL',
            skillIds,
          };
        })
        /*
         * Sorted on a unique key so the projection receives a total order and
         * cannot be influenced by however the database chose to return rows.
         */
        .sort((a, b) => (a.postingId < b.postingId ? -1 : 1))
    );
  }
}
