import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { canonicalHash } from '../../common/canonical-hash.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/*
 * Deleting everything one source ever gave us.
 *
 * The only destructive operation in Phase 8, and the only one that can
 * falsify the phase's central claim - that every published number resolves
 * to retained raw evidence. It exists because a licence position can be
 * withdrawn, and a takedown that cannot be honoured is a licence risk
 * rather than a licence decision.
 *
 * Three properties do the work, and each is here because the obvious
 * implementation lacks it:
 *
 *   ATOMIC. `deleteMany` on MarketPosting alone would take 31,919 rows
 *   across five tables in one statement through the CASCADE edges, leaving
 *   the signal runs and the coverage ledger behind - a market still
 *   serving numbers whose evidence is gone, which is exactly the state the
 *   RESTRICT graph was added to prevent, reached by the one direction
 *   RESTRICT does not cover.
 *
 *   ATTRIBUTED, NOT GUESSED. Signal runs carry no source column at all.
 *   They are matched by recomputing their scope key, never by scope name
 *   and never by timestamp - the two source runs in this database were
 *   computed 591 milliseconds apart, so any time-based heuristic takes
 *   both.
 *
 *   PROVEN AFTER THE FACT, IN THE SAME TRANSACTION. Global row counts are
 *   taken before and after; every table's delta must equal exactly what
 *   the manifest claims, and the four canonical vocabulary tables' deltas
 *   must be zero. Anything else rolls the whole thing back.
 *
 * What it deliberately does NOT do:
 *
 *   It does not touch MarketRole, MarketSkill, MarketRoleAlias or
 *   MarketSkillAlias. Those come from ruleset.ts - checked-in code, not
 *   source data - and 17 of 19 roles and 59 of 61 skills are referenced by
 *   both sources. "software-engineer is a job title" is not any source's
 *   property, and deleting it would not honour a takedown; it would damage
 *   our own artefact under cover of one. It would also be undone by the
 *   next sync, with a NEW uuid, converting a shared row into a silent
 *   identity split.
 *
 *   It does not delete the MarketSource row. Retaining it is what makes a
 *   second purge a no-op rather than a NotFound indistinguishable from a
 *   typo, and what keeps every historical run attributable - the slug is
 *   the preimage that attribution depends on, so deleting it would strand
 *   every remaining run for ever.
 *
 *   It does not relax a single foreign key. The awkward ordering below is
 *   the safety property, not an obstacle to it: sixteen RESTRICT edges are
 *   what stop a mistyped slug taking a source's whole history in one
 *   statement, and a test now pins every one of them.
 */

/** Long enough for ~32,000 rows across nine tables and ~143 MB of payload. */
const PURGE_TIMEOUT_MS = 300_000;

const PURGE_MAX_WAIT_MS = 30_000;

/** Namespace for the advisory lock, so two purges cannot interleave. */
const PURGE_LOCK_NAMESPACE = 'market-graph-purge';

export type PurgeInput = {
  sourceSlug: string;
  /**
   * A short authored code, never a free-text sentence and never a caught
   * error - the same discipline as `failureReason` elsewhere.
   */
  reason: string;
  /** Refuses to delete anything unless true. The CLI requires --confirm. */
  confirm: boolean;
  now: Date;
};

export type PurgeCounts = {
  marketSignal: number;
  marketSignalRun: number;
  marketPostingSkillMention: number;
  marketPostingNormalization: number;
  marketPostingSighting: number;
  marketPostingVersion: number;
  marketPosting: number;
  marketRunScopeCoverage: number;
  marketIngestionRun: number;
};

export type PurgeManifest = {
  sourceSlug: string;
  sourceId: string;
  reason: string;
  purgedAt: string;
  /** False for a dry run: the counts are what WOULD be deleted. */
  committed: boolean;
  /** True when there was nothing left to delete. Not an error. */
  alreadyPurged: boolean;
  deleted: PurgeCounts;
  retained: {
    marketSource: number;
    marketRole: number;
    marketSkill: number;
    marketRoleAlias: number;
    marketSkillAlias: number;
  };
  attributedSignalRunIds: string[];
  /**
   * Which run the read side publishes, before and after.
   *
   * `latestSignalRun` picks the most recent SUCCEEDED run with signals and
   * has no source filter, so purging one source silently changes what
   * every reader sees - here, back to a run computed 591ms earlier over
   * different scopes. Silently is the problem; this makes it a stated
   * consequence the operator reads before confirming.
   */
  publishedRunBefore: string | null;
  publishedRunAfter: string | null;
  manifestHash: string;
};

type Tx = Prisma.TransactionClient;

/** Every Market table, so a purge cannot quietly touch one it did not name. */
const COUNTED_TABLES = [
  'marketSignal',
  'marketSignalRun',
  'marketPostingSkillMention',
  'marketPostingNormalization',
  'marketPostingSighting',
  'marketPostingVersion',
  'marketPosting',
  'marketRunScopeCoverage',
  'marketIngestionRun',
  'marketSource',
  'marketRole',
  'marketSkill',
  'marketRoleAlias',
  'marketSkillAlias',
] as const;

type CountedTable = (typeof COUNTED_TABLES)[number];

@Injectable()
export class MarketSourcePurgeService {
  constructor(private readonly prisma: PrismaService) {}

  private async globalCounts(tx: Tx): Promise<Record<CountedTable, number>> {
    const entries = await Promise.all(
      COUNTED_TABLES.map(async (table) => {
        const delegate = tx[table] as { count: () => Promise<number> };

        return [table, await delegate.count()] as const;
      }),
    );

    return Object.fromEntries(entries) as Record<CountedTable, number>;
  }

  /**
   * The signal runs belonging to one source.
   *
   * MarketSignalRun stores `scopes` and `sourceScopeKey` and no source
   * column, and the key is `canonicalHash({source, scopes})` - one way. So
   * every run's owner is recovered by recomputing that key for each
   * registered source and matching, which is deterministic and reproduces
   * every key in this database including the two malformed-scope runs
   * whose scope string matches no posting scope on any source.
   *
   * Refuses the whole purge if any run attributes to zero sources or to
   * more than one. A run that cannot be attributed is not a run to skip:
   * skipping it leaves signals about deleted evidence being served, and
   * guessing at it deletes another source's published market.
   */
  private async attributeSignalRuns(
    tx: Tx,
    sourceSlug: string,
  ): Promise<string[]> {
    const slugs = (
      await tx.marketSource.findMany({
        orderBy: { slug: 'asc' },
        select: { slug: true },
      })
    ).map((source) => source.slug);

    const runs = await tx.marketSignalRun.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, scopes: true, sourceScopeKey: true, status: true },
    });

    const attributed: string[] = [];

    for (const run of runs) {
      const owners = slugs.filter(
        (slug) =>
          canonicalHash({ source: slug, scopes: run.scopes }) ===
          run.sourceScopeKey,
      );

      if (owners.length !== 1) {
        throw new ConflictException(
          `Signal run ${run.id} attributes to ${owners.length} sources; refusing to purge`,
        );
      }

      if (owners[0] !== sourceSlug) {
        continue;
      }

      if (run.status === 'RUNNING') {
        throw new ConflictException(
          `Signal run ${run.id} is still RUNNING; refusing to purge`,
        );
      }

      attributed.push(run.id);
    }

    return attributed.sort();
  }

  /**
   * The run the read side would publish right now, if any.
   *
   * The predicate and the ordering must match MarketGraphService's
   * latestSignalRun exactly, tiebreak included. They did not: this used
   * `id: 'asc'` against the read side's `id: 'desc'`, so whenever two runs
   * shared a millisecond the manifest named a different run from the one
   * readers were actually being served - a report about the consequences
   * of a purge that was wrong about them.
   */
  private async publishedRun(tx: Tx): Promise<string | null> {
    const run = await tx.marketSignalRun.findFirst({
      where: { status: 'SUCCEEDED', signals: { some: {} } },
      orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });

    return run?.id ?? null;
  }

  async purge(input: PurgeInput): Promise<PurgeManifest> {
    const source = await this.prisma.marketSource.findUnique({
      where: { slug: input.sourceSlug },
      select: { id: true, slug: true },
    });

    if (source === null) {
      throw new NotFoundException(`Unknown market source: ${input.sourceSlug}`);
    }

    if (input.reason.trim() === '') {
      throw new ConflictException('A purge requires a reason code');
    }

    const running = await this.prisma.marketIngestionRun.count({
      where: { sourceId: source.id, status: 'RUNNING' },
    });

    if (running > 0) {
      throw new ConflictException(
        `${input.sourceSlug} has an ingestion run in progress; refusing to purge`,
      );
    }

    return this.prisma.$transaction(
      async (tx) => {
        /*
         * Serializes purges against each other. It does NOT exclude
         * ingestion, which never takes this lock - ingestion is excluded
         * by the RUNNING check above, by isEnabled being set false as the
         * first write, and by the residue assertion at the end refusing to
         * commit a purge that left a row behind.
         */
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${PURGE_LOCK_NAMESPACE}), hashtext(${input.sourceSlug}))`;

        const before = await this.globalCounts(tx);
        const publishedRunBefore = await this.publishedRun(tx);

        /* Attribution happens BEFORE anything is deleted. Afterwards the
         * evidence that makes a run attributable is gone. */
        const attributed = await this.attributeSignalRuns(tx, source.slug);

        const runIds = (
          await tx.marketIngestionRun.findMany({
            where: { sourceId: source.id },
            orderBy: { id: 'asc' },
            select: { id: true },
          })
        ).map((run) => run.id);

        const byPosting = { posting: { sourceId: source.id } };

        const plan: Array<
          [keyof PurgeCounts, () => Promise<{ count: number }>]
        > = [
          [
            'marketSignal',
            () =>
              tx.marketSignal.deleteMany({
                where: { runId: { in: attributed } },
              }),
          ],
          [
            'marketSignalRun',
            () =>
              tx.marketSignalRun.deleteMany({
                where: { id: { in: attributed } },
              }),
          ],
          [
            'marketPostingSkillMention',
            () =>
              tx.marketPostingSkillMention.deleteMany({
                where: { normalization: { version: byPosting } },
              }),
          ],
          [
            'marketPostingNormalization',
            () =>
              tx.marketPostingNormalization.deleteMany({
                where: { version: byPosting },
              }),
          ],
          /*
           * Two predicates OR'd, on this table and the next two. Nothing
           * in the schema forces a coverage row's sourceId to match its
           * run's, or a version's firstSeenRunId to belong to its
           * posting's source. Both cross-source counts are zero in this
           * database - but that is incidental, not enforced, and a purge
           * must not assume a property no constraint holds.
           */
          [
            'marketPostingSighting',
            () =>
              tx.marketPostingSighting.deleteMany({
                where: {
                  OR: [byPosting, { runId: { in: runIds } }],
                },
              }),
          ],
          [
            'marketPostingVersion',
            () =>
              tx.marketPostingVersion.deleteMany({
                where: {
                  OR: [byPosting, { firstSeenRunId: { in: runIds } }],
                },
              }),
          ],
          [
            'marketPosting',
            () =>
              tx.marketPosting.deleteMany({
                where: { sourceId: source.id },
              }),
          ],
          [
            'marketRunScopeCoverage',
            () =>
              tx.marketRunScopeCoverage.deleteMany({
                where: {
                  OR: [{ sourceId: source.id }, { runId: { in: runIds } }],
                },
              }),
          ],
          [
            'marketIngestionRun',
            () =>
              tx.marketIngestionRun.deleteMany({
                where: { sourceId: source.id },
              }),
          ],
        ];

        const deleted = {
          marketSignal: 0,
          marketSignalRun: 0,
          marketPostingSkillMention: 0,
          marketPostingNormalization: 0,
          marketPostingSighting: 0,
          marketPostingVersion: 0,
          marketPosting: 0,
          marketRunScopeCoverage: 0,
          marketIngestionRun: 0,
        };

        if (input.confirm) {
          /*
           * The interlock, written first and inside the transaction so a
           * rollback takes it with everything else. MarketIngestionService
           * refuses a disabled source, and ensureSource's update block is
           * empty, so a later sync cannot silently re-enable it.
           */
          await tx.marketSource.updateMany({
            /*
             * Conditional, so a second purge writes nothing at all rather
             * than merely deleting nothing. An unconditional update here
             * moved MarketSource.updatedAt on a run that found no rows,
             * which made a repeat takedown indistinguishable from a real
             * one in the row's own timestamps.
             */
            where: { id: source.id, isEnabled: true },
            data: { isEnabled: false },
          });

          for (const [table, run] of plan) {
            deleted[table] = (await run()).count;
          }

          const after = await this.globalCounts(tx);

          /*
           * The proof, and the reason the deletes above are written out
           * one table at a time rather than left to the cascade. A cascade
           * deletes without saying how much; these deltas are checkable.
           */
          for (const table of COUNTED_TABLES) {
            const expected =
              table in deleted ? deleted[table as keyof PurgeCounts] : 0;

            if (before[table] - after[table] !== expected) {
              throw new ConflictException(
                `Purge changed ${table} by ${before[table] - after[table]} rows, expected ${expected}; rolling back`,
              );
            }
          }

          const residue = await this.countRemaining(
            tx,
            source.id,
            runIds,
            attributed,
          );

          if (residue > 0) {
            throw new ConflictException(
              `Purge left ${residue} rows belonging to ${source.slug}; rolling back`,
            );
          }
        } else {
          const counts = await this.countPlan(
            tx,
            source.id,
            runIds,
            attributed,
          );

          Object.assign(deleted, counts);
        }

        const publishedRunAfter = input.confirm
          ? await this.publishedRun(tx)
          : publishedRunBefore;

        const manifest = {
          sourceSlug: source.slug,
          sourceId: source.id,
          reason: input.reason,
          purgedAt: input.now.toISOString(),
          committed: input.confirm,
          alreadyPurged: Object.values(deleted).every((count) => count === 0),
          deleted,
          retained: {
            marketSource: 1,
            marketRole: before.marketRole,
            marketSkill: before.marketSkill,
            marketRoleAlias: before.marketRoleAlias,
            marketSkillAlias: before.marketSkillAlias,
          },
          attributedSignalRunIds: attributed,
          publishedRunBefore,
          publishedRunAfter,
        };

        return { ...manifest, manifestHash: canonicalHash(manifest) };
      },
      {
        timeout: PURGE_TIMEOUT_MS,
        maxWait: PURGE_MAX_WAIT_MS,
        /*
         * So a concurrent write that this transaction never saw produces a
         * serialization failure and a rollback, rather than a purge that
         * commits around it.
         */
        isolationLevel: 'Serializable',
      },
    );
  }

  /** What a purge WOULD delete. Used by the dry run, which is the default. */
  private async countPlan(
    tx: Tx,
    sourceId: string,
    runIds: string[],
    attributed: string[],
  ): Promise<PurgeCounts> {
    const byPosting = { posting: { sourceId } };

    return {
      marketSignal: await tx.marketSignal.count({
        where: { runId: { in: attributed } },
      }),
      marketSignalRun: await tx.marketSignalRun.count({
        where: { id: { in: attributed } },
      }),
      marketPostingSkillMention: await tx.marketPostingSkillMention.count({
        where: { normalization: { version: byPosting } },
      }),
      marketPostingNormalization: await tx.marketPostingNormalization.count({
        where: { version: byPosting },
      }),
      marketPostingSighting: await tx.marketPostingSighting.count({
        where: { OR: [byPosting, { runId: { in: runIds } }] },
      }),
      marketPostingVersion: await tx.marketPostingVersion.count({
        where: { OR: [byPosting, { firstSeenRunId: { in: runIds } }] },
      }),
      marketPosting: await tx.marketPosting.count({ where: { sourceId } }),
      marketRunScopeCoverage: await tx.marketRunScopeCoverage.count({
        where: { OR: [{ sourceId }, { runId: { in: runIds } }] },
      }),
      marketIngestionRun: await tx.marketIngestionRun.count({
        where: { sourceId },
      }),
    };
  }

  /**
   * Rows still reachable from the purged source after the deletes.
   *
   * Re-runs every predicate the plan used. A non-zero answer means a
   * predicate did not cover what it claimed, which is a bug in this file
   * rather than a condition to report - so it rolls back.
   */
  private async countRemaining(
    tx: Tx,
    sourceId: string,
    runIds: string[],
    attributed: string[],
  ): Promise<number> {
    const counts = await this.countPlan(tx, sourceId, runIds, attributed);

    return Object.values(counts).reduce((total, count) => total + count, 0);
  }
}
