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

/*
 * How many sighting rows are read per query while walking the window.
 *
 * A page size, NOT a ceiling. The walk continues until the window is
 * exhausted; this only bounds how much is in memory at once.
 */
const SIGHTING_PAGE_SIZE = 5_000;

/*
 * The real ceiling, counted in POSTINGS, and it REFUSES rather than
 * truncates.
 *
 * The previous version applied a 20,000 ceiling to the `take` of the
 * sighting query and called it MAX_POSTINGS_PER_RUN. Sightings accumulate
 * one row per posting per run, so at this source's own configured daily
 * poll and the CLI's 30-day window, 2,955 postings produce 88,650
 * sightings - and the computation would have silently seen roughly the
 * first 667 postings. Worse, the query's leading sort key is `postingId`,
 * a uuid minted per environment, so dev, CI and production would each have
 * dropped a DIFFERENT three quarters of the market, with no error, no
 * flag, and `postingsInWindow` reporting the truncated number as though it
 * were the window.
 *
 * Two changes make that unrepresentable: the walk is paged to exhaustion
 * rather than cut, and exceeding this ceiling throws. A computation that
 * cannot see all of its input must refuse to answer, because an answer
 * from a silently truncated sample is indistinguishable from a correct one.
 */
const MAX_OBSERVED_POSTINGS = 200_000;

/*
 * The same shape the migration's CHECK enforces on MarketPosting.
 * MarketSignalRun.scopes has no constraint of its own, and a malformed
 * scope reached the database once already: an invocation that passed ten
 * board tokens as a single space-separated string was stored verbatim as
 * one scope, matched nothing, and produced a SUCCEEDED run with zero
 * signals that was eligible to become the published snapshot.
 */
const SCOPE_SHAPE = /^[a-z0-9*][a-z0-9._*-]*$/;

/** How long a RUNNING computation is honoured before it is reclaimed. */
const STALE_RUN_MS = 30 * 60 * 1000;

export type ComputeInput = {
  sourceSlug: string;
  scopes: readonly string[];
  windowStart: Date;
  windowEnd: Date;
  minDenominator: number;
  minDistinctCompanies: number;
  now: Date;
  /**
   * Which ruleset to read normalizations at.
   *
   * A parameter rather than the module constant, so an old signal can be
   * recomputed under the rules that produced it. Without it, bumping
   * RULESET_VERSION would make every historical signal unreproducible by
   * any code path, which would reduce the version stamp on a signal row to
   * a label recording something nothing can act on.
   */
  rulesetVersion?: number;
  /**
   * Required, not defaulted.
   *
   * A `?? (() => new Date())` fallback here would be this layer reading a
   * clock, which the boundary test forbids and which determinism rule 8
   * states as "a missing injected instant throws rather than falling back
   * to now". The default belongs at the process edge, where somebody has
   * decided what time it is.
   */
  clock: () => Date;
};

@Injectable()
export class MarketSignalService {
  constructor(private readonly prisma: PrismaService) {}

  async compute(input: ComputeInput): Promise<{
    runId: string;
    status: 'SUCCEEDED' | 'FAILED';
    signalCount: number;
    coverageComplete: boolean;
  }> {
    if (input.windowEnd <= input.windowStart) {
      throw new ConflictException('Window end must be after window start');
    }

    const scopes = [...new Set(input.scopes)].sort();

    if (scopes.length === 0) {
      throw new ConflictException('At least one scope is required');
    }

    const malformed = scopes.filter((scope) => !SCOPE_SHAPE.test(scope));

    if (malformed.length > 0) {
      /*
       * Refused before a run row exists. The shape is validated here as
       * well as by the CHECK on MarketPosting because this is the side
       * that was actually wrong: postings could never have held a bad
       * scope, and a signal run could.
       */
      throw new ConflictException(
        `Malformed scope: ${malformed.length} of ${scopes.length} scopes are not valid scope tokens`,
      );
    }

    const rulesetVersion = input.rulesetVersion ?? RULESET_VERSION;
    const clock = input.clock;

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

    /*
     * Reclaim an abandoned computation before trying to start.
     *
     * The migration adds a partial unique index allowing one RUNNING run
     * per scope key, and argues - for the ingestion index eight lines
     * earlier - that "the constraint and the lease are one mechanism and
     * neither is safe without the other". This computation shipped with
     * the constraint and without the lease, so a single crash between
     * opening the run and closing it left a RUNNING row that no later
     * computation for that scope could ever get past, recoverable only by
     * hand-written SQL against production.
     */
    await this.prisma.marketSignalRun.updateMany({
      where: {
        sourceScopeKey,
        status: 'RUNNING',
        computedAt: { lt: new Date(input.now.getTime() - STALE_RUN_MS) },
      },
      data: { status: 'FAILED', finishedAt: input.now },
    });

    let run: { id: string };

    try {
      run = await this.prisma.marketSignalRun.create({
        data: {
          status: 'RUNNING',
          rulesetVersion,
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

    try {
      return await this.runComputation({
        runId: run.id,
        sourceScopeKey,
        rulesetVersion,
        scopes,
        clock,
        input,
      });
    } catch (error) {
      /*
       * Close the run before rethrowing. Without this the lease above is
       * the only way out, and every computation for this scope is refused
       * for half an hour after any failure.
       */
      await this.prisma.marketSignalRun.updateMany({
        where: { id: run.id, status: 'RUNNING' },
        data: { status: 'FAILED', finishedAt: clock() },
      });

      throw error;
    }
  }

  private async runComputation(context: {
    runId: string;
    sourceScopeKey: string;
    rulesetVersion: number;
    scopes: readonly string[];
    clock: () => Date;
    input: ComputeInput;
  }): Promise<{
    runId: string;
    status: 'SUCCEEDED' | 'FAILED';
    signalCount: number;
    coverageComplete: boolean;
  }> {
    const { input, scopes, rulesetVersion } = context;

    const coverage = await this.coverageState({
      sourceSlug: input.sourceSlug,
      scopes,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
    });

    const observed = await this.observedPostings({
      sourceSlug: input.sourceSlug,
      scopes,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      rulesetVersion,
    });

    const projected = projectSignals(observed.postings, {
      minDenominator: input.minDenominator,
      minDistinctCompanies: input.minDistinctCompanies,
    });

    /*
     * A run that matched no observation at all is FAILED, not SUCCEEDED.
     *
     * Status is derived here the way an ingestion run's is, and for the
     * same reason. A computation over scopes that match nothing produced
     * two SUCCEEDED, zero-signal rows in this database already - and
     * because the read side picks the most recent SUCCEEDED run, a
     * mistyped argument was one minute away from serving "the market
     * contains no roles" to every reader. Emptiness caused by asking the
     * wrong question must not be publishable as an answer.
     */
    const status: 'SUCCEEDED' | 'FAILED' =
      observed.postings.length === 0 ? 'FAILED' : 'SUCCEEDED';

    const stats = {
      ...projected.stats,
      scopesRequested: scopes.length,
      scopesCompletelyRead: coverage.completeScopes,
      scopesIncompleteReads: coverage.incompleteReads,
      /*
       * Observed postings whose latest in-window version has no
       * normalization at this ruleset version. They are absent from every
       * denominator, so the count is recorded rather than left as a silent
       * shrinkage.
       */
      postingsMissingNormalization: observed.missingNormalization,
      sightingsScanned: observed.sightingsScanned,
      failureReason: status === 'FAILED' ? 'no_observations_in_window' : null,
    };

    /*
     * The signals and the run's terminal status are written together.
     * Written separately, a crash mid-loop left N of 246 rows attached to
     * a run that stayed RUNNING for ever - invisible to reads, permanent,
     * and blocking every later computation for the scope.
     */
    await this.prisma.$transaction([
      this.prisma.marketSignal.createMany({
        data: projected.signals.map((signal) => ({
          runId: context.runId,
          signalType: signal.signalType,
          roleId: signal.roleId,
          skillId: signal.skillId,
          numeratorCount: signal.numeratorCount,
          denominatorCount: signal.denominatorCount,
          distinctCompanyCount: signal.distinctCompanyCount,
          distinctSourceCount: signal.distinctSourceCount,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          rulesetVersion,
          computationVersion: COMPUTATION_VERSION,
          sourceScopeKey: context.sourceScopeKey,
          dedupeMethod: 'NONE' as const,
          coverageComplete: coverage.complete,
          computedAt: input.now,
        })),
      }),
      this.prisma.marketSignalRun.updateMany({
        where: { id: context.runId, status: 'RUNNING' },
        data: {
          status,
          coverageComplete: coverage.complete,
          /* A live read, so the pair records a real duration. */
          finishedAt: context.clock(),
          stats: stats as unknown as Prisma.InputJsonObject,
        },
      }),
    ]);

    return {
      runId: context.runId,
      status,
      signalCount: projected.signals.length,
      coverageComplete: coverage.complete,
    };
  }

  /**
   * How completely each scope was read inside the window.
   *
   * The predicate is the MOST RECENT coverage row per scope, not merely
   * whether any complete read exists. The existential form proved far less
   * than its name suggested: one healthy read on day 1 followed by
   * twenty-nine days of failures still satisfied it, so a boolean saying
   * "every board in scope was read completely" could sit on top of a
   * sample that was one day old for nine boards out of ten - and no amount
   * of subsequent failure could ever turn it off.
   *
   * Still scoped rather than global: a signal over {vercel, stripe} must
   * not be flagged because an unrelated board 404'd, or every signal ships
   * permanently flagged and the flag becomes noise nobody reads.
   */
  private async coverageState(input: {
    sourceSlug: string;
    scopes: readonly string[];
    windowStart: Date;
    windowEnd: Date;
  }): Promise<{
    complete: boolean;
    completeScopes: number;
    incompleteReads: number;
  }> {
    let completeScopes = 0;
    let incompleteReads = 0;

    for (const scope of input.scopes) {
      const rows = await this.prisma.marketRunScopeCoverage.findMany({
        where: {
          sourceScope: scope,
          source: { slug: input.sourceSlug },
          finishedAt: { gte: input.windowStart, lt: input.windowEnd },
        },
        /*
         * Most recent first. runId breaks a finishedAt tie; it is a uuid,
         * but this only decides which of two rows finishing in the same
         * millisecond is called "latest", and both are inside the window.
         */
        orderBy: [{ finishedAt: 'desc' }, { runId: 'desc' }],
        select: { completeForScope: true },
      });

      if (rows.length === 0) {
        continue;
      }

      incompleteReads += rows.filter((row) => !row.completeForScope).length;

      if (rows[0]?.completeForScope === true) {
        completeScopes += 1;
      }
    }

    return {
      complete: completeScopes === input.scopes.length,
      completeScopes,
      incompleteReads,
    };
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
   *
   * The walk is PAGED TO EXHAUSTION. It must never stop early: a partial
   * read of the window produces a smaller denominator that is
   * indistinguishable from a real one.
   */
  private async observedPostings(input: {
    sourceSlug: string;
    scopes: readonly string[];
    windowStart: Date;
    windowEnd: Date;
    rulesetVersion: number;
  }): Promise<{
    postings: ObservedPosting[];
    missingNormalization: number;
    sightingsScanned: number;
  }> {
    const latestVersionByPosting = new Map<string, string>();
    let sightingsScanned = 0;

    for (let skip = 0; ; skip += SIGHTING_PAGE_SIZE) {
      const page = await this.prisma.marketPostingSighting.findMany({
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
        skip,
        take: SIGHTING_PAGE_SIZE,
        select: { postingId: true, versionId: true },
      });

      sightingsScanned += page.length;

      for (const sighting of page) {
        if (!latestVersionByPosting.has(sighting.postingId)) {
          latestVersionByPosting.set(sighting.postingId, sighting.versionId);
        }
      }

      if (latestVersionByPosting.size > MAX_OBSERVED_POSTINGS) {
        throw new ConflictException(
          `Window contains more than ${MAX_OBSERVED_POSTINGS} postings; refusing to compute from a partial read`,
        );
      }

      if (page.length < SIGHTING_PAGE_SIZE) {
        break;
      }
    }

    if (latestVersionByPosting.size === 0) {
      return { postings: [], missingNormalization: 0, sightingsScanned };
    }

    const normalizations =
      await this.prisma.marketPostingNormalization.findMany({
        where: {
          rulesetVersion: input.rulesetVersion,
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
            where: {
              rulesetVersion: input.rulesetVersion,
              skillId: { not: null },
            },
            orderBy: { skillId: 'asc' },
            select: { skillId: true },
          },
        },
      });

    const postings = normalizations
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
      .sort((a, b) =>
        a.postingId < b.postingId ? -1 : a.postingId > b.postingId ? 1 : 0,
      );

    return {
      postings,
      missingNormalization: latestVersionByPosting.size - normalizations.length,
      sightingsScanned,
    };
  }
}
