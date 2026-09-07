import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AuthGuard } from '../../auth/auth.guard.js';
import { AuthService } from '../../auth/auth.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EncryptionService } from '../crypto/encryption.service.js';
import { OAuthStateService } from '../oauth/oauth-state.service.js';
import {
  createInMemoryPrisma,
  stubConfig,
  TEST_ENCRYPTION_CONFIG,
  TEST_GITHUB_CONFIG,
} from '../test-doubles.js';

import { GithubApiClient } from './github-api.client.js';
import { GithubConnectionService } from './github-connection.service.js';
import { GithubController } from './github.controller.js';
import { GithubOAuthConfig } from './github-oauth.config.js';
import { GithubOAuthService } from './github-oauth.service.js';
import { GithubSyncService } from './github-sync.service.js';

const USER_A = '11111111-1111-4111-8111-111111111111';

const TOKEN_PREFIX = 'gho';

const TOKEN = `${TOKEN_PREFIX}_16C7e42F292c6912E7710c838347Ae178B4a`;

/*
 * A real Nest application, with the real AuthGuard, the real URI
 * versioning and the real global ValidationPipe from main.ts.
 *
 * The pipe matters: it runs with forbidNonWhitelisted, and the callback
 * has to tolerate whatever query parameters GitHub sends. Building the app
 * without it would test a route that does not exist in production.
 */
async function createApp() {
  const store = createInMemoryPrisma();

  const encryption = new EncryptionService(
    stubConfig(TEST_ENCRYPTION_CONFIG),
  );

  const config = new GithubOAuthConfig(
    stubConfig(TEST_GITHUB_CONFIG),
  );

  const api = new GithubApiClient(config);

  const prisma =
    store.prisma as unknown as PrismaService;

  const connections =
    new GithubConnectionService(
      prisma,
      encryption,
      api,
    );

  const moduleRef = await Test.createTestingModule(
    {
      controllers: [GithubController],
      providers: [
        AuthGuard,
        {
          provide: AuthService,
          useValue: {
            /*
             * Stands in for Supabase. Only "valid-token" authenticates,
             * so an unauthenticated request is genuinely rejected by the
             * real guard rather than waved through.
             */
            verifyAccessToken: async (
              token: string,
            ) => {
              if (token !== 'valid-token') {
                throw new UnauthorizedException(
                  'Invalid access token',
                );
              }

              return { id: USER_A };
            },
          },
        },
        { provide: PrismaService, useValue: prisma },
        {
          provide: GithubConnectionService,
          useValue: connections,
        },
        /*
         * A stub, because no test in this file exercises /sync - it
         * predates that route and covers the connection lifecycle.
         *
         * Nest resolves controller dependencies eagerly, so adding the
         * route to the controller makes this hand-built module fail to
         * compile without a provider here. The alternative considered and
         * rejected was marking the dependency @Optional() in production
         * code: that would weaken the real wiring to accommodate a test,
         * and a controller whose collaborator may silently be undefined is
         * a worse thing to own than an explicit stub.
         *
         * It throws rather than returning a value, so a future test that
         * reaches /sync through this module fails loudly instead of
         * silently asserting against a fake success.
         */
        {
          provide: GithubSyncService,
          useValue: {
            sync: async () => {
              throw new Error(
                'GithubSyncService is not wired in this test module',
              );
            },
          } as unknown as GithubSyncService,
        },
        {
          provide: GithubOAuthService,
          useValue: new GithubOAuthService(
            config,
            new OAuthStateService(
              prisma,
              encryption,
            ),
            api,
            connections,
          ),
        },
      ],
    },
  ).compile();

  const app = moduleRef.createNestApplication();

  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  await app.init();

  return { app, store, connections };
}

describe('GithubController', () => {
  let app: INestApplication;
  let store: ReturnType<typeof createInMemoryPrisma>;
  let connections: GithubConnectionService;

  beforeEach(async () => {
    const created = await createApp();
    app = created.app;
    store = created.store;
    connections = created.connections;
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  /* Security test 1. */
  describe('authentication', () => {
    const protectedRoutes: Array<
      ['post' | 'get' | 'delete', string]
    > = [
      ['post', '/v1/github/connect'],
      ['get', '/v1/github/status'],
      ['delete', '/v1/github/disconnect'],
    ];

    it.each(protectedRoutes)(
      'rejects unauthenticated %s %s',
      async (method, path) => {
        await request(app.getHttpServer())
          [method](path)
          .expect(401);
      },
    );

    it.each(protectedRoutes)(
      'rejects an invalid bearer token on %s %s',
      async (method, path) => {
        await request(app.getHttpServer())
          [method](path)
          .set(
            'Authorization',
            'Bearer wrong-token',
          )
          .expect(401);
      },
    );

    it('does not create an authorization request for an unauthenticated caller', async () => {
      await request(app.getHttpServer())
        .post('/v1/github/connect')
        .expect(401);

      expect(
        store.rows.authRequests,
      ).toHaveLength(0);
    });
  });

  describe('POST /v1/github/connect', () => {
    it('returns an authorization URL for an authenticated user', async () => {
      const response = await request(
        app.getHttpServer(),
      )
        .post('/v1/github/connect')
        .set(
          'Authorization',
          'Bearer valid-token',
        )
        .expect(201);

      const url = new URL(
        response.body.authorizationUrl,
      );

      expect(url.origin).toBe(
        'https://github.com',
      );
      expect(
        url.searchParams.get('scope'),
      ).toBe('user:email');

      /* Bound to the authenticated caller. */
      expect(
        store.rows.authRequests[0]!.userId,
      ).toBe(USER_A);
    });

    it('never returns the client secret', async () => {
      const response = await request(
        app.getHttpServer(),
      )
        .post('/v1/github/connect')
        .set(
          'Authorization',
          'Bearer valid-token',
        )
        .expect(201);

      expect(
        JSON.stringify(response.body),
      ).not.toContain(
        TEST_GITHUB_CONFIG.GITHUB_CLIENT_SECRET,
      );
    });
  });

  /* Security test 11, at the transport. */
  describe('GET /v1/github/callback', () => {
    it('is reachable without authentication', async () => {
      const response = await request(
        app.getHttpServer(),
      )
        .get('/v1/github/callback')
        .query({ state: 'nope', code: 'nope' });

      /* Not 401: GitHub's browser carries no credential of ours. */
      expect(response.status).toBe(302);
    });

    it('redirects with a status only, and renders no body', async () => {
      const response = await request(
        app.getHttpServer(),
      )
        .get('/v1/github/callback')
        .query({ state: 'forged', code: 'x' })
        .expect(302);

      const location = new URL(
        response.headers['location']!,
      );

      expect(location.protocol).toBe(
        'careeros:',
      );
      expect(
        location.searchParams.get('status'),
      ).toBe('error');
      expect(
        location.searchParams.get('reason'),
      ).toBe('invalid_state');

      /*
       * No body at all. Any rendered content - an image, a font, an
       * analytics tag - would send this URL, with its code and state, to
       * a third party in the Referer header.
       */
      expect(response.text).toBe('');
    });

    it('sets the headers that stop the URL leaking', async () => {
      const response = await request(
        app.getHttpServer(),
      )
        .get('/v1/github/callback')
        .query({ state: 'forged', code: 'x' })
        .expect(302);

      expect(
        response.headers['referrer-policy'],
      ).toBe('no-referrer');
      expect(
        response.headers['cache-control'],
      ).toBe('no-store');
    });

    it('tolerates unexpected query parameters instead of returning JSON', async () => {
      /*
       * The global pipe runs with forbidNonWhitelisted. A validated DTO
       * here would answer an unknown parameter with a JSON 400 rendered
       * in the user's browser rather than returning them to the app.
       */
      const response = await request(
        app.getHttpServer(),
      )
        .get('/v1/github/callback')
        .query({
          state: 'forged',
          code: 'x',
          unexpected: 'value',
        });

      expect(response.status).toBe(302);
    });

    it('does not put a token in the redirect after a real connection', async () => {
      vi.spyOn(
        globalThis,
        'fetch',
      ).mockImplementation(
        async (input) =>
          new Response(
            JSON.stringify(
              String(input).endsWith('/user')
                ? { id: 583231, login: 'octocat' }
                : {
                    access_token: TOKEN,
                    scope: 'user:email',
                    token_type: 'bearer',
                  },
            ),
            {
              status: 200,
              headers: {
                'Content-Type':
                  'application/json',
              },
            },
          ),
      );

      const started = await request(
        app.getHttpServer(),
      )
        .post('/v1/github/connect')
        .set(
          'Authorization',
          'Bearer valid-token',
        );

      const state = new URL(
        started.body.authorizationUrl,
      ).searchParams.get('state')!;

      const response = await request(
        app.getHttpServer(),
      )
        .get('/v1/github/callback')
        .query({ state, code: 'valid-code' })
        .expect(302);

      const location =
        response.headers['location']!;

      expect(location).not.toContain(TOKEN);
      expect(location).not.toContain(
        TOKEN_PREFIX,
      );
      expect(location).not.toContain(state);
      expect(location).not.toContain(
        'valid-code',
      );
      expect(location).toContain(
        'status=success',
      );
    });
  });

  /* Security test 10, at the transport. */
  describe('GET /v1/github/status', () => {
    it('never returns token material over the wire', async () => {
      await connections.upsertConnection({
        userId: USER_A,
        accountId: '583231',
        login: 'octocat',
        accessToken: TOKEN,
        grantedScopes: ['user:email'],
      });

      const response = await request(
        app.getHttpServer(),
      )
        .get('/v1/github/status')
        .set(
          'Authorization',
          'Bearer valid-token',
        )
        .expect(200);

      const raw = response.text;

      expect(raw).not.toContain(TOKEN);
      expect(raw).not.toContain(TOKEN_PREFIX);
      expect(raw).not.toContain(
        'tokenCiphertext',
      );
      expect(raw).not.toContain('tokenIv');
      expect(raw).not.toContain('tokenTag');

      expect(response.body).toMatchObject({
        connected: true,
        login: 'octocat',
        accountId: '583231',
      });
    });

    it('reports a disconnected user', async () => {
      const response = await request(
        app.getHttpServer(),
      )
        .get('/v1/github/status')
        .set(
          'Authorization',
          'Bearer valid-token',
        )
        .expect(200);

      expect(response.body.connected).toBe(
        false,
      );
    });
  });

  describe('DELETE /v1/github/disconnect', () => {
    it('removes the connection for the authenticated caller', async () => {
      vi.spyOn(
        globalThis,
        'fetch',
      ).mockResolvedValue(
        new Response(null, { status: 204 }),
      );

      await connections.upsertConnection({
        userId: USER_A,
        accountId: '583231',
        login: 'octocat',
        accessToken: TOKEN,
        grantedScopes: ['user:email'],
      });

      const response = await request(
        app.getHttpServer(),
      )
        .delete('/v1/github/disconnect')
        .set(
          'Authorization',
          'Bearer valid-token',
        )
        .expect(200);

      expect(response.body).toEqual({
        disconnected: true,
        revokedAtProvider: true,
      });

      expect(
        store.rows.connections,
      ).toHaveLength(0);
    });
  });
});
