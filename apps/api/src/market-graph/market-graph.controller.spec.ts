import {
  type INestApplication,
  UnauthorizedException,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthGuard } from '../auth/auth.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { MarketGraphController } from './market-graph.controller.js';
import { MarketGraphService } from './market-graph.service.js';

/*
 * A real Nest application, with the real AuthGuard, the real URI
 * versioning and the real global ValidationPipe from main.ts.
 *
 * Building it without those would test routes that do not exist in
 * production - the versioning is what puts /v1 in front of everything, and
 * the pipe runs with forbidNonWhitelisted.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';

const WINDOW = {
  start: '2026-08-09T00:00:00.000Z',
  end: '2026-09-08T00:00:00.000Z',
  scopes: ['acme', 'globex'],
  coverageComplete: true,
  computedAt: '2026-09-08T00:00:00.000Z',
  signalRunId: 'run-1',
};

function stubService(): MarketGraphService {
  return {
    listSources: vi.fn(async () => ({ data: [] })),
    listRoles: vi.fn(async () => ({ data: [] })),
    listSkills: vi.fn(async () => ({ data: [] })),
    latestSnapshot: vi.fn(async () => ({ data: null })),
    roleSkills: vi.fn(async () => ({
      data: { role: { slug: 'backend-engineer' }, window: WINDOW, signals: [] },
    })),
    roleVolumes: vi.fn(async () => ({ data: { window: WINDOW, signals: [] } })),
    explainSignal: vi.fn(async () => ({ data: {} })),
    unresolvedTitles: vi.fn(async () => ({ data: [] })),
  } as unknown as MarketGraphService;
}

async function createApp(
  service: MarketGraphService = stubService(),
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [MarketGraphController],
    providers: [
      AuthGuard,
      { provide: MarketGraphService, useValue: service },
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

const ROUTES: Array<[string, string]> = [
  ['get', '/v1/market/sources'],
  ['get', '/v1/market/roles'],
  ['get', '/v1/market/skills'],
  ['get', '/v1/market/snapshot'],
  ['get', '/v1/market/signals'],
  ['get', '/v1/market/roles/backend-engineer/skills'],
  /*
   * Present in the pinned route table but missing from this list, so the
   * three authentication tests below never covered it - on the one route
   * that walks provenance and now carries a freshness verdict.
   */
  ['get', '/v1/market/signals/00000000-0000-4000-8000-000000000000'],
  ['get', '/v1/market/unresolved-titles'],
];

describe('authentication', () => {
  it.each(ROUTES)('rejects an unauthenticated %s %s', async (_method, path) => {
    app = await createApp();

    await request(app.getHttpServer()).get(path).expect(401);
  });

  it.each(ROUTES)(
    'rejects an invalid token on %s %s',
    async (_method, path) => {
      app = await createApp();

      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', 'Bearer nope')
        .expect(401);
    },
  );

  it.each(ROUTES)('serves %s %s to a valid token', async (_method, path) => {
    app = await createApp();

    await request(app.getHttpServer())
      .get(path)
      .set('Authorization', 'Bearer valid-token')
      .expect(200);
  });
});

describe('the route table', () => {
  /*
   * The scope guard, and the most valuable test in this file.
   *
   * Phase 8 must contain no opportunity, recommendation or matching
   * surface. Listing forbidden paths alone would not catch a
   * differently-named one, so the whole route table is pinned: adding any
   * route at all is a deliberate act that has to change this list.
   */
  it('registers exactly the routes Phase 8 declares, and no others', async () => {
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
      'GET /v1/market/roles',
      'GET /v1/market/roles/:slug/skills',
      'GET /v1/market/signals',
      'GET /v1/market/signals/:id',
      'GET /v1/market/skills',
      'GET /v1/market/snapshot',
      'GET /v1/market/sources',
      'GET /v1/market/unresolved-titles',
    ]);
  });

  it.each([
    '/v1/market/opportunities',
    '/v1/market/recommendations',
    '/v1/market/matches',
    '/v1/market/fit',
    '/v1/market/next-best-action',
    '/v1/market/jobs',
  ])('exposes no route at %s', async (path) => {
    app = await createApp();

    await request(app.getHttpServer())
      .get(path)
      .set('Authorization', 'Bearer valid-token')
      .expect(404);
  });

  it('exposes no write route at all', async () => {
    app = await createApp();

    for (const path of ['/v1/market/signals', '/v1/market/sources']) {
      await request(app.getHttpServer())
        .post(path)
        .set('Authorization', 'Bearer valid-token')
        .expect(404);
    }
  });
});

describe('the controller stays thin', () => {
  it('delegates once and returns what the service gave it', async () => {
    const service = stubService();
    app = await createApp(service);

    const response = await request(app.getHttpServer())
      .get('/v1/market/signals')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    expect(service.roleVolumes).toHaveBeenCalledTimes(1);
    expect(response.body).toEqual({ data: { window: WINDOW, signals: [] } });
  });

  it('passes a validated limit through, and nothing else', async () => {
    const service = stubService();
    app = await createApp(service);

    await request(app.getHttpServer())
      .get('/v1/market/signals?limit=5')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    expect(service.roleVolumes).toHaveBeenCalledWith(5);
  });

  it.each(['abc', '0', '-1', '2.5', ''])(
    'refuses a limit of %j rather than guessing one',
    async (limit) => {
      app = await createApp();

      await request(app.getHttpServer())
        .get(`/v1/market/signals?limit=${limit}`)
        .set('Authorization', 'Bearer valid-token')
        .expect(400);
    },
  );
});

describe('what a market response may contain', () => {
  /*
   * The market is the same for everybody; that is what makes it the
   * market. A user id in a response would mean it had quietly become
   * personalised, which is the Phase 9 boundary crossed in the one place
   * nobody would think to look.
   */
  it('returns no user identity anywhere in the body', async () => {
    app = await createApp();

    const response = await request(app.getHttpServer())
      .get('/v1/market/signals')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    const body = JSON.stringify(response.body);

    expect(body).not.toContain(USER_A);
    expect(body).not.toContain('userId');
    expect(body).not.toContain('someone@example.invalid');
  });

  it('detects a planted user id, so the check above is not vacuous', async () => {
    const service = stubService();
    (service.roleVolumes as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      async () => ({ data: { window: WINDOW, signals: [], userId: USER_A } }),
    );

    app = await createApp(service);

    const response = await request(app.getHttpServer())
      .get('/v1/market/signals')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    expect(JSON.stringify(response.body)).toContain(USER_A);
  });
});
