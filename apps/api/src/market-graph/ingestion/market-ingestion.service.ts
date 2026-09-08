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
import { redactRecord } from '../observations/redaction.js';
import type {
  IdentityBasis,
  RawPostingRecord,
  SourceDescriptor,
} from '../sources/source-adapter.js';
import {
  MarketIngestionRunService,
  type RunStats,
  type ScopeCoverage,
} from './market-ingestion-run.service.js';
import { MarketVocabularyService } from './market-vocabulary.service.js';

/*
 * Fetch -> parse -> persist, for any source.
 *
 * The only impure layer in the observation half of Phase 8. Everything it
 * decides is decided by the pure modules it calls; what it adds is the
 * network, the clock and the database, in that order and nowhere else.
 *
 * It used to be a Greenhouse driver under a general name: it constructed a
 * GreenhouseAdapter as a field, took a GreenhouseClient in its
 * constructor, exposed one method called ingestGreenhouse, hard-coded
 * 'SOURCE_ID' twice, imported one source's politeness delay as the
 * pipeline's pacing, and matched `instanceof GreenhouseRequestError` to
 * classify every failure. The adapter contract was real for parsing and
 * absent for everything around it, so adding a second source would have
 * meant duplicating all of this rather than passing a different descriptor.
 */

/** A ceiling, so a bad scope list can never become an unbounded crawl. */
const MAX_SCOPES_PER_RUN = 100;

/*
 * The shape a scope may take, checked BEFORE the network walk.
 *
 * The authority is the CHECK constraint on MarketPosting.sourceScope; this
 * mirrors it, and a boundary test asserts every copy of this pattern in
 * the tree is identical to the constraint. Checked here because the
 * constraint fires mid-persistPosting, i.e. after a whole scope has been
 * fetched over HTTP - so a source scoped by ISO country code ("GB", "US")
 * would spend the entire walk before failing on the first row it tried to
 * write. Signal computation already validated this; ingestion never did.
 */
const SCOPE_SHAPE = /^[a-z0-9*][a-z0-9._*-]*$/;

/**
 * Was this a unique violation on the constraint we expected?
 *
 * The constraint is checked, not just the code. Several unique constraints
 * sit on this write path, and treating "a run is already live for this
 * source" as "this posting already exists" would silently swallow a
 * concurrency refusal and carry on writing.
 *
 * It has to read the DRIVER ADAPTER's error shape, and that was a real bug
 * rather than defensive coding. PrismaService uses PrismaPg, and under a
 * driver adapter Prisma does not populate `meta.target` at all - it
 * populates `meta.driverAdapterError.cause.constraint.index` with the
 * constraint name. Verified against the live database: a duplicate slug
 * gives `meta.target === undefined` and
 * `meta.driverAdapterError.cause.constraint.index === 'MarketRole_slug_key'`.
 * So the previous implementation returned false for EVERY P2002, and the
 * sighting insert's "a retry of the same run is a no-op" guarantee was in
 * fact "a retry re-throws and kills the run". Unreachable with a source
 * that returns each posting once per walk; reachable on the first walk of
 * a paginated one, which is exactly what the sighting table's three-part
 * key exists to accommodate.
 *
 * `meta.target` is still honoured, so this keeps working without an adapter.
 */
function isUniqueViolationOn(
  error: unknown,
  expected: { index: string; column: string },
): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002'
  ) {
    return false;
  }

  const meta = error.meta as
    | {
        target?: unknown;
        driverAdapterError?: { cause?: { constraint?: { index?: unknown } } };
      }
    | undefined;

  const index = meta?.driverAdapterError?.cause?.constraint?.index;

  if (typeof index === 'string') {
    return index === expected.index;
  }

  const target = meta?.target;

  return Array.isArray(target)
    ? target.includes(expected.column)
    : target === expected.column;
}

export type IngestResult = {
  runId: string;
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  stats: RunStats;
};

@Injectable()
export class MarketIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: MarketIngestionRunService,
    private readonly vocabulary: MarketVocabularyService,
  ) {}

  /**
   * Ingests a list of scopes from one source as one run.
   *
   * `now` is the run clock. Every sighting this run writes carries it as
   * `capturedAt`; `observedAt` is read per scope, because a walk over many
   * scopes spans minutes and pretending otherwise would put postings in
   * the wrong signal window.
   */
  async ingest(input: {
    source: SourceDescriptor;
    scopes: readonly string[];
    now: Date;
    clock?: () => Date;
  }): Promise<IngestResult> {
    const clock = input.clock ?? (() => new Date());
    const { adapter, client } = input.source;

    const source = await this.vocabulary.ensureSource(input.source);

    /*
     * A disabled source is not ingested, and the refusal is loud. Without
     * this check isEnabled would be a comment: a column recording an
     * intention that no code path consulted, which is worse than not
     * having it, because a reader would believe it was doing something.
     */
    if (!source.isEnabled) {
      throw new ConflictException(
        `Market source ${source.slug} is not enabled`,
      );
    }

    /*
     * The adapter and the source row must agree about how identity is
     * derived. They are two independent statements about one fact, and a
     * disagreement means one of them is lying to every reader of every
     * posting this run writes.
     */
    if (source.identityBasis !== adapter.identityBasis) {
      throw new ConflictException(
        `Source ${source.slug} records identity basis ${source.identityBasis} but its adapter declares ${adapter.identityBasis}`,
      );
    }

    const requested = [...new Set(input.scopes)].sort();

    if (requested.length === 0) {
      throw new ConflictException('At least one scope is required');
    }

    /*
     * Refused rather than silently truncated. Slicing to a ceiling and
     * then counting the SLICED list as "requested" meant a caller could
     * ask for 150 scopes, have 50 never fetched, and still get SUCCEEDED -
     * with no coverage row for the 50 to make them findable.
     */
    if (requested.length > MAX_SCOPES_PER_RUN) {
      throw new ConflictException(
        `Too many scopes: ${requested.length} requested, ceiling is ${MAX_SCOPES_PER_RUN}`,
      );
    }

    const malformed = requested.filter((scope) => !SCOPE_SHAPE.test(scope));

    if (malformed.length > 0) {
      throw new ConflictException(
        `Malformed scopes: ${malformed.join(', ')}`,
      );
    }

    const run = await this.runs.start({
      sourceId: source.id,
      adapterVersion: adapter.adapterVersion,
      rulesetVersion: RULESET_VERSION,
      queryParams: {
        ...input.source.queryParams,
        scopes: requested,
        identityVersion: IDENTITY_VERSION,
        contentHashVersion: CONTENT_HASH_VERSION,
      },
      now: input.now,
    });

    /*
     * Everything from here to `finish` runs inside a try, and the catch
     * closes the run.
     *
     * Two try/catch blocks already existed - one around a page fetch, one
     * around the sighting insert - and neither covered the scope loop or
     * persistPosting. So any other throw (a constraint violation, a
     * parameter-limit error, an OOM on a large payload) escaped with the
     * run still RUNNING, and the partial unique index then blocked EVERY
     * later run for that source until the 30-minute lease expired, with no
     * errorReason recorded. 8.8 fixed exactly this for signal runs and
     * left the path with the network in it untouched. `fail` had been
     * written for this and had no callers at all.
     */
    try {
      return await this.runScopes({
        run,
        source,
        descriptor: input.source,
        requested,
        now: input.now,
        clock,
      });
    } catch (error) {
      /*
       * A short fixed code. The caught error is never inspected, never
       * stored and never logged - a source that needs a credential would
       * otherwise put it in the database via its own error message.
       */
      await this.runs.fail({
        runId: run.id,
        reason: 'ingestion_aborted',
        now: clock(),
      });

      throw error;
    }
  }

  private async runScopes(context: {
    run: { id: string };
    source: { id: string; slug: string };
    descriptor: SourceDescriptor;
    requested: string[];
    now: Date;
    clock: () => Date;
  }): Promise<IngestResult> {
    const { run, source, descriptor, requested, now, clock } = context;
    const { adapter, client } = descriptor;

    const runRow = await this.prisma.marketIngestionRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { runSeq: true },
    });

    const coverage: ScopeCoverage[] = [];
    let postingsCreated = 0;
    let versionsCreated = 0;
    let sightingsCreated = 0;
    let scopeOrdinal = 0;

    for (const [scopeIndex, scope] of requested.entries()) {
      if (scopeIndex > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, client.interScopeDelayMs),
        );
      }

      const walk = await this.walkScope({ source: descriptor, scope, clock });

      if (walk.failureReason !== null) {
        const failed: ScopeCoverage = {
          sourceScope: scope,
          read: false,
          completeForScope: false,
          pagesFetched: walk.pagesFetched,
          failureReason: walk.failureReason,
          postingsSeen: 0,
          postingsAccepted: 0,
          postingsRejected: 0,
          duplicatesDropped: 0,
        };

        coverage.push(failed);

        await this.recordCoverage({
          runId: run.id,
          sourceId: source.id,
          coverage: failed,
          now: clock(),
        });

        continue;
      }

      /*
       * Deduplicated once per SCOPE, not once per page. A paginated source
       * can return one posting on two pages when the underlying set shifts
       * mid-walk; per-page dedupe would miss that. The stored rows would
       * still be right - the sighting insert refuses the duplicate - but
       * `duplicatesDropped` would under-report and the walk would look
       * cleaner than it was.
       */
      const { ordered, duplicatesDropped } = orderAndDedupe(walk.accepted);

      for (const [position, record] of ordered.entries()) {
        const written = await this.persistPosting({
          sourceId: source.id,
          sourceSlug: source.slug,
          identityBasis: adapter.identityBasis,
          runId: run.id,
          runSeq: runRow.runSeq,
          record,
          observedAt: walk.observedAt,
          capturedAt: now,
          pageIndex: scopeOrdinal,
          indexInPage: position,
        });

        if (written.postingCreated) postingsCreated += 1;
        if (written.versionCreated) versionsCreated += 1;
        if (written.sightingCreated) sightingsCreated += 1;
      }

      scopeOrdinal += 1;

      const scopeCoverage: ScopeCoverage = {
        sourceScope: scope,
        read: true,
        /*
         * Read to the END, which is a different claim. False when the walk
         * stopped at the client's page ceiling with a cursor still
         * outstanding - the source had more and would not serve it.
         */
        completeForScope: walk.exhausted,
        pagesFetched: walk.pagesFetched,
        failureReason: null,
        postingsSeen: walk.accepted.length + walk.rejected,
        postingsAccepted: ordered.length,
        postingsRejected: walk.rejected,
        duplicatesDropped,
      };

      coverage.push(scopeCoverage);

      await this.recordCoverage({
        runId: run.id,
        sourceId: source.id,
        coverage: scopeCoverage,
        now: clock(),
      });
    }

    const stats: RunStats = {
      scopes: coverage,
      scopesRequested: requested.length,
      scopesRead: coverage.filter((entry) => entry.read).length,
      scopesComplete: coverage.filter((entry) => entry.completeForScope).length,
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

  /**
   * Walks one scope to the end, or to the client's page ceiling.
   *
   * Returns whether the scope was EXHAUSTED, which is the fact both the
   * run status and the coverage ledger turn on.
   */
  private async walkScope(input: {
    source: SourceDescriptor;
    scope: string;
    clock: () => Date;
  }): Promise<{
    accepted: RawPostingRecord[];
    rejected: number;
    pagesFetched: number;
    exhausted: boolean;
    observedAt: Date;
    failureReason: string | null;
  }> {
    const { adapter, client } = input.source;

    const accepted: RawPostingRecord[] = [];
    let rejected = 0;
    let pagesFetched = 0;
    let cursor: string | null = null;
    const observedAt = input.clock();

    for (let page = 0; page < client.maxPagesPerScope; page += 1) {
      let fetched: { body: unknown; nextCursor: string | null };

      try {
        fetched = await client.fetchScope(input.scope, cursor);
      } catch (error) {
        /*
         * A scope we could not read is recorded as NOT read and NOT
         * complete. In particular a 404 is not "this employer has no
         * jobs": the body is identical for a mistyped token, a renamed
         * board and a genuinely retired one, and reading it as emptiness
         * would age every posting in that scope to closed on the strength
         * of a typo. Fails closed.
         *
         * The reason code comes from the CLIENT, which is the only thing
         * that knows its own error type. Matching one source's error class
         * here meant every other source's failures collapsed to
         * 'unexpected_response' - a rate limit and a dead credential
         * recorded identically.
         */
        return {
          accepted,
          rejected,
          pagesFetched,
          exhausted: false,
          observedAt,
          failureReason: client.classifyFailure(error),
        };
      }

      pagesFetched += 1;

      const parsed = adapter.parse(fetched.body, input.scope);

      /*
       * Redacted here, by the pipeline, and not left to the adapter.
       *
       * An adapter MAY also redact - JobTech does, and its own tests check
       * it - and doing both is safe because the operation is idempotent:
       * the sentinels contain no address and no number. What this line
       * buys is that forgetting is not possible. Applied before dedupe and
       * therefore before every hash, so what a version commits to is the
       * redacted text.
       */
      accepted.push(
        ...parsed.accepted.map((record) =>
          redactRecord(record, adapter.contactRedaction),
        ),
      );
      rejected += parsed.rejected.length;
      cursor = fetched.nextCursor;

      if (cursor === null) {
        return {
          accepted,
          rejected,
          pagesFetched,
          exhausted: true,
          observedAt,
          failureReason: null,
        };
      }
    }

    /*
     * The ceiling was reached with a cursor still outstanding. Every
     * request succeeded, so the scope was READ; the source has more than
     * it would serve, so it was not read COMPLETELY.
     */
    return {
      accepted,
      rejected,
      pagesFetched,
      exhausted: false,
      observedAt,
      failureReason: null,
    };
  }

  private async recordCoverage(input: {
    runId: string;
    sourceId: string;
    coverage: ScopeCoverage;
    now: Date;
  }): Promise<void> {
    /*
     * Written per scope as the run proceeds, not batched at the end. A run
     * that dies mid-walk then still leaves an honest record of the scopes
     * it did read, instead of leaving none and looking like a run that
     * read nothing.
     */
    await this.prisma.marketRunScopeCoverage.create({
      data: {
        runId: input.runId,
        sourceId: input.sourceId,
        sourceScope: input.coverage.sourceScope,
        requested: true,
        read: input.coverage.read,
        completeForScope: input.coverage.completeForScope,
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
   * immutable row keyed by a hash of themselves.
   */
  private async persistPosting(input: {
    sourceId: string;
    sourceSlug: string;
    identityBasis: IdentityBasis;
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
      /*
       * Read from the adapter, not hard-coded. The literal 'SOURCE_ID' was
       * written here twice while MarketSource.identityBasis and
       * SourceAdapter.identityBasis both existed and neither was read - so
       * a URL-identified source would have been stamped `sid:` and stored
       * as SOURCE_ID, claiming a stronger provenance than its data
       * supports, in the exact column that exists to make the basis
       * falsifiable.
       */
      identityBasis: input.identityBasis,
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
        identityBasis: input.identityBasis,
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
           * internal edit at the source does not mint a fresh version;
           * recording it here is what stops that exclusion losing the
           * information.
           */
          sourceUpdatedAt: toDate(record.sourceUpdatedAt),
          pageIndex: input.pageIndex,
          indexInPage: input.indexInPage,
        },
      });

      sightingCreated = true;
    } catch (error) {
      if (
        !isUniqueViolationOn(error, {
          index: 'MarketPostingSighting_pkey',
          column: 'postingId',
        })
      ) {
        throw error;
      }
      /*
       * This run has already recorded this posting at this version - a
       * paginated source returning it on two pages, or a retry of the same
       * run. Either way it is a no-op, which is what makes re-running a
       * failed ingest safe.
       */
    }

    if (sightingCreated) {
      /*
       * Monotonic. The guard means a late-finishing retry whose observedAt
       * is older than a run that already completed cannot walk the
       * posting's last-seen time backwards.
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
