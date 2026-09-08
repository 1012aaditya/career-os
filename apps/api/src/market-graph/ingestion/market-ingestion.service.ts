import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';
import { normalizeCompany } from '../normalization/normalize.js';
import { RULESET_VERSION } from '../normalization/ruleset.js';
import {
  CONTENT_HASH_VERSION,
  IDENTITY_VERSION,
  orderAndDedupe,
  postingContentHash,
  postingExternalId,
  rawPayloadHash,
} from '../observations/posting-identity.js';
import { GreenhouseAdapter } from '../sources/greenhouse/greenhouse.adapter.js';
import {
  GreenhouseClient,
  GreenhouseRequestError,
  INTER_BOARD_DELAY_MS,
} from '../sources/greenhouse/greenhouse.client.js';
import type { RawPostingRecord } from '../sources/source-adapter.js';
import {
  type BoardCoverage,
  MarketIngestionRunService,
  type RunStats,
} from './market-ingestion-run.service.js';
import { MarketVocabularyService } from './market-vocabulary.service.js';

/*
 * Fetch -> parse -> persist.
 *
 * The only impure layer in the observation half of Phase 8. Everything it
 * decides is decided by the pure modules it calls; what it adds is the
 * network, the clock and the database, in that order and nowhere else.
 *
 * The clock is taken as a parameter, never read here. That is what lets
 * the determinism tests advance time deliberately and assert that nothing
 * except the fields allowed to move actually moved.
 */

/** A ceiling, so a bad board list can never become an unbounded crawl. */
const MAX_BOARDS_PER_RUN = 100;

function isUniqueViolationOn(error: unknown, column: string): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002'
  ) {
    return false;
  }

  /*
   * The target is checked, not just the code.
   *
   * Six unique constraints sit on this write path, and treating "a run is
   * already live for this source" as "this posting already exists" would
   * silently swallow a concurrency refusal and carry on writing. A P2002
   * we did not specifically expect is re-thrown.
   */
  const target = error.meta?.target;

  return Array.isArray(target) ? target.includes(column) : target === column;
}

export type IngestResult = {
  runId: string;
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  stats: RunStats;
};

@Injectable()
export class MarketIngestionService {
  private readonly adapter = new GreenhouseAdapter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: GreenhouseClient,
    private readonly runs: MarketIngestionRunService,
    private readonly vocabulary: MarketVocabularyService,
  ) {}

  /**
   * Ingests a list of Greenhouse boards as one run.
   *
   * `now` is the run clock. Every sighting this run writes carries it as
   * `capturedAt`; `observedAt` is read per board, because a walk over forty
   * boards spans minutes and pretending otherwise would put postings in the
   * wrong signal window.
   */
  async ingestGreenhouse(input: {
    boardTokens: readonly string[];
    now: Date;
    clock?: () => Date;
  }): Promise<IngestResult> {
    const clock = input.clock ?? (() => new Date());

    const source = await this.vocabulary.ensureGreenhouseSource();

    /*
     * A disabled source is not ingested, and the refusal is loud.
     *
     * Without this check isEnabled would be a comment: the column would
     * record an intention that no code path consulted, which is worse than
     * not having it, because a reader would believe it was doing something.
     */
    if (!source.isEnabled) {
      throw new ConflictException(
        `Market source ${source.slug} is not enabled`,
      );
    }

    /*
     * Sorted and de-duplicated before anything else. The caller's ordering
     * is not data, and a board listed twice would otherwise be fetched
     * twice and counted twice in the coverage record.
     */
    const boards = [...new Set(input.boardTokens)]
      .sort()
      .slice(0, MAX_BOARDS_PER_RUN);

    const queryParams = {
      boards,
      contentIncluded: true,
      identityVersion: IDENTITY_VERSION,
      contentHashVersion: CONTENT_HASH_VERSION,
    };

    const run = await this.runs.start({
      sourceId: source.id,
      adapterVersion: this.adapter.adapterVersion,
      rulesetVersion: RULESET_VERSION,
      queryParams,
      now: input.now,
    });

    const runRow = await this.prisma.marketIngestionRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { runSeq: true },
    });

    const coverage: BoardCoverage[] = [];
    let postingsCreated = 0;
    let versionsCreated = 0;
    let sightingsCreated = 0;

    for (const [boardIndex, boardToken] of boards.entries()) {
      if (boardIndex > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, INTER_BOARD_DELAY_MS),
        );
      }

      const observedAt = clock();

      let body: unknown;

      try {
        body = await this.client.fetchBoard(boardToken);
      } catch (error) {
        const reason =
          error instanceof GreenhouseRequestError
            ? error.reason
            : 'unexpected_response';

        /*
         * A board we could not read is recorded as NOT read and NOT
         * complete. In particular a 404 is not "this employer has no jobs":
         * the body is byte-identical for a mistyped token, a renamed board
         * and a genuinely retired one, and reading it as emptiness would
         * age every posting on that board to closed on the strength of a
         * typo. Fails closed.
         */
        coverage.push({
          boardToken,
          fetched: false,
          failureReason: reason,
          postingsSeen: 0,
          postingsAccepted: 0,
          postingsRejected: 0,
          duplicatesDropped: 0,
        });

        await this.recordCoverage({
          runId: run.id,
          sourceId: source.id,
          coverage: coverage[coverage.length - 1]!,
          now: clock(),
        });

        continue;
      }

      const parsed = this.adapter.parse(body, boardToken);
      const { ordered, duplicatesDropped } = orderAndDedupe(parsed.accepted);

      for (const [position, record] of ordered.entries()) {
        const written = await this.persistPosting({
          sourceId: source.id,
          sourceSlug: source.slug,
          runId: run.id,
          runSeq: runRow.runSeq,
          record,
          observedAt,
          capturedAt: input.now,
          pageIndex: boardIndex,
          indexInPage: position,
        });

        if (written.postingCreated) postingsCreated += 1;
        if (written.versionCreated) versionsCreated += 1;
        if (written.sightingCreated) sightingsCreated += 1;
      }

      const boardCoverage: BoardCoverage = {
        boardToken,
        fetched: true,
        failureReason: null,
        postingsSeen: parsed.accepted.length + parsed.rejected.length,
        postingsAccepted: ordered.length,
        postingsRejected: parsed.rejected.length,
        duplicatesDropped,
      };

      coverage.push(boardCoverage);

      await this.recordCoverage({
        runId: run.id,
        sourceId: source.id,
        coverage: boardCoverage,
        now: clock(),
      });
    }

    const stats: RunStats = {
      boards: coverage,
      boardsRequested: boards.length,
      boardsFetched: coverage.filter((entry) => entry.fetched).length,
      postingsAccepted: coverage.reduce((n, c) => n + c.postingsAccepted, 0),
      postingsRejected: coverage.reduce((n, c) => n + c.postingsRejected, 0),
      duplicatesDropped: coverage.reduce((n, c) => n + c.duplicatesDropped, 0),
      postingsCreated,
      versionsCreated,
      sightingsCreated,
    };

    const finished = await this.runs.finish({
      runId: run.id,
      stats,
      now: clock(),
    });

    return { runId: run.id, status: finished.status, stats };
  }

  private async recordCoverage(input: {
    runId: string;
    sourceId: string;
    coverage: BoardCoverage;
    now: Date;
  }): Promise<void> {
    /*
     * Written per board as the run proceeds, not batched at the end. A run
     * that dies mid-walk then still leaves an honest record of the boards
     * it did read, instead of leaving no record and looking like a run that
     * read nothing.
     */
    await this.prisma.marketRunScopeCoverage.create({
      data: {
        runId: input.runId,
        sourceId: input.sourceId,
        sourceScope: input.coverage.boardToken,
        requested: true,
        read: input.coverage.fetched,
        /*
         * For Greenhouse these are the same question: the whole board
         * arrives in one response, so a fetch that completed read the
         * scope completely. A paginated source will have to distinguish
         * them, which is why they are two columns.
         */
        completeForScope: input.coverage.fetched,
        failureReason: input.coverage.failureReason,
        postingsSeen: input.coverage.postingsSeen,
        postingsAccepted: input.coverage.postingsAccepted,
        postingsRejected: input.coverage.postingsRejected,
        duplicatesDropped: input.coverage.duplicatesDropped,
        finishedAt: input.now,
      },
    });
  }

  /**
   * Writes one posting: identity, content, and the fact that we saw it.
   *
   * The order is deliberate and so is what each step is allowed to touch.
   * Re-ingesting an unchanged posting appends exactly one sighting row and
   * advances exactly one column; every content field and every source
   * timestamp is untouchable by this path, because they live on an
   * immutable row that is keyed by a hash of themselves.
   */
  private async persistPosting(input: {
    sourceId: string;
    sourceSlug: string;
    runId: string;
    runSeq: number;
    record: RawPostingRecord;
    observedAt: Date;
    capturedAt: Date;
    pageIndex: number;
    indexInPage: number;
  }): Promise<{
    postingCreated: boolean;
    versionCreated: boolean;
    sightingCreated: boolean;
  }> {
    const { record } = input;

    const externalId = postingExternalId({
      sourceSlug: input.sourceSlug,
      identityBasis: 'SOURCE_ID',
      sourceScope: record.sourceScope,
      externalKey: record.externalKey,
    });

    const existing = await this.prisma.marketPosting.findUnique({
      where: { externalId },
      select: { id: true },
    });

    /*
     * upsert rather than a "does it exist?" pre-check as the correctness
     * mechanism. Under READ COMMITTED two overlapping runs would both read
     * "absent" and both insert; the constraint does the work in every
     * design, and the only question is whether the complaint is handled.
     * The read above is for reporting created-vs-updated, nothing else.
     */
    const posting = await this.prisma.marketPosting.upsert({
      where: { externalId },
      /*
       * Empty. firstSeenAt, externalId, externalKey and sourceScope are
       * identity and appear in no update payload - moving any of them
       * would turn an update into an impersonation. lastSeenAt is advanced
       * separately, under a guard, and only if a sighting was really
       * written.
       */
      update: {},
      create: {
        sourceId: input.sourceId,
        externalId,
        identityBasis: 'SOURCE_ID',
        identityVersion: IDENTITY_VERSION,
        externalKey: record.externalKey,
        sourceScope: record.sourceScope,
        externalGroupKey: record.externalGroupKey,
        firstSeenAt: input.observedAt,
        lastSeenAt: input.observedAt,
        companyRaw: record.companyRaw,
        companyNormalized: normalizeCompany(record.companyRaw),
        applyUrlCanonical: record.applyUrlRaw,
      },
      select: { id: true },
    });

    const contentHash = postingContentHash(record);

    const existingVersion = await this.prisma.marketPostingVersion.findUnique({
      where: {
        postingId_contentHashVersion_contentHash: {
          postingId: posting.id,
          contentHashVersion: CONTENT_HASH_VERSION,
          contentHash,
        },
      },
      select: { id: true },
    });

    const version = await this.prisma.marketPostingVersion.upsert({
      where: {
        postingId_contentHashVersion_contentHash: {
          postingId: posting.id,
          contentHashVersion: CONTENT_HASH_VERSION,
          contentHash,
        },
      },
      /* Immutable by contract. There is nothing here that may be updated. */
      update: {},
      create: {
        postingId: posting.id,
        contentHashVersion: CONTENT_HASH_VERSION,
        contentHash,
        firstSeenRunId: input.runId,
        firstSeenAt: input.observedAt,
        titleRaw: record.titleRaw,
        companyRaw: record.companyRaw,
        locationRaw: record.locationRaw,
        descriptionRaw: record.descriptionRaw,
        descriptionCompleteness: record.descriptionCompleteness,
        sourcePublishedAt: toDate(record.sourcePublishedAt),
        sourceUpdatedAt: toDate(record.sourceUpdatedAt),
        sourceValidThrough: toDate(record.sourceValidThrough),
        applyUrlRaw: record.applyUrlRaw,
        sourceCategoriesRaw: record.sourceCategoriesRaw,
        rawPayload: record.payload as Prisma.InputJsonObject,
        rawPayloadHash: rawPayloadHash(record),
      },
      select: { id: true },
    });

    let sightingCreated = false;

    try {
      await this.prisma.marketPostingSighting.create({
        data: {
          runId: input.runId,
          postingId: posting.id,
          versionId: version.id,
          observedAt: input.observedAt,
          capturedAt: input.capturedAt,
          runSeq: input.runSeq,
          /*
           * The source's claim about its own last update, kept per
           * observation. It is excluded from the content hash so an
           * internal ATS touch does not mint a 20KB version; recording it
           * here is what stops that exclusion losing the information.
           */
          sourceUpdatedAt: toDate(record.sourceUpdatedAt),
          pageIndex: input.pageIndex,
          indexInPage: input.indexInPage,
        },
      });

      sightingCreated = true;
    } catch (error) {
      if (!isUniqueViolationOn(error, 'postingId')) {
        throw error;
      }
      /*
       * This run has already recorded this posting at this version. A
       * retry of the same run is a no-op, which is what makes re-running a
       * failed ingest safe.
       */
    }

    if (sightingCreated) {
      /*
       * Monotonic. GREATEST in effect: the guard means a late-finishing
       * retry whose observedAt is older than a run that already completed
       * cannot walk the posting's last-seen time backwards.
       */
      await this.prisma.marketPosting.updateMany({
        where: { id: posting.id, lastSeenAt: { lt: input.observedAt } },
        data: { lastSeenAt: input.observedAt },
      });
    }

    if (existingVersion === null && existing !== null) {
      /*
       * The content changed on a posting we already knew. The denormalized
       * lookup columns follow the newest content; they are explicitly not
       * authoritative and nothing counts them.
       */
      await this.prisma.marketPosting.update({
        where: { id: posting.id },
        data: {
          companyRaw: record.companyRaw,
          companyNormalized: normalizeCompany(record.companyRaw),
          applyUrlCanonical: record.applyUrlRaw,
        },
      });
    }

    return {
      postingCreated: existing === null,
      versionCreated: existingVersion === null,
      sightingCreated,
    };
  }
}

function toDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}
