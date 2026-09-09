import type { INestApplicationContext } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RULESET_VERSION } from '../../src/market-graph/normalization/ruleset.js';
import { classifyFreshness } from '../../src/market-graph/observations/freshness.js';
import { MarketSearchProjectionService } from '../../src/market-graph/search/market-search-projection.service.js';
import { MarketSearchService } from '../../src/market-graph/search/market-search.service.js';
import { relevanceFrom } from '../../src/market-graph/search/search-ranking.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  createMarketTestContext,
  MarketFixture,
  truncateMarket,
} from './market-db.js';

/*
 * Market Search, against a real Postgres.
 *
 * In the database tier rather than the hermetic suite because what is
 * being tested IS the database's behaviour. The ranking is a SQL
 * expression, the pagination is a keyset over a computed ordering, and
 * the grouping is a window function - a double would have to reimplement
 * all three faithfully to prove anything, and would then be proving the
 * double.
 *
 * Two of these tests exist to catch a specific, quiet failure mode: the
 * SQL that ORDERS results and the TypeScript that EXPLAINS them are
 * separate implementations of one idea, and separate implementations
 * drift. If they ever disagree, the explanation shown to a reader becomes
 * fiction while the ordering stays plausible - which is exactly the kind
 * of defect nobody notices. So both are run over the same rows and
 * asserted equal.
 */

const T0 = new Date('2026-01-10T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** After every posting's last sighting, so coverage is satisfied. */
const COMPLETE_AT = new Date(T0.getTime() + 1 * DAY);

/** The instant every verdict in this file is taken against. */
const AS_OF = new Date(T0.getTime() + 1 * DAY + 60 * 60 * 1000);

let app: INestApplicationContext;
let prisma: PrismaService;
let search: MarketSearchService;

function request(over: Record<string, unknown> = {}) {
  return {
    sort: 'relevance' as const,
    limit: 20,
    ...over,
  } as Parameters<MarketSearchService['search']>[0];
}

beforeAll(async () => {
  app = await createMarketTestContext();
  prisma = app.get(PrismaService);
  search = app.get(MarketSearchService);

  await truncateMarket(prisma);

  const fixture = new MarketFixture(prisma, RULESET_VERSION);

  await fixture.source('alpha');
  await fixture.source('beta');

  /*
   * Ingested, but not publishable. Phase 8 keeps `isEnabled` and
   * `mayRedistributeDerived` as separate permissions, and a read endpoint
   * is gated on the second. Everything on this source must be invisible
   * to search.
   */
  await fixture.source('withheld');
  await prisma.marketSource.update({
    where: { slug: 'withheld' },
    data: { mayRedistributeDerived: false },
  });

  await fixture.coverage('alpha', 'main', { finishedAt: COMPLETE_AT });
  await fixture.coverage('beta', 'main', { finishedAt: COMPLETE_AT });
  await fixture.coverage('withheld', 'main', { finishedAt: COMPLETE_AT });
  /*
   * Read, but never COMPLETELY read. Postings in this scope must come
   * back UNAVAILABLE - their absence from a later run would be our
   * failure, not their disappearance.
   */
  await fixture.coverage('alpha', 'uncovered', { completeForScope: false });

  const published = new Date(T0.getTime() - 2 * DAY);

  /* The exact-title match. */
  await fixture.posting({
    key: 'exact',
    sourceSlug: 'alpha',
    scope: 'main',
    company: 'acme',
    titleRaw: 'Backend Engineer',
    titleNormalized: 'backend engineer',
    locationRaw: 'Toronto',
    applyUrl: 'https://example.invalid/exact',
    sourcePublishedAt: published,
    versions: [
      { observedAt: T0, roleSlug: 'backend-engineer', skillSlugs: ['python'] },
    ],
  });

  /* A prefix match: same head, extra words. */
  await fixture.posting({
    key: 'prefix',
    sourceSlug: 'alpha',
    scope: 'main',
    company: 'acme',
    titleRaw: 'Backend Engineer II',
    titleNormalized: 'backend engineer ii',
    locationRaw: 'Toronto',
    sourcePublishedAt: published,
    versions: [
      { observedAt: T0, roleSlug: 'backend-engineer', skillSlugs: ['python'] },
    ],
  });

  /*
   * The Phase 9 payoff: a title in another language that carries none of
   * the query's tokens, reachable ONLY through the canonical role.
   */
  await fixture.posting({
    key: 'role-only',
    sourceSlug: 'beta',
    scope: 'main',
    company: 'globex',
    titleRaw: 'Utvecklare Serversidan',
    titleNormalized: 'utvecklare serversidan',
    locationRaw: 'Stockholm',
    sourcePublishedAt: published,
    versions: [
      { observedAt: T0, roleSlug: 'backend-engineer', skillSlugs: [] },
    ],
  });

  /*
   * A near neighbour that must NEVER be reached by a backend query. It
   * shares a token and resolves to a different canonical role.
   */
  await fixture.posting({
    key: 'manager',
    sourceSlug: 'alpha',
    scope: 'main',
    company: 'acme',
    titleRaw: 'Engineering Manager',
    titleNormalized: 'engineering manager',
    locationRaw: 'Toronto',
    sourcePublishedAt: published,
    versions: [
      { observedAt: T0, roleSlug: 'engineering-manager', skillSlugs: [] },
    ],
  });

  /* Heterogeneous data: no location, no company, no skills, no role. */
  await fixture.posting({
    key: 'sparse',
    sourceSlug: 'beta',
    scope: 'main',
    company: 'globex',
    titleRaw: 'Backend Engineer',
    titleNormalized: 'backend engineer',
    locationRaw: undefined,
    sourcePublishedAt: undefined,
    versions: [
      {
        observedAt: T0,
        roleSlug: null,
        skillSlugs: [],
        extractionStatus: 'NO_TEXT',
      },
    ],
  });

  /* Withheld: an exact title match that must never surface. */
  await fixture.posting({
    key: 'withheld-exact',
    sourceSlug: 'withheld',
    scope: 'main',
    company: 'acme',
    titleRaw: 'Backend Engineer',
    titleNormalized: 'backend engineer',
    locationRaw: 'Toronto',
    sourcePublishedAt: published,
    versions: [
      { observedAt: T0, roleSlug: 'backend-engineer', skillSlugs: ['python'] },
    ],
  });

  /* Never completely covered, so its freshness must be UNAVAILABLE. */
  await fixture.posting({
    key: 'uncovered',
    sourceSlug: 'alpha',
    scope: 'uncovered',
    company: 'acme',
    titleRaw: 'Backend Engineer',
    titleNormalized: 'backend engineer',
    locationRaw: 'Toronto',
    sourcePublishedAt: published,
    versions: [
      { observedAt: T0, roleSlug: 'backend-engineer', skillSlugs: [] },
    ],
  });

  /*
   * Three postings the SOURCE itself says are one requisition, plus one
   * that merely looks similar and carries no grouping key. The first
   * three must collapse; the fourth must not.
   */
  for (const suffix of ['a', 'b', 'c']) {
    await fixture.posting({
      key: `req-${suffix}`,
      sourceSlug: 'beta',
      scope: 'main',
      company: 'initech',
      titleRaw: 'Support Analyst',
      titleNormalized: 'support analyst',
      locationRaw: `City${suffix}`,
      externalGroupKey: 'REQ-1',
      sourcePublishedAt: published,
      versions: [{ observedAt: T0, roleSlug: null, skillSlugs: [] }],
    });
  }

  await fixture.posting({
    key: 'lookalike',
    sourceSlug: 'alpha',
    scope: 'main',
    company: 'initech',
    titleRaw: 'Support Analyst',
    titleNormalized: 'support analyst',
    locationRaw: 'Citya',
    sourcePublishedAt: published,
    versions: [{ observedAt: T0, roleSlug: null, skillSlugs: [] }],
  });

  /* Twenty rows sharing a score and a date, to prove the tie-breaker. */
  for (let index = 0; index < 20; index += 1) {
    await fixture.posting({
      key: `tie-${String(index).padStart(2, '0')}`,
      sourceSlug: 'alpha',
      scope: 'main',
      company: 'tiecorp',
      titleRaw: 'Warehouse Associate',
      titleNormalized: 'warehouse associate',
      locationRaw: 'Toronto',
      sourcePublishedAt: published,
      versions: [{ observedAt: T0, roleSlug: null, skillSlugs: [] }],
    });
  }

  await app.get(MarketSearchProjectionService).project(new Date());
});

afterAll(async () => {
  await app?.close();
});

describe('the projection is built from the evidence, and only from it', () => {
  it('projects every posting exactly once', async () => {
    const postings = await prisma.marketPosting.count();
    const documents = await prisma.marketPostingSearchDocument.count();

    expect(documents).toBe(postings);
  });

  it('writes nothing on a second run, because nothing changed', async () => {
    const again = await app
      .get(MarketSearchProjectionService)
      .project(new Date());

    expect(again.documentsWritten).toBe(0);
    expect(again.documentsUnchanged).toBe(again.postingsScanned);
  });

  it('rebuilds a document whose evidence moved, and only that one', async () => {
    const target = await prisma.marketPostingSearchDocument.findFirstOrThrow({
      where: { titleRaw: 'Engineering Manager' },
      select: { postingId: true, contentHash: true },
    });

    await prisma.marketPostingSearchDocument.update({
      where: { postingId: target.postingId },
      data: { contentHash: 'stale-by-hand' },
    });

    const result = await app
      .get(MarketSearchProjectionService)
      .project(new Date());

    expect(result.documentsWritten).toBe(1);

    const rebuilt = await prisma.marketPostingSearchDocument.findUniqueOrThrow({
      where: { postingId: target.postingId },
      select: { contentHash: true },
    });

    /* Back to the hash the evidence implies, not to some new one. */
    expect(rebuilt.contentHash).toBe(target.contentHash);
  });
});

describe('finding jobs', () => {
  it('finds an exact title match and ranks it first', async () => {
    const page = await search.search(request({ q: 'Backend Engineer' }), AS_OF);

    expect(page.data.results[0]?.title).toBe('Backend Engineer');
    expect(
      page.data.results[0]?.relevance.components.map((c) => c.code),
    ).toContain('TITLE_EXACT');
  });

  it('finds a partial title match below the exact one', async () => {
    const page = await search.search(request({ q: 'Backend Engineer' }), AS_OF);
    const titles = page.data.results.map((result) => result.title);

    expect(titles).toContain('Backend Engineer II');
    expect(titles.indexOf('Backend Engineer')).toBeLessThan(
      titles.indexOf('Backend Engineer II'),
    );
  });

  it('reaches a posting through the canonical role alone', async () => {
    /*
     * "Utvecklare Serversidan" contains neither query token. It is
     * findable only because Phase 9 resolved it to backend-engineer and
     * the query resolves to the same role - which is the entire reason
     * the canonical vocabulary exists.
     */
    const page = await search.search(request({ q: 'Backend Engineer' }), AS_OF);

    expect(page.data.query.resolvedRole).toBe('backend-engineer');
    expect(page.data.results.map((result) => result.title)).toContain(
      'Utvecklare Serversidan',
    );
  });

  it('never reaches a different canonical role through a shared token', async () => {
    /*
     * The false merge section 9 names. "Engineering Manager" shares no
     * token with "backend engineer" except by way of the role expansion,
     * and its role is a different one - so it must be absent entirely.
     */
    const page = await search.search(request({ q: 'Backend Engineer' }), AS_OF);

    expect(page.data.results.map((result) => result.title)).not.toContain(
      'Engineering Manager',
    );
  });

  it('filters by canonical role directly', async () => {
    const page = await search.search(
      request({ role: 'engineering-manager' }),
      AS_OF,
    );

    expect(page.data.results.map((result) => result.title)).toEqual([
      'Engineering Manager',
    ]);
  });

  it('filters by canonical skill', async () => {
    const page = await search.search(request({ skills: ['python'] }), AS_OF);

    expect(page.data.results.length).toBeGreaterThan(0);
    expect(
      page.data.results.every((result) => result.skills.includes('python')),
    ).toBe(true);
  });

  it('filters by company', async () => {
    const page = await search.search(request({ company: 'Initech' }), AS_OF);

    expect(page.data.results.length).toBeGreaterThan(0);
    expect(
      page.data.results.every((result) => result.company === 'initech'),
    ).toBe(true);
  });

  it('filters by location', async () => {
    const page = await search.search(request({ location: 'Stockholm' }), AS_OF);

    expect(page.data.results.map((result) => result.title)).toEqual([
      'Utvecklare Serversidan',
    ]);
  });

  it('filters by source', async () => {
    const page = await search.search(request({ sources: ['beta'] }), AS_OF);

    expect(
      page.data.results.every((result) => result.source.slug === 'beta'),
    ).toBe(true);
    expect(page.data.results.length).toBeGreaterThan(0);
  });

  it('returns an empty page rather than everything when nothing matches', async () => {
    const page = await search.search(
      request({ q: 'submarine cartographer' }),
      AS_OF,
    );

    expect(page.data.results).toEqual([]);
    expect(page.data.page.totalGroups).toBe(0);
  });
});

describe('the licence boundary holds through search', () => {
  /*
   * `withheld` carries an EXACT title match. If the gate were on
   * `isEnabled` instead of `mayRedistributeDerived`, or absent, this
   * posting would rank first on the most common query in the file.
   */
  it('never returns a posting from a source we may not redistribute', async () => {
    for (const req of [
      request({ q: 'Backend Engineer' }),
      request({ role: 'backend-engineer' }),
      request({ company: 'acme' }),
      request({}),
      request({ sources: ['withheld'] }),
    ]) {
      const page = await search.search(req, AS_OF);

      expect(
        page.data.results.some((result) => result.source.slug === 'withheld'),
      ).toBe(false);
    }
  });

  it('answers a withheld posting id with 404, not with 403', async () => {
    /*
     * A 403 would be an oracle: it distinguishes "no such posting" from
     * "a posting you may not see", which is precisely the fact the
     * licence boundary exists to keep.
     */
    const withheld = await prisma.marketPostingSearchDocument.findFirstOrThrow({
      where: { sourceSlug: 'withheld' },
      select: { postingId: true },
    });

    await expect(search.posting(withheld.postingId, AS_OF)).rejects.toThrow(
      /not found/i,
    );
  });
});

describe('the ordering is deterministic', () => {
  it('returns the same order for the same query, every time', async () => {
    const runs = await Promise.all(
      Array.from({ length: 5 }, () =>
        search.search(request({ q: 'Warehouse Associate' }), AS_OF),
      ),
    );

    const orders = runs.map((run) =>
      run.data.results.map((result) => result.id).join(','),
    );

    expect(new Set(orders).size).toBe(1);
  });

  it('breaks a score-and-date tie by a stable, environment-independent key', async () => {
    /*
     * Twenty rows share a title, a score and a publication date. Without
     * an explicit final key the executor is free to return them in any
     * order, and that order can differ between two runs of the same
     * query over the same rows.
     */
    const page = await search.search(
      request({ q: 'Warehouse Associate', limit: 20 }),
      AS_OF,
    );

    const scores = new Set(page.data.results.map((r) => r.relevance.total));

    expect(scores.size).toBe(1);

    const externalIds = await prisma.marketPostingSearchDocument.findMany({
      where: { postingId: { in: page.data.results.map((r) => r.id) } },
      select: { postingId: true, externalId: true },
    });

    const byId = new Map(
      externalIds.map((row) => [row.postingId, row.externalId]),
    );
    const ordered = page.data.results.map(
      (result) => byId.get(result.id) ?? '',
    );

    expect(ordered).toEqual([...ordered].sort());
  });
});

describe('pagination cannot skip and cannot repeat', () => {
  async function walk(pageSize: number): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let guard = 0; guard < 50; guard += 1) {
      const page = await search.search(
        request({ q: 'Warehouse Associate', limit: pageSize, cursor }),
        AS_OF,
      );

      seen.push(...page.data.results.map((result) => result.id));

      if (!page.data.page.hasMore || page.data.page.nextCursor === null) {
        return seen;
      }

      cursor = page.data.page.nextCursor;
    }

    throw new Error('pagination did not terminate');
  }

  it('walks the whole result set with no duplicate and no omission', async () => {
    const paged = await walk(3);
    const whole = await search.search(
      request({ q: 'Warehouse Associate', limit: 50 }),
      AS_OF,
    );

    expect(new Set(paged).size).toBe(paged.length);
    expect(paged).toEqual(whole.data.results.map((result) => result.id));
  });

  it('gives the same walk whatever the page size', async () => {
    expect(await walk(1)).toEqual(await walk(7));
  });

  it('returns a stable page 1 across repeated requests', async () => {
    const first = await search.search(
      request({ q: 'Warehouse Associate', limit: 5 }),
      AS_OF,
    );
    const again = await search.search(
      request({ q: 'Warehouse Associate', limit: 5 }),
      AS_OF,
    );

    expect(first.data.results.map((r) => r.id)).toEqual(
      again.data.results.map((r) => r.id),
    );
    expect(first.data.page.nextCursor).toBe(again.data.page.nextCursor);
  });

  it('returns a stable page 2 across repeated requests', async () => {
    const first = await search.search(
      request({ q: 'Warehouse Associate', limit: 5 }),
      AS_OF,
    );

    const a = await search.search(
      request({
        q: 'Warehouse Associate',
        limit: 5,
        cursor: first.data.page.nextCursor ?? undefined,
      }),
      AS_OF,
    );

    const b = await search.search(
      request({
        q: 'Warehouse Associate',
        limit: 5,
        cursor: first.data.page.nextCursor ?? undefined,
      }),
      AS_OF,
    );

    expect(a.data.results.map((r) => r.id)).toEqual(
      b.data.results.map((r) => r.id),
    );
    expect(a.data.results.map((r) => r.id)).not.toEqual(
      first.data.results.map((r) => r.id),
    );
  });

  it('refuses a cursor issued for a different query', async () => {
    const first = await search.search(
      request({ q: 'Warehouse Associate', limit: 5 }),
      AS_OF,
    );

    await expect(
      search.search(
        request({
          q: 'Backend Engineer',
          limit: 5,
          cursor: first.data.page.nextCursor ?? undefined,
        }),
        AS_OF,
      ),
    ).rejects.toThrow(/different query/i);
  });
});

describe('grouping collapses only what the source itself grouped', () => {
  it('collapses three postings the source calls one requisition', async () => {
    const page = await search.search(request({ q: 'Support Analyst' }), AS_OF);

    const grouped = page.data.results.filter(
      (result) => result.grouping.postings > 1,
    );

    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.grouping.postings).toBe(3);
    expect(grouped[0]?.grouping.basis).toBe('SOURCE_ASSERTED_GROUP');
  });

  it('does not merge two sources that merely look alike', async () => {
    /*
     * The lookalike shares a normalized title, a company and a location
     * with the grouped requisition and is on a different source. Nothing
     * asserts they are the same job, so they stay separate - section 13's
     * rule when identity cannot be established safely.
     */
    const page = await search.search(request({ q: 'Support Analyst' }), AS_OF);

    expect(page.data.results).toHaveLength(2);
    expect(
      page.data.results.map((result) => result.source.slug).sort(),
    ).toEqual(['alpha', 'beta']);
  });

  it('reports groups and the postings behind them as separate numbers', async () => {
    const page = await search.search(request({ q: 'Support Analyst' }), AS_OF);

    expect(page.data.page.totalGroups).toBe(2);
    expect(page.data.page.totalPostings).toBe(4);
  });

  it('keeps every grouped posting individually addressable', async () => {
    /*
     * Grouping is a presentation decision. The evidence underneath is
     * untouched, so each of the three is still a posting with its own
     * detail page - which is what "do not destroy underlying source
     * evidence" means in practice.
     */
    const documents = await prisma.marketPostingSearchDocument.findMany({
      where: { groupKey: 'REQ-1' },
      select: { postingId: true },
    });

    expect(documents).toHaveLength(3);

    for (const document of documents) {
      const detail = await search.posting(document.postingId, AS_OF);

      expect(detail.data.id).toBe(document.postingId);
    }
  });
});

describe('freshness is preserved, not reinvented', () => {
  it('reports UNAVAILABLE where no complete read has finished since we looked', async () => {
    /*
     * Addressed by id rather than found in a page: twenty tie-breaker
     * postings share this location and would push it past any sane page
     * size. Looking for it in a page tested the pagination, not the
     * verdict.
     */
    const document = await prisma.marketPostingSearchDocument.findFirstOrThrow({
      where: { sourceScope: 'uncovered' },
      select: { postingId: true },
    });

    const detail = await search.posting(document.postingId, AS_OF);

    expect(detail.data.freshness.verdict).toBe('UNAVAILABLE');
  });

  it('reports a covered posting as something other than UNAVAILABLE', async () => {
    /* Non-vacuity: if every verdict were UNAVAILABLE the check above
     * would pass over a completely broken coverage gate. */
    const document = await prisma.marketPostingSearchDocument.findFirstOrThrow({
      where: { sourceScope: 'main', sourceSlug: 'alpha' },
      select: { postingId: true },
    });

    const detail = await search.posting(document.postingId, AS_OF);

    expect(detail.data.freshness.verdict).not.toBe('UNAVAILABLE');
  });

  it('filters on a verdict, and returns only that verdict', async () => {
    const page = await search.search(
      request({ freshness: ['UNAVAILABLE'] }),
      AS_OF,
    );

    expect(page.data.results.length).toBeGreaterThan(0);
    expect(
      page.data.results.every(
        (result) => result.freshness.verdict === 'UNAVAILABLE',
      ),
    ).toBe(true);
  });

  it('excludes the same rows when the opposite verdicts are asked for', async () => {
    const page = await search.search(
      request({ freshness: ['FRESH', 'AGING', 'STALE'] }),
      AS_OF,
    );

    expect(
      page.data.results.some(
        (result) => result.freshness.verdict === 'UNAVAILABLE',
      ),
    ).toBe(false);
  });

  /*
   * THE ANTI-DRIFT TEST for freshness. The verdict used to FILTER is a
   * SQL transcription of classifyFreshness; the verdict SHOWN comes from
   * classifyFreshness itself. If the two ever disagree, a caller filtering
   * for FRESH gets rows labelled STALE and nothing in the system notices.
   */
  it('agrees with classifyFreshness on every row, both ways', async () => {
    const page = await search.search(request({ limit: 50 }), AS_OF);

    const documents = await prisma.marketPostingSearchDocument.findMany({
      where: { postingId: { in: page.data.results.map((r) => r.id) } },
      select: {
        postingId: true,
        sourceId: true,
        sourceScope: true,
        lastSeenAt: true,
        sourceValidThrough: true,
      },
    });

    const sources = await prisma.marketSource.findMany({
      select: {
        id: true,
        pollIntervalHours: true,
        expectedPostingLifetimeDays: true,
      },
    });

    const config = new Map(sources.map((source) => [source.id, source]));

    const coverage = await prisma.marketRunScopeCoverage.groupBy({
      by: ['sourceId', 'sourceScope'],
      where: { completeForScope: true, finishedAt: { not: null } },
      _max: { finishedAt: true },
    });

    const covered = new Map(
      coverage.map((row) => [
        `${row.sourceId}:${row.sourceScope}`,
        row._max.finishedAt,
      ]),
    );

    expect(documents.length).toBeGreaterThan(0);

    for (const document of documents) {
      const source = config.get(document.sourceId)!;

      const expected = classifyFreshness({
        asOf: AS_OF,
        lastSeenAt: document.lastSeenAt,
        lastCompleteCoverageAt:
          covered.get(`${document.sourceId}:${document.sourceScope}`) ?? null,
        sourceValidThrough: document.sourceValidThrough,
        pollIntervalHours: source.pollIntervalHours,
        expectedPostingLifetimeDays: source.expectedPostingLifetimeDays,
      });

      const served = page.data.results.find(
        (result) => result.id === document.postingId,
      );

      expect(`${document.postingId}: ${served?.freshness.verdict}`).toBe(
        `${document.postingId}: ${expected.verdict}`,
      );
    }
  });
});

describe('the score in SQL and the explanation in TypeScript are the same number', () => {
  /*
   * THE ANTI-DRIFT TEST for ranking, and the reason this whole file is in
   * the database tier.
   *
   * The ordering comes from a SQL sum. The explanation comes from
   * relevanceFrom() in TypeScript. They are two implementations of one
   * idea and they are built from the same weights - but "built from the
   * same weights" is a claim about the code, not a check on it. This is
   * the check: recompute every returned row's total from its own facts
   * and require it to equal the number that decided its position.
   */
  it.each([
    ['a title query', { q: 'Backend Engineer' }],
    ['a role filter', { role: 'backend-engineer' }],
    ['a location query', { q: 'Backend Engineer', location: 'Toronto' }],
    ['a skill filter', { skills: ['python'] }],
    ['no query at all', {}],
  ])('agrees on every row for %s', async (_label, over) => {
    const page = await search.search(request({ ...over, limit: 50 }), AS_OF);

    expect(page.data.results.length).toBeGreaterThan(0);

    for (const result of page.data.results) {
      const recomputed = result.relevance.components.reduce(
        (sum, component) => sum + component.points,
        0,
      );

      expect(`${result.id}: ${recomputed}`).toBe(
        `${result.id}: ${result.relevance.total}`,
      );
    }
  });

  it('orders the page by exactly the number it reports', async () => {
    const page = await search.search(
      request({ q: 'Backend Engineer', limit: 50 }),
      AS_OF,
    );

    const totals = page.data.results.map((result) => result.relevance.total);

    expect(totals).toEqual([...totals].sort((a, b) => b - a));
  });

  it('detects a planted disagreement, so the checks above are not vacuous', () => {
    /*
     * Non-vacuity for the two tests above: if relevanceFrom ignored its
     * input, every recomputation would agree with every total and both
     * would pass over nothing.
     */
    const a = relevanceFrom({
      titleExact: true,
      titlePrefix: false,
      titleAllTokens: false,
      roleExact: false,
      titleTokenHits: 0,
      searchTokenHits: 0,
      skillHits: 0,
      locationExact: false,
      locationAllTokens: false,
      recencyPoints: 0,
    });

    const b = relevanceFrom({
      titleExact: false,
      titlePrefix: false,
      titleAllTokens: false,
      roleExact: true,
      titleTokenHits: 0,
      searchTokenHits: 0,
      skillHits: 0,
      locationExact: false,
      locationAllTokens: false,
      recencyPoints: 0,
    });

    expect(a.total).not.toBe(b.total);
  });
});

describe('heterogeneous data does not break a result', () => {
  it('returns a posting with no location, no skills and no role', async () => {
    const page = await search.search(request({ sources: ['beta'] }), AS_OF);

    const sparse = page.data.results.find((result) => result.location === null);

    expect(sparse).toBeDefined();
    expect(sparse?.role).toBeNull();
    expect(sparse?.skills).toEqual([]);
    expect(sparse?.sourcePublishedAt).toBeNull();
  });

  it('scores a posting with no publication date at zero recency, not at a guess', async () => {
    const page = await search.search(request({ sources: ['beta'] }), AS_OF);

    const undated = page.data.results.find(
      (result) => result.sourcePublishedAt === null,
    );

    expect(
      undated?.relevance.components.some(
        (component) => component.code === 'RECENCY',
      ),
    ).toBe(false);
  });

  it('serves a detail page for a posting with no description', async () => {
    const sparse = await prisma.marketPostingSearchDocument.findFirstOrThrow({
      where: { locationRaw: null },
      select: { postingId: true },
    });

    const detail = await search.posting(sparse.postingId, AS_OF);

    expect(detail.data.description).toBeNull();
    expect(detail.data.location).toBeNull();
    expect(detail.data.role).toBeNull();
  });
});

describe('the detail page', () => {
  it('carries what a reader needs, and the link to apply', async () => {
    /*
     * Keyed on the posting, not on its title.
     *
     * `titleRaw: 'Backend Engineer', sourceSlug: 'alpha'` matches TWO
     * fixture postings - `exact` and `uncovered` - and findFirst has no
     * ordering, so which one came back was decided by Postgres's physical
     * row order. That is stable for a table filled the same way every
     * time and is not stable at all once the table has been truncated and
     * refilled after different prior activity: adding a fourth file to
     * this tier was enough to flip it, and the test then failed on the
     * skills of a posting that legitimately has none.
     *
     * A latent ambiguity rather than a new bug, but a real one: the test
     * has always been asserting against whichever of two postings the
     * database happened to hand it.
     */
    const document = await prisma.marketPostingSearchDocument.findFirstOrThrow({
      where: { posting: { externalId: 'alpha:exact' } },
      select: { postingId: true },
    });

    const detail = await search.posting(document.postingId, AS_OF);

    expect(detail.data.title).toBe('Backend Engineer');
    expect(detail.data.company).toBe('acme');
    expect(detail.data.location).toBe('Toronto');
    expect(detail.data.role?.slug).toBe('backend-engineer');
    expect(detail.data.skills.map((skill) => skill.slug)).toEqual(['python']);
    expect(detail.data.applyUrl).toBe('https://example.invalid/exact');
    expect(detail.data.freshness.verdict).toBeDefined();
  });

  it('attributes the posting to its publisher, in a reader vocabulary', async () => {
    /*
     * Keyed on the posting, not on its title.
     *
     * `titleRaw: 'Backend Engineer', sourceSlug: 'alpha'` matches TWO
     * fixture postings - `exact` and `uncovered` - and findFirst has no
     * ordering, so which one came back was decided by Postgres's physical
     * row order. That is stable for a table filled the same way every
     * time and is not stable at all once the table has been truncated and
     * refilled after different prior activity: adding a fourth file to
     * this tier was enough to flip it, and the test then failed on the
     * skills of a posting that legitimately has none.
     *
     * A latent ambiguity rather than a new bug, but a real one: the test
     * has always been asserting against whichever of two postings the
     * database happened to hand it.
     */
    const document = await prisma.marketPostingSearchDocument.findFirstOrThrow({
      where: { posting: { externalId: 'alpha:exact' } },
      select: { postingId: true },
    });

    const detail = await search.posting(document.postingId, AS_OF);

    expect(detail.data.provenance.source?.slug).toBe('alpha');
    expect(detail.data.provenance.source?.displayName).toBeDefined();
    expect(detail.data.provenance.lastObservedAt).toBeDefined();

    /*
     * Section 16: provenance, not a data-management screen. None of the
     * internal machinery may appear.
     */
    const body = JSON.stringify(detail.data);

    for (const forbidden of [
      'rawPayload',
      'versionId',
      'contentHash',
      'runId',
      'adapterVersion',
      'normalizationId',
    ]) {
      expect(`${forbidden}: ${body.includes(forbidden)}`).toBe(
        `${forbidden}: false`,
      );
    }
  });

  it('redacts a contact number the stored text still carries', async () => {
    /*
     * The read-side guarantee, exercised rather than assumed. A body is
     * planted with a number in the exact form that survived ingestion in
     * the real corpus, and the served description must not contain it.
     */
    /* The same disambiguation as above: two postings share this title. */
    const document = await prisma.marketPostingSearchDocument.findFirstOrThrow({
      where: { posting: { externalId: 'alpha:exact' } },
      select: { postingId: true, versionId: true },
    });

    await prisma.marketPostingNormalization.update({
      where: {
        versionId_rulesetVersion: {
          versionId: document.versionId,
          rulesetVersion: RULESET_VERSION,
        },
      },
      data: {
        descriptionText:
          'Questions to David Nyren, 070 290 51 16 or +46 730 931 787.',
      },
    });

    const detail = await search.posting(document.postingId, AS_OF);

    expect(detail.data.description).not.toContain('070 290 51 16');
    expect(detail.data.description).not.toContain('+46 730 931 787');
    expect(detail.data.description).toContain('[redacted:phone]');
    /* The job is still readable. Redaction removes a number, not a body. */
    expect(detail.data.description).toContain('Questions to');
  });

  it('answers an unknown id with a not-found, never with an empty shell', async () => {
    await expect(
      search.posting('33333333-3333-4333-8333-333333333333', AS_OF),
    ).rejects.toThrow(/not found/i);
  });
});

describe('search writes nothing', () => {
  it('leaves every table byte-identical after a page of searches', async () => {
    async function fingerprint(): Promise<string> {
      const [postings, versions, sightings, normalizations, documents] =
        await Promise.all([
          prisma.marketPosting.count(),
          prisma.marketPostingVersion.count(),
          prisma.marketPostingSighting.count(),
          prisma.marketPostingNormalization.count(),
          prisma.marketPostingSearchDocument.aggregate({
            _count: true,
            _max: { projectedAt: true },
          }),
        ]);

      return JSON.stringify([
        postings,
        versions,
        sightings,
        normalizations,
        documents._count,
        documents._max.projectedAt?.toISOString() ?? null,
      ]);
    }

    const before = await fingerprint();

    await search.search(request({ q: 'Backend Engineer' }), AS_OF);
    await search.search(request({ role: 'backend-engineer' }), AS_OF);
    await search.search(request({ location: 'Toronto' }), AS_OF);

    expect(await fingerprint()).toBe(before);
  });
});
