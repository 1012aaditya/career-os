import {
  type INestApplication,
  UnauthorizedException,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthGuard } from '../../auth/auth.guard.js';
import { AuthService } from '../../auth/auth.service.js';
import { MarketGraphController } from '../market-graph.controller.js';
import { MarketGraphService } from '../market-graph.service.js';
import { MarketSearchController } from './market-search.controller.js';
import { MarketSearchService } from './market-search.service.js';

/*
 * The search HTTP surface: what it accepts, what it refuses, and what it
 * must never grow.
 *
 * Built with the real AuthGuard, the real URI versioning and the real
 * global ValidationPipe from main.ts, because every one of those decides
 * an answer here - the pipe's forbidNonWhitelisted is the whole of the
 * "no unrecognised parameters" control.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';

const POSTING_ID = '22222222-2222-4222-8222-222222222222';

function stubSearch(): MarketSearchService {
  return {
    search: vi.fn(async () => ({ data: { results: [] } })),
    posting: vi.fn(async () => ({ data: { id: POSTING_ID } })),
  } as unknown as MarketSearchService;
}

function stubGraph(): MarketGraphService {
  return {
    listSources: vi.fn(async () => ({ data: [] })),
    listRoles: vi.fn(async () => ({ data: [] })),
    listSkills: vi.fn(async () => ({ data: [] })),
    latestSnapshot: vi.fn(async () => ({ data: null })),
    roleSkills: vi.fn(async () => ({ data: {} })),
    roleVolumes: vi.fn(async () => ({ data: {} })),
    explainSignal: vi.fn(async () => ({ data: {} })),
    marketStatistics: vi.fn(async () => ({ data: [] })),
    marketOccupations: vi.fn(async () => ({ data: [] })),
    unresolvedTitles: vi.fn(async () => ({ data: [] })),
  } as unknown as MarketGraphService;
}

async function createApp(
  search: MarketSearchService = stubSearch(),
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [MarketSearchController, MarketGraphController],
    providers: [
      AuthGuard,
      { provide: MarketSearchService, useValue: search },
      { provide: MarketGraphService, useValue: stubGraph() },
      {
        provide: AuthService,
        useValue: {
          verifyAccessToken: async (token: string) => {
            if (token !== 'valid-token') {
              throw new UnauthorizedException('Invalid or expired token');
            }

            return { id: USER_A, email: 'someone@example.invalid' };
          },
        },
      },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  await app.init();

  return app;
}

let app: INestApplication | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
  vi.restoreAllMocks();
});

const ROUTES = ['/v1/market/search', `/v1/market/postings/${POSTING_ID}`];

describe('authentication', () => {
  it.each(ROUTES)('rejects an unauthenticated GET %s', async (path) => {
    app = await createApp();

    await request(app.getHttpServer()).get(path).expect(401);
  });

  it.each(ROUTES)('rejects an invalid token on GET %s', async (path) => {
    app = await createApp();

    await request(app.getHttpServer())
      .get(path)
      .set('Authorization', 'Bearer nope')
      .expect(401);
  });

  it.each(ROUTES)('serves GET %s to a valid token', async (path) => {
    app = await createApp();

    await request(app.getHttpServer())
      .get(path)
      .set('Authorization', 'Bearer valid-token')
      .expect(200);
  });
});

describe('the route table, with search added', () => {
  /*
   * The Phase 8 scope guard, extended rather than replaced.
   *
   * Two routes joined the table in Phase 10 and this is where somebody
   * had to say so on purpose. The list is still exhaustive: adding
   * anything at all fails here, which is what keeps an opportunity or
   * matching surface from arriving unannounced.
   */
  it('registers exactly the routes Phase 10 declares, and no others', async () => {
    app = await createApp();

    const router = (
      app.getHttpAdapter().getInstance() as {
        router: { stack: Array<{ route?: { path: string; methods: object } }> };
      }
    ).router;

    const paths = router.stack
      .filter((layer) => layer.route !== undefined)
      .map(
        (layer) =>
          `${Object.keys(layer.route!.methods)[0]?.toUpperCase()} ${layer.route!.path}`,
      )
      .sort();

    expect(paths).toEqual([
      'GET /v1/market/occupations',
      /* Phase 10. One posting, by id. */
      'GET /v1/market/postings/:id',
      'GET /v1/market/roles',
      'GET /v1/market/roles/:slug/skills',
      /* Phase 10. The unified search. */
      'GET /v1/market/search',
      'GET /v1/market/signals',
      'GET /v1/market/signals/:id',
      'GET /v1/market/skills',
      'GET /v1/market/snapshot',
      'GET /v1/market/sources',
      'GET /v1/market/statistics',
      'GET /v1/market/unresolved-titles',
    ]);
  });

  /*
   * The Phase 12 boundary, still held. Search answers "what jobs exist
   * that match this search"; none of these asks that question.
   */
  it.each([
    '/v1/market/opportunities',
    '/v1/market/recommendations',
    '/v1/market/matches',
    '/v1/market/fit',
    '/v1/market/next-best-action',
    '/v1/market/jobs',
    '/v1/market/search/recommended',
  ])('exposes no route at %s', async (path) => {
    app = await createApp();

    await request(app.getHttpServer())
      .get(path)
      .set('Authorization', 'Bearer valid-token')
      .expect(404);
  });

  /*
   * `/v1/market/postings/recommended` is deliberately NOT in the list
   * above: it matches postings/:id and is refused by the uuid pipe with a
   * 400, not a 404. That is the right answer - it is a malformed id
   * rather than a missing route - and asserting 404 there would have been
   * asserting the wrong thing about the right behaviour.
   */
  it('refuses a recommendation-shaped id as malformed, not as a route', async () => {
    app = await createApp();

    await request(app.getHttpServer())
      .get('/v1/market/postings/recommended')
      .set('Authorization', 'Bearer valid-token')
      .expect(400);
  });

  it('exposes no write route on the search surface', async () => {
    app = await createApp();

    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      await request(app.getHttpServer())
        [method]('/v1/market/search')
        .set('Authorization', 'Bearer valid-token')
        .expect(404);
    }
  });
});

describe('what a caller may send', () => {
  it('passes a validated request through, and defaults the rest', async () => {
    const search = stubSearch();
    app = await createApp(search);

    await request(app.getHttpServer())
      .get('/v1/market/search?q=software%20engineer')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    expect(search.search).toHaveBeenCalledTimes(1);

    const [sent] = (search.search as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [Record<string, unknown>, Date];

    expect(sent.q).toBe('software engineer');
    expect(sent.sort).toBe('relevance');
    expect(sent.limit).toBe(20);
  });

  it('collects a repeated filter into an array', async () => {
    const search = stubSearch();
    app = await createApp(search);

    await request(app.getHttpServer())
      .get('/v1/market/search?skills=python&skills=sql')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    const [sent] = (search.search as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [Record<string, unknown>, Date];

    expect(sent.skills).toEqual(['python', 'sql']);
  });

  it('reads the clock once, at the edge, and threads it down', async () => {
    /*
     * Every freshness verdict on a page must be taken against ONE
     * instant. Read inside the service it would be read per result, and
     * two postings in one body could carry verdicts from different
     * moments.
     */
    const search = stubSearch();
    app = await createApp(search);

    await request(app.getHttpServer())
      .get('/v1/market/search')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    const [, asOf] = (search.search as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [unknown, Date];

    expect(asOf).toBeInstanceOf(Date);
  });
});

describe('what a caller may not send', () => {
  /*
   * Section 24. Every one of these is a value that, unvalidated, becomes
   * an ORDER BY, a LIMIT or a column name somewhere downstream.
   */
  it.each([
    ['an unknown parameter', 'orderBy=title'],
    ['a raw sort expression', 'sort=titleRaw%20DESC'],
    ['a sort that is not on the list', 'sort=random'],
    ['an oversized page', 'limit=5000'],
    ['a page size of zero', 'limit=0'],
    ['a negative page size', 'limit=-1'],
    ['a fractional page size', 'limit=2.5'],
    ['a page size that is not a number', 'limit=all'],
    ['a role that is not slug-shaped', 'role=Software%20Engineer'],
    ['a role with a quote in it', 'role=cook%27%20OR%201%3D1'],
    ['a freshness verdict that does not exist', 'freshness=VERY_FRESH'],
    ['a negative day window', 'publishedWithinDays=-3'],
    ['a day window beyond the corpus', 'publishedWithinDays=99999'],
    ['a cursor that is not base64url', 'cursor=not%20a%20cursor'],
    ['an internal column name', 'select=rawPayload'],
    ['a filter on a column search does not expose', 'descriptionText=secret'],
  ])('refuses %s', async (_label, queryString) => {
    app = await createApp();

    await request(app.getHttpServer())
      .get(`/v1/market/search?${queryString}`)
      .set('Authorization', 'Bearer valid-token')
      .expect(400);
  });

  it('refuses more filter values than the cap allows', async () => {
    app = await createApp();

    const many = Array.from(
      { length: 30 },
      (_, index) => `skills=s${index}`,
    ).join('&');

    await request(app.getHttpServer())
      .get(`/v1/market/search?${many}`)
      .set('Authorization', 'Bearer valid-token')
      .expect(400);
  });

  it('refuses a query longer than the cap', async () => {
    app = await createApp();

    await request(app.getHttpServer())
      .get(`/v1/market/search?q=${'a'.repeat(500)}`)
      .set('Authorization', 'Bearer valid-token')
      .expect(400);
  });

  it('refuses a posting id that is not a uuid, before it reaches a query', async () => {
    const search = stubSearch();
    app = await createApp(search);

    await request(app.getHttpServer())
      .get('/v1/market/postings/1%20OR%201%3D1')
      .set('Authorization', 'Bearer valid-token')
      .expect(400);

    expect(search.posting).not.toHaveBeenCalled();
  });

  /*
   * Injection-shaped free text is DATA and must be accepted as such. The
   * protection is parameterization, not rejection - a search box that
   * 400s on an apostrophe is a search box that cannot find "L'Oreal".
   */
  it.each([
    '\'; DROP TABLE "MarketPosting"; --',
    "engineer' OR '1'='1",
    '100% remote',
    "L'Oreal",
  ])('accepts %j as ordinary text', async (hostile) => {
    const search = stubSearch();
    app = await createApp(search);

    await request(app.getHttpServer())
      .get(`/v1/market/search?q=${encodeURIComponent(hostile)}`)
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    const [sent] = (search.search as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [Record<string, unknown>, Date];

    expect(sent.q).toBe(hostile);
  });
});

describe('what a search response may not contain', () => {
  /*
   * The market is the same for everybody; that is what makes it the
   * market. A user id in a search response would mean it had quietly
   * become personalised - the Phase 12 boundary crossed in the one place
   * nobody would think to look.
   */
  it('takes no user identity as input', async () => {
    const search = stubSearch();
    app = await createApp(search);

    await request(app.getHttpServer())
      .get('/v1/market/search?q=engineer')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    const [sent] = (search.search as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [Record<string, unknown>, Date];

    expect(JSON.stringify(sent)).not.toContain(USER_A);
    expect(JSON.stringify(sent)).not.toContain('someone@example.invalid');
    expect(Object.keys(sent)).not.toContain('userId');
  });

  it('returns no user identity in the body', async () => {
    app = await createApp();

    const response = await request(app.getHttpServer())
      .get('/v1/market/search?q=engineer')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    const body = JSON.stringify(response.body);

    expect(body).not.toContain(USER_A);
    expect(body).not.toContain('userId');
    expect(body).not.toContain('someone@example.invalid');
  });
});
