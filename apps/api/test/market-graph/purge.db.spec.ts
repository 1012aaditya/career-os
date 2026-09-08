import type { INestApplicationContext } from '@nestjs/common';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { canonicalHash } from '../../src/common/canonical-hash.js';
import { MarketSignalService } from '../../src/market-graph/signals/market-signal.service.js';
import { MarketSourcePurgeService } from '../../src/market-graph/sources/market-source-purge.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  countOrphans,
  createMarketTestContext,
  MarketFixture,
  snapshotMarket,
  truncateMarket,
} from './market-db.js';

/*
 * The only destructive operation in Phase 8.
 *
 * These tests need a real Postgres and cannot be written against a double.
 * Two of them - "leaves the database untouched when the purge cannot
 * complete" and "the delete order is forced" - ARE the database's
 * semantics: RESTRICT ordering and transactional rollback. The existing
 * in-memory double's $transaction is a passthrough with no rollback, so
 * the atomicity test would pass there against a purge with no transaction
 * at all.
 */

const RULESET = 2;
const T0 = new Date('2026-01-10T00:00:00.000Z');
const T1 = new Date('2026-02-10T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(T1.getTime() + DAY);

let app: INestApplicationContext;
let prisma: PrismaService;
let purge: MarketSourcePurgeService;

async function seed(): Promise<void> {
  await truncateMarket(prisma);

  const fixture = new MarketFixture(prisma, RULESET);

  for (const slug of ['src-a', 'src-b']) {
    await fixture.source(slug);
    await fixture.coverage(slug, 'alpha', { finishedAt: T0 });
    await fixture.coverage(slug, 'beta', { finishedAt: T0 });
  }

  /*
   * Both sources use the SAME canonical role and skill. Without that the
   * "shared vocabulary survives" test would pass trivially - the point is
   * that 17 of 19 roles and 59 of 61 skills are shared in production.
   */
  for (const [index, slug] of ['src-a', 'src-b'].entries()) {
    for (const company of ['acme', 'globex', 'initech', 'umbrella']) {
      await fixture.posting({
        key: `${slug}-${company}`,
        sourceSlug: slug,
        scope: index === 0 ? 'alpha' : 'beta',
        company,
        versions: [
          {
            observedAt: new Date(T0.getTime() + DAY),
            roleSlug: 'backend-engineer',
            skillSlugs: ['typescript'],
          },
        ],
      });
    }
  }

  const signals = app.get(MarketSignalService);

  /*
   * Distinct computedAt per source, deliberately. Computed at the same
   * instant, which run the read side publishes is decided by the uuid
   * tiebreak - so "the published run changed" would be a coin flip, and
   * the test would fail on about half of all runs for a reason that has
   * nothing to do with the purge. src-a is computed last, so it is the
   * published run until it is purged.
   */
  for (const [index, slug] of ['src-b', 'src-a'].entries()) {
    const computedAt = new Date(NOW.getTime() + index * 1000);

    await signals.compute({
      sourceSlug: slug,
      scopes: [slug === 'src-a' ? 'alpha' : 'beta'],
      windowStart: T0,
      windowEnd: T1,
      minDenominator: 3,
      minDistinctCompanies: 2,
      rulesetVersion: RULESET,
      now: computedAt,
      clock: () => computedAt,
    });
  }
}

beforeEach(async () => {
  if (app === undefined) {
    app = await createMarketTestContext();
    prisma = app.get(PrismaService);
    purge = app.get(MarketSourcePurgeService);
  }

  await seed();
});

afterAll(async () => {
  await prisma?.$executeRawUnsafe(
    'DROP TRIGGER IF EXISTS mg_purge_fault ON "MarketIngestionRun"',
  );
  await app?.close();
});

const REASON = { reason: 'licence_takedown', now: NOW };

describe('the fixture', () => {
  it('gives both sources rows, signals and a shared canonical role', async () => {
    for (const slug of ['src-a', 'src-b']) {
      expect(
        await prisma.marketPosting.count({ where: { source: { slug } } }),
      ).toBeGreaterThan(0);
    }

    expect(await prisma.marketSignal.count()).toBeGreaterThan(0);
    expect(await prisma.marketSignalRun.count()).toBe(2);
    expect(await prisma.marketRole.count()).toBe(1);
  });
});

describe('purging one source', () => {
  it('removes every row belonging to it', async () => {
    await purge.purge({ sourceSlug: 'src-a', confirm: true, ...REASON });

    const source = await prisma.marketSource.findUniqueOrThrow({
      where: { slug: 'src-a' },
      select: { id: true, isEnabled: true },
    });

    expect(
      await prisma.marketPosting.count({ where: { sourceId: source.id } }),
    ).toBe(0);
    expect(
      await prisma.marketIngestionRun.count({ where: { sourceId: source.id } }),
    ).toBe(0);
    expect(
      await prisma.marketRunScopeCoverage.count({
        where: { sourceId: source.id },
      }),
    ).toBe(0);
    /* Disabled, so a later sync cannot quietly refill it. */
    expect(source.isEnabled).toBe(false);
  });

  it('leaves every row belonging to another source exactly as it was', async () => {
    const before = await snapshotMarket(prisma);
    const otherOnly = before
      .split('\n')
      .map((line) => line.split(':')[0])
      .join(',');

    expect(otherOnly).toContain('MarketPosting');

    await purge.purge({ sourceSlug: 'src-a', confirm: true, ...REASON });

    const survivors = await prisma.marketPosting.findMany({
      where: { source: { slug: 'src-b' } },
      orderBy: { externalId: 'asc' },
      select: { externalId: true, companyNormalized: true, lastSeenAt: true },
    });

    expect(survivors).toHaveLength(4);
    expect(await prisma.marketPostingSkillMention.count()).toBeGreaterThan(0);
    expect(
      await prisma.marketSignal.count({
        where: { run: { scopes: { has: 'beta' } } },
      }),
    ).toBeGreaterThan(0);
  });

  it('keeps a canonical role and skill that the other source still references', async () => {
    /* Non-degeneracy: both sources must reference them before we start. */
    for (const slug of ['src-a', 'src-b']) {
      expect(
        await prisma.marketPostingNormalization.count({
          where: {
            version: { posting: { source: { slug } } },
            role: { slug: 'backend-engineer' },
          },
        }),
      ).toBeGreaterThan(0);
    }

    await purge.purge({ sourceSlug: 'src-a', confirm: true, ...REASON });

    expect(await prisma.marketRole.count()).toBe(1);
    expect(await prisma.marketSkill.count()).toBe(1);
  });

  it('keeps the vocabulary even where only the purged source used it', async () => {
    await prisma.marketRole.create({
      data: {
        slug: 'used-by-nobody',
        label: 'x',
        introducedInRulesetVersion: 1,
      },
    });

    await purge.purge({ sourceSlug: 'src-a', confirm: true, ...REASON });

    expect(
      await prisma.marketRole.findUnique({ where: { slug: 'used-by-nobody' } }),
    ).not.toBeNull();
  });

  it('leaves no orphaned row anywhere in the Market Graph', async () => {
    await purge.purge({ sourceSlug: 'src-a', confirm: true, ...REASON });

    expect(await countOrphans(prisma)).toBe(0);
  });

  it('detects a planted orphan, so the sweep above is not vacuous', async () => {
    await purge.purge({ sourceSlug: 'src-a', confirm: true, ...REASON });

    await prisma.$executeRawUnsafe('SET session_replication_role = replica');
    await prisma.$executeRawUnsafe(`
      INSERT INTO "MarketPostingSighting"
        ("runId","postingId","versionId","observedAt","capturedAt","runSeq","pageIndex","indexInPage")
      SELECT gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), now(), now(), 999, 0, 0
    `);

    const planted = await countOrphans(prisma);

    await prisma.$executeRawUnsafe('SET session_replication_role = DEFAULT');

    expect(planted).toBeGreaterThan(0);
  });

  it('is a no-op when it is run a second time', async () => {
    const first = await purge.purge({
      sourceSlug: 'src-a',
      confirm: true,
      ...REASON,
    });
    const afterFirst = await snapshotMarket(prisma);

    const second = await purge.purge({
      sourceSlug: 'src-a',
      confirm: true,
      ...REASON,
    });

    expect(first.alreadyPurged).toBe(false);
    expect(Object.values(first.deleted).some((count) => count > 0)).toBe(true);
    expect(second.alreadyPurged).toBe(true);
    expect(Object.values(second.deleted)).toEqual(
      Object.values(second.deleted).map(() => 0),
    );
    expect(await snapshotMarket(prisma)).toBe(afterFirst);
  });

  it('refuses an unknown source rather than reporting a purge of nothing', async () => {
    const before = await snapshotMarket(prisma);

    await expect(
      purge.purge({ sourceSlug: 'no-such-source', confirm: true, ...REASON }),
    ).rejects.toThrow(/Unknown market source/);

    expect(await snapshotMarket(prisma)).toBe(before);
  });

  it('writes nothing without confirmation, and counts what it would delete', async () => {
    const before = await snapshotMarket(prisma);

    const manifest = await purge.purge({
      sourceSlug: 'src-a',
      confirm: false,
      ...REASON,
    });

    expect(manifest.committed).toBe(false);
    expect(manifest.deleted.marketPosting).toBe(4);
    expect(await snapshotMarket(prisma)).toBe(before);
  });

  it('produces the same manifest hash for the same purge of the same data', async () => {
    const dryA = await purge.purge({
      sourceSlug: 'src-a',
      confirm: false,
      ...REASON,
    });
    const dryB = await purge.purge({
      sourceSlug: 'src-a',
      confirm: false,
      ...REASON,
    });

    expect(dryA.manifestHash).toBe(dryB.manifestHash);
  });
});

describe('attributing signal runs to a source', () => {
  it('takes the purged source runs and leaves the other source signals servable', async () => {
    const manifest = await purge.purge({
      sourceSlug: 'src-a',
      confirm: true,
      ...REASON,
    });

    expect(manifest.attributedSignalRunIds).toHaveLength(1);
    expect(await prisma.marketSignalRun.count()).toBe(1);

    const remaining = await prisma.marketSignalRun.findFirstOrThrow({
      select: { sourceScopeKey: true },
    });

    expect(remaining.sourceScopeKey).toBe(
      canonicalHash({ source: 'src-b', scopes: ['beta'] }),
    );
  });

  /*
   * The two malformed-scope runs in the production database carry a single
   * space-separated scope string that matches no posting scope on any
   * source. Attribution by scope NAME would orphan them; the scope key
   * still identifies them exactly.
   */
  it('attributes a run whose scopes match no posting scope at all', async () => {
    const scopes = ['alpha beta gamma'];

    await prisma.marketSignalRun.create({
      data: {
        status: 'SUCCEEDED',
        rulesetVersion: RULESET,
        computationVersion: 1,
        windowStart: T0,
        windowEnd: T1,
        sourceScopeKey: canonicalHash({ source: 'src-a', scopes }),
        scopes,
        minDenominator: 3,
        minDistinctCompanies: 2,
        computedAt: NOW,
      },
    });

    const manifest = await purge.purge({
      sourceSlug: 'src-a',
      confirm: true,
      ...REASON,
    });

    expect(manifest.attributedSignalRunIds).toHaveLength(2);
    expect(await prisma.marketSignalRun.count()).toBe(1);
  });

  it('refuses the whole purge when a run attributes to no known source', async () => {
    await prisma.marketSignalRun.create({
      data: {
        status: 'SUCCEEDED',
        rulesetVersion: RULESET,
        computationVersion: 1,
        windowStart: T0,
        windowEnd: T1,
        sourceScopeKey: 'not-a-key-any-source-produces',
        scopes: ['alpha'],
        minDenominator: 3,
        minDistinctCompanies: 2,
        computedAt: NOW,
      },
    });

    const before = await snapshotMarket(prisma);

    await expect(
      purge.purge({ sourceSlug: 'src-a', confirm: true, ...REASON }),
    ).rejects.toThrow(/attributes to 0 sources/);

    expect(await snapshotMarket(prisma)).toBe(before);
  });

  it('reports which run the read side publishes, before and after', async () => {
    const manifest = await purge.purge({
      sourceSlug: 'src-a',
      confirm: true,
      ...REASON,
    });

    expect(manifest.publishedRunBefore).not.toBeNull();
    expect(manifest.publishedRunAfter).not.toBe(manifest.publishedRunBefore);
  });
});

describe('a purge that cannot complete', () => {
  async function installFault(): Promise<void> {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION mg_purge_fault() RETURNS trigger AS $fn$
        BEGIN RAISE EXCEPTION 'induced purge fault'; END $fn$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER mg_purge_fault BEFORE DELETE ON "MarketIngestionRun"
      FOR EACH ROW EXECUTE FUNCTION mg_purge_fault()
    `);
  }

  async function removeFault(): Promise<void> {
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS mg_purge_fault ON "MarketIngestionRun"',
    );
  }

  /*
   * The fault lands on the LAST table in the order, so the postings,
   * versions, sightings, normalizations, mentions and signals have all
   * already been deleted inside the open transaction when it fires. If any
   * of that survived the rollback, the snapshot would differ.
   */
  it('leaves the database exactly as it was', async () => {
    const before = await snapshotMarket(prisma);

    await installFault();

    await expect(
      purge.purge({ sourceSlug: 'src-a', confirm: true, ...REASON }),
    ).rejects.toThrow();

    const after = await snapshotMarket(prisma);

    await removeFault();

    expect(after).toBe(before);
  });

  it('deletes normally once the fault is removed, so the test above is not vacuous', async () => {
    const before = await snapshotMarket(prisma);

    await removeFault();

    const manifest = await purge.purge({
      sourceSlug: 'src-a',
      confirm: true,
      ...REASON,
    });

    expect(manifest.deleted.marketIngestionRun).toBeGreaterThan(0);
    expect(await snapshotMarket(prisma)).not.toBe(before);
  });
});
