import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';

import { MarketGraphCoreModule } from '../../src/market-graph/market-graph-core.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

/*
 * The database tier's harness.
 *
 * It refuses to run rather than skipping. A skipped database test is "we
 * did not look" reported as "there is nothing there" - which is the exact
 * confusion deriveRunStatus and classifyFreshness's UNAVAILABLE branch
 * exist to forbid, reappearing in the tests that check them.
 */

export function marketTestDatabaseUrl(): string {
  const url = process.env.MARKET_TEST_DATABASE_URL;

  if (url === undefined || url.trim() === '') {
    throw new Error(
      'MARKET_TEST_DATABASE_URL must be set for the database tier. It must NOT point at a database holding real observations: these tests truncate every Market table.',
    );
  }

  return url;
}

export async function createMarketTestContext(): Promise<INestApplicationContext> {
  /*
   * Set before the module boots: PrismaService reads DATABASE_URL in its
   * constructor, so pointing the tier at its own database has to happen
   * before Nest constructs anything.
   */
  process.env.DATABASE_URL = marketTestDatabaseUrl();

  return NestFactory.createApplicationContext(MarketGraphCoreModule, {
    logger: false,
  });
}

/** Deleted children-first, in the order the RESTRICT graph permits. */
export async function truncateMarket(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "MarketPostingSearchDocument",
      "MarketSignal", "MarketSignalRun",
      "MarketPostingSkillMention", "MarketPostingNormalization",
      "MarketPostingSighting", "MarketPostingVersion", "MarketPosting",
      "MarketRunScopeCoverage", "MarketIngestionRun",
      "MarketRoleAlias", "MarketSkillAlias", "MarketRole", "MarketSkill",
      "MarketSource"
    RESTART IDENTITY CASCADE
  `);
}

export type PostingSpec = {
  key: string;
  sourceSlug: string;
  scope: string;
  company: string;
  /* Search needs control over the text it searches. All optional, so every
   * fixture written before Market Graph search still means what it meant. */
  titleRaw?: string;
  titleNormalized?: string;
  locationRaw?: string;
  applyUrl?: string;
  /** The source's own grouping assertion, for dedup tests. */
  externalGroupKey?: string;
  sourcePublishedAt?: Date;
  /** One entry per version, in the order they were first seen. */
  versions: Array<{
    observedAt: Date;
    roleSlug: string | null;
    skillSlugs: string[];
    /** A second locus for the same skill, to fan a posting out to 2 rows. */
    alsoInTitle?: string;
    extractionStatus?: 'EXTRACTED' | 'NO_TEXT' | 'FAILED';
    completeness?: 'FULL' | 'TRUNCATED' | 'ABSENT';
    rulesetVersion?: number;
  }>;
};

export class MarketFixture {
  readonly postingIds = new Map<string, string>();

  private readonly runIds = new Map<string, string>();

  private readonly roleIds = new Map<string, string>();

  private readonly skillIds = new Map<string, string>();

  private seq = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rulesetVersion: number,
  ) {}

  async source(
    slug: string,
    over: Partial<{
      pollIntervalHours: number;
      expectedPostingLifetimeDays: number;
    }> = {},
  ) {
    const source = await this.prisma.marketSource.create({
      data: {
        slug,
        displayName: slug,
        licenceBasis: 'EXPLICIT_GRANT',
        /*
         * Phase 11 columns. A fixture source stands in for a cleared
         * open-data publisher, which is what every existing test means by
         * "a source" - and the CHECK constraint would refuse the row
         * anyway if it were enabled from any other access state.
         */
        category: 'PUBLIC_OPEN_DATA',
        accessState: 'ENABLED',
        isEnabled: true,
        mayRedistributeDerived: true,
        pollIntervalHours: over.pollIntervalHours ?? 24,
        expectedPostingLifetimeDays: over.expectedPostingLifetimeDays ?? 30,
      },
    });

    const run = await this.prisma.marketIngestionRun.create({
      data: {
        sourceId: source.id,
        status: 'SUCCEEDED',
        adapterVersion: 1,
        rulesetVersion: this.rulesetVersion,
        queryParams: {},
        queryFingerprint: `fp-${slug}`,
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
        finishedAt: new Date('2026-01-01T00:10:00.000Z'),
      },
    });

    this.runIds.set(slug, run.id);

    return source;
  }

  /**
   * One coverage row.
   *
   * `run` names which ingestion run it belongs to, because the table is
   * keyed (runId, sourceScope): a scope read twice - once completely, once
   * not - is two rows on two runs, which is exactly how it happens in
   * production and is the shape the freshness derivation has to get right.
   */
  async coverage(
    sourceSlug: string,
    scope: string,
    over: {
      read?: boolean;
      completeForScope?: boolean;
      finishedAt?: Date;
      run?: string;
    } = {},
  ) {
    const source = await this.prisma.marketSource.findUniqueOrThrow({
      where: { slug: sourceSlug },
      select: { id: true },
    });

    const runKey = `${sourceSlug}#${over.run ?? 'default'}`;

    if (!this.runIds.has(runKey)) {
      const extra = await this.prisma.marketIngestionRun.create({
        data: {
          sourceId: source.id,
          status: 'SUCCEEDED',
          adapterVersion: 1,
          rulesetVersion: this.rulesetVersion,
          queryParams: {},
          queryFingerprint: `fp-${runKey}`,
          startedAt: new Date('2026-01-01T00:00:00.000Z'),
          finishedAt: over.finishedAt ?? new Date('2026-01-01T00:10:00.000Z'),
        },
      });

      this.runIds.set(runKey, extra.id);
    }

    await this.prisma.marketRunScopeCoverage.create({
      data: {
        runId: this.runIds.get(runKey)!,
        sourceId: source.id,
        sourceScope: scope,
        read: over.read ?? true,
        completeForScope: over.completeForScope ?? true,
        finishedAt: over.finishedAt ?? new Date('2026-01-01T00:10:00.000Z'),
      },
    });
  }

  async role(slug: string): Promise<string> {
    const existing = this.roleIds.get(slug);

    if (existing !== undefined) {
      return existing;
    }

    const row = await this.prisma.marketRole.create({
      data: { slug, label: slug, introducedInRulesetVersion: 1 },
    });

    this.roleIds.set(slug, row.id);

    return row.id;
  }

  async skill(slug: string): Promise<string> {
    const existing = this.skillIds.get(slug);

    if (existing !== undefined) {
      return existing;
    }

    const row = await this.prisma.marketSkill.create({
      data: { slug, label: slug, introducedInRulesetVersion: 1 },
    });

    this.skillIds.set(slug, row.id);

    return row.id;
  }

  async posting(spec: PostingSpec): Promise<string> {
    const source = await this.prisma.marketSource.findUniqueOrThrow({
      where: { slug: spec.sourceSlug },
      select: { id: true },
    });

    const runId = this.runIds.get(spec.sourceSlug)!;
    const first = spec.versions[0]!;
    const last = spec.versions[spec.versions.length - 1]!;

    const posting = await this.prisma.marketPosting.create({
      data: {
        sourceId: source.id,
        /* Deterministic and ordered, so the sample's order is checkable. */
        externalId: `${spec.sourceSlug}:${spec.key}`,
        identityBasis: 'SOURCE_ID',
        identityVersion: 1,
        externalKey: spec.key,
        sourceScope: spec.scope,
        companyRaw: spec.company,
        companyNormalized: spec.company,
        externalGroupKey: spec.externalGroupKey ?? null,
        applyUrlCanonical: spec.applyUrl ?? null,
        firstSeenAt: first.observedAt,
        lastSeenAt: last.observedAt,
      },
    });

    this.postingIds.set(spec.key, posting.id);

    for (const [index, version] of spec.versions.entries()) {
      this.seq += 1;

      const row = await this.prisma.marketPostingVersion.create({
        data: {
          postingId: posting.id,
          contentHashVersion: 1,
          contentHash: `${spec.key}-v${index}`,
          firstSeenRunId: runId,
          firstSeenAt: version.observedAt,
          titleRaw: spec.titleRaw ?? `${spec.key} title v${index}`,
          /* The AUTHORITATIVE employer name. MarketPosting.companyRaw is
           * explicitly a lookup accelerator, so anything reading a
           * company for display must read it from the version. */
          companyRaw: spec.company,
          locationRaw: spec.locationRaw ?? null,
          sourcePublishedAt: spec.sourcePublishedAt ?? null,
          descriptionCompleteness: version.completeness ?? 'FULL',
          rawPayload: {},
          rawPayloadHash: `${spec.key}-raw-v${index}`,
        },
      });

      await this.prisma.marketPostingSighting.create({
        data: {
          runId,
          postingId: posting.id,
          versionId: row.id,
          observedAt: version.observedAt,
          capturedAt: version.observedAt,
          runSeq: this.seq,
          pageIndex: 0,
          indexInPage: index,
        },
      });

      const normalization = await this.prisma.marketPostingNormalization.create(
        {
          data: {
            versionId: row.id,
            rulesetVersion: version.rulesetVersion ?? this.rulesetVersion,
            titleNormalized:
              spec.titleNormalized ??
              spec.titleRaw?.toLowerCase() ??
              `${spec.key} title`,
            roleId:
              version.roleSlug === null
                ? null
                : await this.role(version.roleSlug),
            roleMatchMethod:
              version.roleSlug === null ? 'UNMAPPED' : 'EXACT_CANONICAL',
            companyNormalized: spec.company,
            skillExtractionStatus: version.extractionStatus ?? 'EXTRACTED',
            outputHash: `${spec.key}-out-v${index}`,
            normalizedAt: version.observedAt,
          },
        },
      );

      for (const skillSlug of version.skillSlugs) {
        await this.prisma.marketPostingSkillMention.create({
          data: {
            normalizationId: normalization.id,
            rulesetVersion: version.rulesetVersion ?? this.rulesetVersion,
            rawTerm: skillSlug,
            termNormalized: skillSlug,
            skillId: await this.skill(skillSlug),
            matchMethod: 'EXACT_CANONICAL',
            extractedFrom: 'DESCRIPTION',
          },
        });
      }

      if (version.alsoInTitle !== undefined) {
        await this.prisma.marketPostingSkillMention.create({
          data: {
            normalizationId: normalization.id,
            rulesetVersion: version.rulesetVersion ?? this.rulesetVersion,
            rawTerm: version.alsoInTitle.toUpperCase(),
            termNormalized: version.alsoInTitle,
            skillId: await this.skill(version.alsoInTitle),
            matchMethod: 'ALIAS',
            extractedFrom: 'TITLE',
          },
        });
      }
    }

    return posting.id;
  }
}

/**
 * Every Market row, ordered, as one comparable string.
 *
 * Counts are not enough: a purge that nulled a column rather than deleting
 * a row would pass a count comparison, and an atomicity test that only
 * counted rows would pass against a purge that never deleted anything.
 */
export async function snapshotMarket(prisma: PrismaService): Promise<string> {
  const tables = [
    'MarketSource',
    'MarketIngestionRun',
    'MarketRunScopeCoverage',
    'MarketPosting',
    'MarketPostingVersion',
    'MarketPostingSighting',
    'MarketPostingNormalization',
    'MarketPostingSkillMention',
    'MarketRole',
    'MarketSkill',
    'MarketRoleAlias',
    'MarketSkillAlias',
    'MarketSignalRun',
    'MarketSignal',
  ];

  const parts: string[] = [];

  for (const table of tables) {
    const rows = await prisma.$queryRawUnsafe<Array<{ row: string }>>(
      `SELECT t::text AS row FROM "${table}" t ORDER BY t::text`,
    );

    parts.push(`${table}:${rows.length}:${rows.map((r) => r.row).join('|')}`);
  }

  return parts.join('\n');
}

/** Orphans across every single-column Market foreign key. */
export async function countOrphans(prisma: PrismaService): Promise<number> {
  const fks = await prisma.$queryRawUnsafe<
    Array<{ child: string; col: string; parent: string; pcol: string }>
  >(`
    SELECT src.relname AS child, att.attname AS col,
           tgt.relname AS parent, tatt.attname AS pcol
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_class tgt ON tgt.oid = con.confrelid
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
    JOIN pg_attribute tatt ON tatt.attrelid = con.confrelid AND tatt.attnum = con.confkey[1]
    WHERE con.contype = 'f' AND src.relname LIKE 'Market%'
      AND array_length(con.conkey, 1) = 1
  `);

  let total = 0;

  for (const fk of fks) {
    const [row] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "${fk.child}" c
       LEFT JOIN "${fk.parent}" p ON p."${fk.pcol}" = c."${fk.col}"
       WHERE c."${fk.col}" IS NOT NULL AND p."${fk.pcol}" IS NULL`,
    );

    total += Number(row?.n ?? 0);
  }

  return total;
}
