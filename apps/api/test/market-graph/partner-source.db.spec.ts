import type { INestApplicationContext } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MarketIngestionService } from '../../src/market-graph/ingestion/market-ingestion.service.js';
import { MarketVocabularyService } from '../../src/market-graph/ingestion/market-vocabulary.service.js';
import { MarketNormalizationService } from '../../src/market-graph/normalization/market-normalization.service.js';
import { MarketSearchProjectionService } from '../../src/market-graph/search/market-search-projection.service.js';
import { MarketSearchService } from '../../src/market-graph/search/market-search.service.js';
import { MarketSourceHealthService } from '../../src/market-graph/sources/market-source-health.service.js';
import { MarketSourceRegistry } from '../../src/market-graph/sources/source-registry.js';
import { AshbyAdapter } from '../../src/market-graph/sources/ashby/ashby.adapter.js';
import type {
  SourceClient,
  SourceDescriptor,
  SourcePage,
} from '../../src/market-graph/sources/source-adapter.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { createMarketTestContext, truncateMarket } from './market-db.js';

/*
 * Phase 11, end to end, against a real Postgres.
 *
 * The claim this file exists to prove is the one Part O makes and Part T
 * depends on: a posting arriving through a PARTNER-shaped source becomes
 * searchable through the Phase 10 search with no source-specific code
 * anywhere in between. Not asserted by reading the search module and
 * observing that it has no `if (source === ...)` - that is already checked
 * by a lint-style test - but by pushing a real Ashby-shaped payload
 * through ingestion, normalization and projection and then asking search
 * for it by role.
 *
 * WHY THE CLIENT IS A STUB AND THE ADAPTER IS NOT. The adapter is the real
 * one, parsing the shape the live API really returns. The client is a
 * stub, because reaching the live endpoint is the one thing this phase has
 * decided not to do: the Ashby source is BLOCKED_EXTERNAL_ACCESS and a
 * test that walked it anyway would be the fake integration Part M forbids,
 * dressed as evidence.
 *
 * The descriptor below is therefore NOT the registry's Ashby entry. It is
 * a hypothetical CLEARED partner source using the same adapter - which is
 * exactly the thing that would exist the day partner access is granted,
 * and the only honest way to test the path that grant would open. The
 * first test in this file asserts that the registry's real entry is
 * refused, so the two cannot be confused.
 */

const T0 = new Date('2026-02-01T09:00:00.000Z');
const RETRIEVED_AT = new Date('2026-02-10T12:00:00.000Z');
const AS_OF = new Date('2026-02-10T13:00:00.000Z');

/*
 * Two postings in the shape the live API returns, in the order the API
 * returned them. The determinism test below re-ingests them reversed.
 */
const BOARD = {
  apiVersion: 1,
  jobs: [
    {
      id: '11111111-2222-3333-4444-555555555555',
      title: 'Senior Backend Engineer',
      department: 'Engineering',
      team: 'Platform',
      employmentType: 'FullTime',
      location: 'Bengaluru, India',
      isListed: true,
      isRemote: false,
      workplaceType: 'Onsite',
      publishedAt: '2026-02-01T09:00:00.000+00:00',
      jobUrl: 'https://example.invalid/partnerco/11111111',
      applyUrl:
        'https://example.invalid/partnerco/11111111/application?ref=board&api_key=live-secret-value',
      descriptionHtml:
        '<p>Contact ada.lovelace@example.invalid. You will work with Python, Postgres and Kubernetes.</p>',
      descriptionPlain:
        'Contact ada.lovelace@example.invalid. You will work with Python, Postgres and Kubernetes.',
    },
    {
      id: '99999999-8888-7777-6666-555555555555',
      title: 'Frontend Engineer',
      department: 'Engineering',
      location: 'Bengaluru, India',
      isListed: true,
      publishedAt: '2026-02-01T09:00:00.000+00:00',
      jobUrl: 'https://example.invalid/partnerco/99999999',
      applyUrl: 'https://example.invalid/partnerco/99999999/application',
      descriptionHtml: '<p>We use React and TypeScript.</p>',
    },
  ],
};

/** Serves one canned board. Never touches a network. */
class StubBoardClient implements SourceClient {
  constructor(private body: unknown) {}

  readonly interScopeDelayMs = 0;

  readonly maxPagesPerScope = 1;

  serve(body: unknown): void {
    this.body = body;
  }

  async fetchScope(): Promise<SourcePage> {
    return { body: this.body, nextCursor: null };
  }

  classifyFailure(): string {
    return 'unexpected_response';
  }
}

const client = new StubBoardClient(BOARD);

/*
 * A partner source as it would be the day consent existed: same adapter,
 * same contract, an access state that has actually been cleared, and a
 * licence that permits publication. Everything else in this file follows
 * from the pipeline treating it like any other source.
 */
const CLEARED_PARTNER: SourceDescriptor = {
  slug: 'partner-feed-test',
  displayName: 'Consent-gated partner feed (test)',
  adapter: new AshbyAdapter(),
  client,
  queryParams: { boardPerScope: true },
  category: 'PARTNER_FEED',
  access: {
    state: 'ENABLED',
    note: 'A hypothetical cleared partner source, existing only in this test, so the path a real grant would open is exercised without pretending a grant exists.',
    reviewedAt: T0,
  },
  credentials: null,
  attribution: 'Job listings provided by PartnerCo.',
  rateLimit: { requestsPerMinute: 60, note: 'Stubbed; no network is used.' },
  licenceBasis: 'CONTRACTED',
  licenceNote:
    'A hypothetical syndication agreement, existing only in this test file.',
  licenceReviewedAt: T0,
  isEnabled: true,
  mayRedistributeDerived: true,
};

let app: INestApplicationContext;
let prisma: PrismaService;
let ingestion: MarketIngestionService;
let search: MarketSearchService;

async function normalizeAll(): Promise<void> {
  const normalizer = app.get(MarketNormalizationService);

  for (;;) {
    const batch = await normalizer.normalizePending({ now: RETRIEVED_AT });

    if (batch.normalized === 0) {
      break;
    }
  }
}

beforeAll(async () => {
  app = await createMarketTestContext();
  prisma = app.get(PrismaService);
  ingestion = app.get(MarketIngestionService);
  search = app.get(MarketSearchService);

  await truncateMarket(prisma);
  await app.get(MarketVocabularyService).syncVocabulary();
});

afterAll(async () => {
  await app?.close();
});

describe('a source that has not been cleared', () => {
  /*
   * The whole phase in one assertion. The Ashby adapter is finished, its
   * client handles every documented failure, and the source ingests
   * nothing - because the right to ingest it has not been established.
   */
  it('refuses to ingest, even though its adapter is complete', async () => {
    const ashby = app.get(MarketSourceRegistry).get('ashby');

    await expect(
      ingestion.ingest({ source: ashby, scopes: ['acme'], now: RETRIEVED_AT }),
    ).rejects.toThrow('access_not_enabled');
  });

  /*
   * Refused BEFORE the network. The registry's Ashby client would have
   * made a real request; the gate runs first, so nothing was fetched -
   * which is the difference between a source that is switched off and a
   * source that is politely ignored after the fact.
   */
  it('writes no source row that any read path could then serve', async () => {
    const row = await prisma.marketSource.findUnique({
      where: { slug: 'ashby' },
      select: { isEnabled: true, accessState: true, attribution: true },
    });

    expect(row).toEqual({
      isEnabled: false,
      accessState: 'BLOCKED_EXTERNAL_ACCESS',
      attribution: null,
    });

    expect(await prisma.marketPosting.count()).toBe(0);
  });
});

describe('a cleared partner source', () => {
  it('ingests through the same contract as every open-data source', async () => {
    const result = await ingestion.ingest({
      source: CLEARED_PARTNER,
      scopes: ['partnerco'],
      now: RETRIEVED_AT,
      /*
       * A fixed clock. `observedAt` is read per scope from the clock
       * rather than from `now`, because a walk over many scopes spans
       * minutes - so a test that wants to assert what was observed when
       * has to supply one instead of racing the wall clock.
       */
      clock: () => RETRIEVED_AT,
    });

    expect(result.status).toBe('SUCCEEDED');
    expect(result.stats.postingsAccepted).toBe(2);
    expect(result.stats.postingsCreated).toBe(2);
    expect(result.stats.versionsCreated).toBe(2);
    expect(result.stats.sightingsCreated).toBe(2);
  });

  /*
   * Provenance, in full, on a partner posting. Every guarantee Phase 8
   * makes about an open-data posting has to be true of this one, and the
   * point of listing them together is that none of them is optional
   * because the source is new.
   */
  it('preserves the whole provenance chain', async () => {
    const posting = await prisma.marketPosting.findFirstOrThrow({
      where: { externalId: { contains: '11111111' } },
      select: {
        externalId: true,
        sourceScope: true,
        externalKey: true,
        identityBasis: true,
        firstSeenAt: true,
        lastSeenAt: true,
        applyUrlCanonical: true,
        source: { select: { slug: true, category: true, attribution: true } },
        versions: {
          select: {
            contentHashVersion: true,
            sourcePublishedAt: true,
            sourceUpdatedAt: true,
            applyUrlRaw: true,
            sightings: { select: { capturedAt: true, observedAt: true } },
          },
        },
      },
    });

    expect(posting.source.slug).toBe('partner-feed-test');
    expect(posting.source.category).toBe('PARTNER_FEED');
    expect(posting.source.attribution).toBe(
      'Job listings provided by PartnerCo.',
    );
    expect(posting.sourceScope).toBe('partnerco');
    expect(posting.externalKey).toBe('11111111-2222-3333-4444-555555555555');
    expect(posting.identityBasis).toBe('SOURCE_ID');
    expect(posting.externalId).toContain('market:partner-feed-test:sid:');

    const version = posting.versions[0]!;

    /*
     * The publisher's own instant, kept as the publisher's. NOT the
     * retrieval time - an imported posting that looks newly published is
     * the failure mode Part H names, and it is one date assignment away at
     * all times.
     */
    expect(version.sourcePublishedAt?.toISOString()).toBe(T0.toISOString());
    expect(version.sourceUpdatedAt).toBeNull();
    expect(version.sightings[0]?.capturedAt.toISOString()).toBe(
      RETRIEVED_AT.toISOString(),
    );
  });

  /*
   * The shared sanitizer, applied to a partner source because it is a
   * property of the PIPELINE rather than something an adapter opts into.
   */
  it('persists no contact detail and no credential-shaped parameter', async () => {
    const versions = await prisma.marketPostingVersion.findMany({
      select: { descriptionRaw: true, applyUrlRaw: true, rawPayload: true },
    });

    const stored = JSON.stringify(versions);

    expect(stored).not.toContain('ada.lovelace@example.invalid');
    expect(stored).toContain('[redacted:email]');

    /*
     * The apply URL had its exemption from redaction removed in this
     * phase, and this is why: a partner feed hands out per-employer apply
     * links, and a signed one would otherwise land in a version row, a
     * search document and an API response.
     */
    expect(stored).not.toContain('live-secret-value');
    expect(stored).toContain('api_key=redacted');
    /* The link still works. */
    expect(stored).toContain('ref=board');
  });

  it('resolves to canonical roles and skills with no source-specific rule', async () => {
    await normalizeAll();

    const normalization =
      await prisma.marketPostingNormalization.findFirstOrThrow({
        where: {
          version: { posting: { externalKey: { contains: '11111111' } } },
        },
        select: {
          companyNormalized: true,
          role: { select: { slug: true } },
          mentions: { select: { skill: { select: { slug: true } } } },
        },
      });

    expect(normalization.role?.slug).toBe('backend-engineer');
    /* The board token, which is the only employer statement the API makes. */
    expect(normalization.companyNormalized).toBe('partnerco');
    expect(
      normalization.mentions
        .map((mention) => mention.skill?.slug)
        .filter((slug): slug is string => slug !== undefined && slug !== null)
        .sort(),
    ).toContain('postgresql');
  });

  /*
   * Part O, and the reason none of the above would be worth much on its
   * own. The projection and the search were written in Phase 10 against
   * five open-data sources and have not been touched; a partner posting
   * has to fall out of them by construction.
   */
  it('becomes searchable through the Phase 10 search, unchanged', async () => {
    const projected = await app
      .get(MarketSearchProjectionService)
      .project(RETRIEVED_AT);

    expect(projected.documentsWritten).toBe(2);

    const results = await search.search(
      {
        q: 'backend engineer',
        location: 'bengaluru',
        sort: 'relevance',
        limit: 20,
      } as Parameters<MarketSearchService['search']>[0],
      AS_OF,
    );

    expect(results.data.results).toHaveLength(1);
    expect(results.data.results[0]?.title).toBe('Senior Backend Engineer');
    /*
     * The source appears as a source, exactly as JobTech does. A reader
     * cannot tell from the result shape that this posting arrived through
     * a partner feed rather than a national job bank, which is the product
     * requirement stated at the end of the phase brief.
     */
    expect(results.data.results[0]?.source.slug).toBe('partner-feed-test');
  });

  it('carries its attribution to the detail the mobile app reads', async () => {
    const results = await search.search(
      {
        q: 'backend engineer',
        sort: 'relevance',
        limit: 20,
      } as Parameters<MarketSearchService['search']>[0],
      AS_OF,
    );

    const detail = await search.posting(results.data.results[0]!.id, AS_OF);

    expect(detail.data.provenance.source?.attribution).toBe(
      'Job listings provided by PartnerCo.',
    );
    /*
     * And nothing else about the licence. licenceNote is our own working
     * reasoning - what was verified, what the residual risks are, which of
     * a publisher's APIs must never be called - and it used to be served
     * on every job detail.
     */
    expect(JSON.stringify(detail)).not.toContain('licenceNote');
    expect(JSON.stringify(detail)).not.toContain('accessNote');
    expect(JSON.stringify(detail)).not.toContain('hypothetical syndication');
  });

  /*
   * Freshness is derived, and it is derived the same way for a partner
   * posting as for any other. The retrieval time is nine days after
   * publication, and the verdict has to reflect the publisher's date
   * rather than ours.
   */
  it('is aged from the publisher\'s dates, not from ours', async () => {
    const results = await search.search(
      {
        q: 'backend engineer',
        sort: 'relevance',
        limit: 20,
      } as Parameters<MarketSearchService['search']>[0],
      AS_OF,
    );

    const detail = await search.posting(results.data.results[0]!.id, AS_OF);

    expect(detail.data.sourcePublishedAt).toBe(T0.toISOString());
    expect(detail.data.freshness.asOf).toBe(AS_OF.toISOString());
    expect(detail.data.freshness.lastObservedAt).toBe(
      RETRIEVED_AT.toISOString(),
    );
  });
});

describe('importing the same data again', () => {
  /*
   * Part I. Idempotency is not "the second run is fast" - it is that the
   * second run creates no posting and no version, and records one more
   * observation of what it saw. A sighting per run is the CORRECT
   * duplicate: it is the record that we looked again and it was still
   * there, which is what freshness is computed from.
   */
  it('creates no duplicate posting and no duplicate version', async () => {
    const before = {
      postings: await prisma.marketPosting.count(),
      versions: await prisma.marketPostingVersion.count(),
      sightings: await prisma.marketPostingSighting.count(),
    };

    const result = await ingestion.ingest({
      source: CLEARED_PARTNER,
      scopes: ['partnerco'],
      now: new Date(RETRIEVED_AT.getTime() + 60_000),
      clock: () => new Date(RETRIEVED_AT.getTime() + 60_000),
    });

    expect(result.stats.postingsCreated).toBe(0);
    expect(result.stats.versionsCreated).toBe(0);
    expect(result.stats.sightingsCreated).toBe(2);

    expect(await prisma.marketPosting.count()).toBe(before.postings);
    expect(await prisma.marketPostingVersion.count()).toBe(before.versions);
    expect(await prisma.marketPostingSighting.count()).toBe(
      before.sightings + 2,
    );
  });

  /*
   * Part J. A provider is free to return its own pages in whatever order
   * it likes, and this pipeline is not - so the same postings arriving
   * reversed must produce the same content hashes and therefore no new
   * versions at all.
   */
  it('is unmoved by the provider reordering its own response', async () => {
    const hashesBefore = await prisma.marketPostingVersion.findMany({
      orderBy: { contentHash: 'asc' },
      select: { contentHash: true },
    });

    client.serve({ ...BOARD, jobs: [...BOARD.jobs].reverse() });

    const result = await ingestion.ingest({
      source: CLEARED_PARTNER,
      scopes: ['partnerco'],
      now: new Date(RETRIEVED_AT.getTime() + 120_000),
      clock: () => new Date(RETRIEVED_AT.getTime() + 120_000),
    });

    expect(result.stats.versionsCreated).toBe(0);

    expect(
      await prisma.marketPostingVersion.findMany({
        orderBy: { contentHash: 'asc' },
        select: { contentHash: true },
      }),
    ).toEqual(hashesBefore);

    client.serve(BOARD);
  });

  /*
   * The other half of idempotency, and the one that is easy to get
   * backwards: a posting that really did change must mint a version. A
   * pipeline that never creates a second version is idempotent and useless.
   */
  it('mints a version when the publisher actually changes the text', async () => {
    const edited = {
      ...BOARD,
      jobs: [
        {
          ...BOARD.jobs[0],
          title: 'Staff Backend Engineer',
        },
        BOARD.jobs[1],
      ],
    };

    client.serve(edited);

    const result = await ingestion.ingest({
      source: CLEARED_PARTNER,
      scopes: ['partnerco'],
      now: new Date(RETRIEVED_AT.getTime() + 180_000),
      clock: () => new Date(RETRIEVED_AT.getTime() + 180_000),
    });

    expect(result.stats.postingsCreated).toBe(0);
    expect(result.stats.versionsCreated).toBe(1);

    client.serve(BOARD);
  });
});

describe('a provider that fails', () => {
  /*
   * Part Q's central requirement, and the one with real consequences: a
   * provider outage must not delete anything. The corpus after a failed
   * walk is the corpus before it.
   */
  it('loses no existing posting when a walk fails outright', async () => {
    const before = await prisma.marketPosting.count();

    const failing = new StubBoardClient(null);

    failing.fetchScope = async () => {
      throw new Error('provider exploded');
    };

    const result = await ingestion.ingest({
      source: { ...CLEARED_PARTNER, client: failing },
      scopes: ['partnerco'],
      now: new Date(RETRIEVED_AT.getTime() + 240_000),
      clock: () => new Date(RETRIEVED_AT.getTime() + 240_000),
    });

    /*
     * FAILED, and honest about it: the scope was not read, so it is not
     * recorded as read-and-empty. "We could not look" and "there is
     * nothing there" are the two facts this pipeline refuses to merge.
     */
    expect(result.status).toBe('FAILED');
    expect(result.stats.scopesRead).toBe(0);
    expect(await prisma.marketPosting.count()).toBe(before);
  });

  /*
   * A malformed body is a broken response, not an empty board. The scope
   * is READ and the records are REJECTED - counted, so the difference
   * between "the provider sent rubbish" and "this employer has no
   * vacancies" survives into the ledger.
   */
  it('counts a malformed body as rejected rather than as an empty board', async () => {
    const before = await prisma.marketPosting.count();

    client.serve({ notJobs: 'at all' });

    const result = await ingestion.ingest({
      source: CLEARED_PARTNER,
      scopes: ['partnerco'],
      now: new Date(RETRIEVED_AT.getTime() + 300_000),
      clock: () => new Date(RETRIEVED_AT.getTime() + 300_000),
    });

    expect(result.stats.postingsAccepted).toBe(0);
    expect(result.stats.postingsRejected).toBe(1);
    expect(await prisma.marketPosting.count()).toBe(before);

    client.serve(BOARD);
  });
});

describe('source health', () => {
  it('tells apart a blocked source, a cleared one and one never walked', async () => {
    const health = await app.get(MarketSourceHealthService).report();
    const bySlug = new Map(health.map((entry) => [entry.slug, entry]));

    const ashby = bySlug.get('ashby')!;

    expect(ashby.declaredAccessState).toBe('BLOCKED_EXTERNAL_ACCESS');
    expect(ashby.ingestible).toBe(false);
    expect(ashby.refusal?.reason).toBe('access_not_enabled');
    /*
     * The adapter needs no key on the public endpoint, so an unset
     * ASHBY_API_KEY is the normal state rather than a fault - and the
     * report has to say that rather than reporting a missing credential
     * for a source nobody is trying to reach.
     */
    expect(ashby.credentials.kind).toBe('MISSING');
    expect(ashby.corpus.postings).toBe(0);
    expect(ashby.lastAttemptedImportAt).toBeNull();

    const jobtech = bySlug.get('jobtech')!;

    /*
     * Declared ENABLED and never synced in this test database, so it has
     * no row - and the report says so with nulls rather than by omitting
     * the source, which would read as "we have no such source".
     */
    expect(jobtech.declaredAccessState).toBe('ENABLED');
    expect(jobtech.storedAccessState).toBeNull();
    expect(jobtech.lastSuccessfulImportAt).toBeNull();
  });

  it('reports the runs and the corpus of a source that was walked', async () => {
    /*
     * The partner source is not in the registry, so it does not appear in
     * the report - which is correct and is worth stating: health is driven
     * by what this build DECLARES, so a row left behind by a source that
     * no longer exists in code cannot masquerade as a live one.
     */
    const health = await app.get(MarketSourceHealthService).report();

    expect(health.map((entry) => entry.slug)).not.toContain(
      'partner-feed-test',
    );

    /* And the ledger it wrote is still there to be read directly. */
    const runs = await prisma.marketIngestionRun.count({
      where: { source: { slug: 'partner-feed-test' } },
    });

    expect(runs).toBeGreaterThan(1);
  });

  /*
   * Part R. The report names credential VARIABLES and quotes access notes,
   * which is why it is a CLI command and not a route - but the cheapest
   * insurance is that it never carries a value in the first place.
   */
  it('names credential variables and carries no credential values', async () => {
    process.env.ASHBY_API_KEY = 'live-secret-from-health-test';

    try {
      const health = await app.get(MarketSourceHealthService).report();

      expect(JSON.stringify(health)).not.toContain(
        'live-secret-from-health-test',
      );

      const ashby = health.find((entry) => entry.slug === 'ashby')!;

      expect(ashby.credentials.kind).toBe('CONFIGURED');
      /* Still refused: a configured key is not an access grant. */
      expect(ashby.ingestible).toBe(false);
    } finally {
      delete process.env.ASHBY_API_KEY;
    }
  });
});
