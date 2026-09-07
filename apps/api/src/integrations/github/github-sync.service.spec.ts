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

import { ExternalSyncRunService } from './external-sync-run.service.js';
import { GithubApiClient } from './github-api.client.js';
import { GithubConnectionService } from './github-connection.service.js';
import { GithubController } from './github.controller.js';
import { GithubIngestionService } from './github-ingestion.service.js';
import { GithubOAuthConfig } from './github-oauth.config.js';
import { GithubOAuthService } from './github-oauth.service.js';
import { GithubRestClient } from './github-rest.client.js';
import {
  GithubConnectionUnavailableError,
  GithubSyncFailedError,
  GithubSyncService,
} from './github-sync.service.js';
import { GithubEvidenceRepository } from './evidence/github-evidence.repository.js';

/*
 * The security argument these tests defend.
 *
 * Almost everything below runs the REAL objects: the real ingestion
 * service, the real REST client with its real pagination and retry, the
 * real projection, the real persistence with the unique index enforced,
 * the real ledger, and - for the endpoint tests - the real AuthGuard and
 * the real global ValidationPipe. Only two things are substituted: the
 * network (fetch) and the database (an in-memory double that enforces
 * the constraints that carry the guarantees).
 *
 * That matters most for the NOT_SCANNED tests. A stubbed ingestion
 * service handing back a hand-written observation would let those pass
 * against an implementation with no filter and no budget logic at all;
 * driving them through a real budget exhaustion means the repository is
 * unscanned for the same reason it would be in production.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER =
  '22222222-2222-4222-8222-222222222222';

/*
 * Split so the literal token never appears in this file as a contiguous
 * string that a naive scan of the source would flag, and - more
 * usefully - so the leak assertions can look for the PREFIX independently
 * of the full value.
 */
const TOKEN_PREFIX = 'gho';
const TOKEN = `${TOKEN_PREFIX}_16C7e42F292c6912E7710c838347Ae178B4a`;

const ACCOUNT_ID = '583231';
const LOGIN = 'octocat';

const SCANNED_AT = '2026-09-07T12:00:00.000Z';

type Route = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

function repo(
  id: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    node_id: `R_${id}`,
    name: `repo-${id}`,
    full_name: `${LOGIN}/repo-${id}`,
    html_url: `https://github.com/${LOGIN}/repo-${id}`,
    owner: {
      id: Number(ACCOUNT_ID),
      login: LOGIN,
      type: 'User',
    },
    private: false,
    visibility: 'public',
    fork: false,
    archived: false,
    disabled: false,
    default_branch: 'main',
    description: null,
    size: 100,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    pushed_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function commit(date = '2024-06-02T14:31:09Z') {
  return {
    sha: `sha-${date}`,
    commit: {
      author: {
        name: 'Octo Cat',
        email: 'octocat@example.com',
        date,
      },
    },
    author: {
      id: Number(ACCOUNT_ID),
      login: LOGIN,
    },
  };
}

/**
 * Scripts the network. Everything above it is real.
 *
 * Returns the URLs that were requested so a test can assert what was
 * NOT called - which is how "no request is made for an out-of-budget
 * repository" is checked.
 */
function scriptNetwork(routes: {
  repos?: Route;
  issues?: Route;
  languages?: Route;
  commits?: Route;
}) {
  const requested: string[] = [];

  vi.spyOn(
    globalThis,
    'fetch',
  ).mockImplementation(async (input) => {
    const url = String(input);
    requested.push(url);

    let route: Route;

    if (url.includes('/issues?')) {
      route = routes.issues ?? { body: [] };
    } else if (url.includes('/languages')) {
      route = routes.languages ?? {
        body: { TypeScript: 1000 },
      };
    } else if (url.includes('/commits')) {
      route = routes.commits ?? {
        body: [commit()],
      };
    } else {
      route = routes.repos ?? { body: [] };
    }

    return new Response(
      route.body === undefined
        ? null
        : JSON.stringify(route.body),
      {
        status: route.status ?? 200,
        headers: {
          'Content-Type': 'application/json',
          ...route.headers,
        },
      },
    );
  });

  return requested;
}

/**
 * Wires the real object graph over an in-memory database.
 *
 * The connection is written through the REAL GithubConnectionService, so
 * the token in the store went through the real encrypt path with the real
 * AAD. A hand-seeded row would let the decryption tests pass against a
 * service that reconstructed the AAD wrongly.
 */
async function build(
  options: { connect?: boolean; status?: string } = {},
) {
  const store = createInMemoryPrisma();

  const prisma =
    store.prisma as unknown as PrismaService;

  const encryption = new EncryptionService(
    stubConfig(TEST_ENCRYPTION_CONFIG),
  );

  const oauthConfig = new GithubOAuthConfig(
    stubConfig(TEST_GITHUB_CONFIG),
  );

  const api = new GithubApiClient(oauthConfig);

  const connections =
    new GithubConnectionService(
      prisma,
      encryption,
      api,
    );

  if (options.connect !== false) {
    await connections.upsertConnection({
      userId: USER,
      accountId: ACCOUNT_ID,
      login: LOGIN,
      accessToken: TOKEN,
      grantedScopes: ['read:user'],
    });
  }

  if (options.status) {
    store.rows.connections[0]!.status =
      options.status;
  }

  const runs = new ExternalSyncRunService(
    prisma,
  );

  const evidence =
    new GithubEvidenceRepository(prisma);

  /*
   * The sleep is stubbed out, not the client. The retry decisions - how
   * many attempts a 500 gets before it becomes a failure - still execute
   * for real; a test that actually waited would be slow enough that
   * somebody would eventually delete it.
   */
  const ingestion = new GithubIngestionService(
    new GithubRestClient(async () => {}),
  );

  const sync = new GithubSyncService(
    prisma,
    encryption,
    ingestion,
    runs,
    evidence,
  );

  return {
    store,
    prisma,
    sync,
    connections,
    encryption,
    oauthConfig,
    api,
  };
}

/** A real Nest app, with the real guard, versioning and validation pipe. */
async function createApp(
  built: Awaited<ReturnType<typeof build>>,
) {
  const moduleRef =
    await Test.createTestingModule({
      controllers: [GithubController],
      providers: [
        AuthGuard,
        {
          provide: AuthService,
          useValue: {
            verifyAccessToken: async (
              token: string,
            ) => {
              if (token !== 'valid-token') {
                throw new UnauthorizedException(
                  'Invalid access token',
                );
              }

              return { id: USER };
            },
          },
        },
        {
          provide: PrismaService,
          useValue: built.prisma,
        },
        {
          provide: GithubConnectionService,
          useValue: built.connections,
        },
        {
          provide: GithubOAuthService,
          useValue: new GithubOAuthService(
            built.oauthConfig,
            new OAuthStateService(
              built.prisma,
              built.encryption,
            ),
            built.api,
            built.connections,
          ),
        },
        {
          provide: GithubSyncService,
          useValue: built.sync,
        },
      ],
    }).compile();

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

  return app;
}

afterEach(() => vi.restoreAllMocks());

describe('GithubSyncService', () => {
  describe('a successful sync', () => {
    it('persists one Evidence row per repository and closes the run SUCCEEDED', async () => {
      scriptNetwork({
        repos: { body: [repo(1), repo(2)] },
      });

      const { sync, store } = await build();

      const result = await sync.sync(USER, {
        scannedAt: SCANNED_AT,
      });

      expect(result.status).toBe('SUCCEEDED');
      expect(result.counts.created).toBe(2);
      expect(result.counts.updated).toBe(0);
      expect(result.counts.reposScanned).toBe(2);
      expect(result.counts.reposTotal).toBe(2);
      expect(result.counts.reposSkipped).toBe(0);
      expect(result.scannedAt).toBe(SCANNED_AT);
      expect(result.listingTruncated).toBe(false);
      expect(result.error).toBeNull();

      expect(store.rows.evidence).toHaveLength(2);

      /*
       * Ownership comes from the authenticated caller, never from the
       * projection - which is why EvidenceInput has no userId field.
       */
      for (const row of store.rows.evidence) {
        expect(row.userId).toBe(USER);
        expect(row.sourceType).toBe('GITHUB');
        expect(row.resumeImportId).toBeNull();
      }

      expect(
        store.rows.evidence
          .map((row) => row.externalId)
          .sort(),
      ).toEqual([
        'github:repo:1',
        'github:repo:2',
      ]);
    });

    it('dates evidence to when the work happened, not to when we looked', async () => {
      scriptNetwork({
        repos: { body: [repo(1)] },
      });

      const { sync, store } = await build();

      await sync.sync(USER, {
        scannedAt: SCANNED_AT,
      });

      const row = store.rows.evidence[0]!;

      /* pushed_at from the payload, not SCANNED_AT. */
      expect(
        row.occurredAt?.toISOString(),
      ).toBe('2026-01-01T00:00:00.000Z');

      expect(row.capturedAt.toISOString()).toBe(
        SCANNED_AT,
      );
    });

    it('re-syncing updates in place rather than duplicating', async () => {
      scriptNetwork({
        repos: { body: [repo(1), repo(2)] },
      });

      const { sync, store } = await build();

      await sync.sync(USER, {
        scannedAt: SCANNED_AT,
      });

      const second = await sync.sync(USER, {
        scannedAt: '2026-09-08T12:00:00.000Z',
      });

      expect(second.counts.created).toBe(0);
      expect(second.counts.updated).toBe(2);
      expect(store.rows.evidence).toHaveLength(2);
      expect(store.rows.syncRuns).toHaveLength(2);
    });
  });

  describe('a partial sync', () => {
    /*
     * The rule this whole phase turns on. Repository 2 is listed and then
     * skipped for budget, so nothing was established about it - and a row
     * asserting anything about it, however carefully worded, would be a
     * claim we did not earn.
     */
    it('writes no Evidence for a NOT_SCANNED repository', async () => {
      const requested = scriptNetwork({
        repos: { body: [repo(1), repo(2)] },
      });

      const { sync, store } = await build();

      const result = await sync.sync(USER, {
        scannedAt: SCANNED_AT,
        repositoryScanBudget: 1,
      });

      expect(result.status).toBe('PARTIAL');
      expect(result.counts.reposScanned).toBe(1);
      expect(result.counts.reposTotal).toBe(2);
      expect(result.counts.reposSkipped).toBe(1);
      expect(result.counts.created).toBe(1);

      expect(store.rows.evidence).toHaveLength(1);
      expect(
        store.rows.evidence[0]!.externalId,
      ).toBe('github:repo:1');

      expect(
        store.rows.evidence.some(
          (row) =>
            row.externalId ===
            'github:repo:2',
        ),
      ).toBe(false);

      /* And nothing was even asked about repo-2. */
      expect(
        requested.some((url) =>
          url.includes('/repo-2/'),
        ),
      ).toBe(false);
    });

    it('records the skipped repository in the ledger even though it has no Evidence', async () => {
      scriptNetwork({
        repos: { body: [repo(1), repo(2)] },
      });

      const { sync, store } = await build();

      await sync.sync(USER, {
        scannedAt: SCANNED_AT,
        repositoryScanBudget: 1,
      });

      const run = store.rows.syncRuns[0]!;

      expect(run.status).toBe('PARTIAL');

      const stats = run.stats as {
        completeness: {
          reposScanned: number;
          reposTotal: number;
        };
        repositories: Array<{
          externalId: string;
          commits: string;
        }>;
      };

      expect(
        stats.completeness.reposScanned,
      ).toBe(1);
      expect(
        stats.completeness.reposTotal,
      ).toBe(2);

      /*
       * The ledger reflects reality: the repository exists, it was not
       * scanned, and that is recoverable by a later reader. It is
       * withheld from Evidence, not erased from the record.
       */
      expect(
        stats.repositories.find(
          (entry) =>
            entry.externalId ===
            'github:repo:2',
        )?.commits,
      ).toBe('NOT_SCANNED');
    });

    it('does not report SUCCEEDED when the listing itself was truncated', async () => {
      /*
       * Every page still advertises a next link, so the page ceiling is
       * reached with more to fetch. That is the case where repositories
       * were never even ENUMERATED - invisible to a reposScanned >=
       * reposTotal check on its own, which is why the ledger checks
       * truncation separately.
       */
      scriptNetwork({
        repos: {
          body: [repo(1)],
          headers: {
            link: '<https://api.github.com/user/repos?page=2>; rel="next"',
          },
        },
      });

      const { sync, store } = await build();

      const result = await sync.sync(USER, {
        scannedAt: SCANNED_AT,
      });

      expect(result.listingTruncated).toBe(true);
      expect(result.status).toBe('PARTIAL');

      /*
       * The repository that WAS scanned still gets its evidence. PARTIAL
       * is not a failure: the run did read what it read.
       */
      expect(store.rows.evidence).toHaveLength(1);
    });
  });

  describe('a failed sync', () => {
    it('closes the run FAILED, writes no Evidence, and throws a code-only error', async () => {
      scriptNetwork({
        repos: { status: 500, body: {} },
      });

      const { sync, store } = await build();

      const failure = await sync
        .sync(USER, { scannedAt: SCANNED_AT })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(
        GithubSyncFailedError,
      );

      const error =
        failure as GithubSyncFailedError;

      expect(error.reasonCode).toBe(
        'github:list_repositories:unavailable',
      );

      /*
       * The caught error is dropped, not wrapped. A cause chain is walked
       * by serializers, and the frames in that chain hold the request
       * that carried the Authorization header.
       */
      expect(error.cause).toBeUndefined();
      expect(error.message).toBe(
        'GitHub sync failed',
      );

      expect(store.rows.evidence).toHaveLength(0);

      const run = store.rows.syncRuns[0]!;
      expect(run.status).toBe('FAILED');
      expect(run.finishedAt).not.toBeNull();
    });

    it('records a sanitized reason code on the run, never an error message', async () => {
      scriptNetwork({
        repos: { status: 500, body: {} },
      });

      const { sync, store } = await build();

      await sync
        .sync(USER, { scannedAt: SCANNED_AT })
        .catch(() => undefined);

      const message =
        store.rows.syncRuns[0]!.errorMessage!;

      /*
       * A fixed vocabulary: lowercase words, colons and underscores. A
       * free-text message from a caught error could not satisfy this, and
       * neither could a token, a URL or a header.
       */
      expect(message).toMatch(
        /^[a-z0-9_]+(:[a-z0-9_]+)*$/,
      );

      for (const forbidden of [
        TOKEN,
        TOKEN_PREFIX,
        'Bearer',
        'Authorization',
        'ciphertext',
      ]) {
        expect(message).not.toContain(forbidden);
      }
    });

    it('leaves no run behind when the connection is missing', async () => {
      scriptNetwork({
        repos: { body: [repo(1)] },
      });

      const { sync, store } = await build({
        connect: false,
      });

      const failure = await sync
        .sync(USER)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(
        GithubConnectionUnavailableError,
      );
      expect(
        (
          failure as GithubConnectionUnavailableError
        ).reason,
      ).toBe('missing');

      /* Nothing was attempted, so nothing is recorded. */
      expect(store.rows.syncRuns).toHaveLength(0);
      expect(store.rows.evidence).toHaveLength(0);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('refuses to sync a connection that is not ACTIVE', async () => {
      scriptNetwork({
        repos: { body: [repo(1)] },
      });

      const { sync, store } = await build({
        status: 'REVOKED',
      });

      const failure = await sync
        .sync(USER)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(
        GithubConnectionUnavailableError,
      );
      expect(
        (
          failure as GithubConnectionUnavailableError
        ).reason,
      ).toBe('inactive');

      expect(store.rows.syncRuns).toHaveLength(0);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('never syncs one user against another user’s connection', async () => {
      scriptNetwork({
        repos: { body: [repo(1)] },
      });

      const { sync, store } = await build();

      /*
       * USER has a connection; OTHER_USER does not. The lookup is keyed
       * on (userId, provider), so there is no shape in which the second
       * caller reaches the first caller's credential.
       */
      await expect(
        sync.sync(OTHER_USER),
      ).rejects.toBeInstanceOf(
        GithubConnectionUnavailableError,
      );

      expect(store.rows.evidence).toHaveLength(0);
    });
  });

  describe('the sync ledger', () => {
    it('refuses a second run alongside a live one', async () => {
      scriptNetwork({
        repos: { body: [repo(1)] },
      });

      const { sync, store, prisma } =
        await build();

      /* A live run for this connection, started just now. */
      await prisma.externalSyncRun.create({
        data: {
          connectionId:
            store.rows.connections[0]!.id,
          userId: USER,
          status: 'RUNNING',
        },
      });

      await expect(
        sync.sync(USER, {
          scannedAt: SCANNED_AT,
        }),
      ).rejects.toThrow(
        /already running/i,
      );

      /*
       * The live run is untouched: a refusal must not close somebody
       * else's run, and it must not write a FAILED row of its own.
       */
      expect(store.rows.syncRuns).toHaveLength(1);
      expect(
        store.rows.syncRuns[0]!.status,
      ).toBe('RUNNING');
      expect(store.rows.evidence).toHaveLength(0);
    });

    it('records the run against the connection and the user that owns it', async () => {
      scriptNetwork({
        repos: { body: [repo(1)] },
      });

      const { sync, store } = await build();

      const result = await sync.sync(USER, {
        scannedAt: SCANNED_AT,
      });

      const run = store.rows.syncRuns[0]!;

      expect(run.id).toBe(result.runId);
      expect(run.userId).toBe(USER);
      expect(run.connectionId).toBe(
        store.rows.connections[0]!.id,
      );
      expect(run.status).toBe('SUCCEEDED');
      expect(run.errorMessage).toBeNull();
    });
  });

  describe('credential handling', () => {
    it('decrypts the stored token and presents it to GitHub, and nowhere else', async () => {
      const requested = scriptNetwork({
        repos: { body: [repo(1)] },
      });

      const { sync, store } = await build();

      const result = await sync.sync(USER, {
        scannedAt: SCANNED_AT,
      });

      /* The real token reached the real client. */
      expect(requested.length).toBeGreaterThan(0);

      const call = vi.mocked(globalThis.fetch)
        .mock.calls[0]!;

      const headers = (
        call[1] as {
          headers: Record<string, string>;
        }
      ).headers;

      expect(headers['Authorization']).toBe(
        `Bearer ${TOKEN}`,
      );

      /* And it is in none of the durable or returned artifacts. */
      const surfaces = [
        JSON.stringify(result),
        JSON.stringify(store.rows.evidence),
        JSON.stringify(store.rows.syncRuns),
      ];

      for (const surface of surfaces) {
        for (const forbidden of [
          TOKEN,
          TOKEN_PREFIX,
          'Bearer',
          'Authorization',
          'ciphertext',
        ]) {
          expect(surface).not.toContain(
            forbidden,
          );
        }
      }
    });

    it('fails without opening a run when the stored credential cannot be decrypted', async () => {
      scriptNetwork({
        repos: { body: [repo(1)] },
      });

      const { sync, store } = await build();

      /*
       * Tampering with one byte of the ciphertext. GCM authenticates it,
       * so this is indistinguishable from the wrong key or a mismatched
       * AAD - all of which must fail closed rather than decrypt to
       * something attacker-influenced.
       */
      const row = store.rows.connections[0]!;
      row.tokenCiphertext![0] ^= 0xff;

      const failure = await sync
        .sync(USER)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(
        GithubSyncFailedError,
      );
      expect(
        (failure as GithubSyncFailedError)
          .reasonCode,
      ).toBe('credential_unreadable');

      /* Nothing was attempted at GitHub, so no run exists to fail. */
      expect(store.rows.syncRuns).toHaveLength(0);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });
});

describe('POST /v1/github/sync', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  it('rejects an unauthenticated caller and opens no run', async () => {
    scriptNetwork({
      repos: { body: [repo(1)] },
    });

    const built = await build();
    app = await createApp(built);

    await request(app.getHttpServer())
      .post('/v1/github/sync')
      .expect(401);

    await request(app.getHttpServer())
      .post('/v1/github/sync')
      .set('Authorization', 'Bearer wrong-token')
      .expect(401);

    expect(
      built.store.rows.syncRuns,
    ).toHaveLength(0);
    expect(
      built.store.rows.evidence,
    ).toHaveLength(0);
  });

  it('returns only counts, status and timestamps - never credential material', async () => {
    scriptNetwork({
      repos: { body: [repo(1), repo(2)] },
    });

    const built = await build();
    app = await createApp(built);

    const response = await request(
      app.getHttpServer(),
    )
      .post('/v1/github/sync')
      .set('Authorization', 'Bearer valid-token')
      .expect(201);

    expect(Object.keys(response.body).sort()).toEqual(
      [
        'counts',
        'error',
        'finishedAt',
        'listingTruncated',
        'runId',
        'scannedAt',
        'status',
      ],
    );

    expect(response.body.status).toBe(
      'SUCCEEDED',
    );
    expect(response.body.counts).toEqual({
      created: 2,
      updated: 0,
      reposScanned: 2,
      reposRevalidated: 0,
      reposTotal: 2,
      reposSkipped: 0,
    });

    const raw = response.text;

    for (const forbidden of [
      TOKEN,
      TOKEN_PREFIX,
      'Bearer',
      'Authorization',
      'ciphertext',
      'tokenCiphertext',
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it('answers 404 when there is no active connection, and leaks no reason detail', async () => {
    scriptNetwork({
      repos: { body: [repo(1)] },
    });

    const built = await build({
      connect: false,
    });
    app = await createApp(built);

    const response = await request(
      app.getHttpServer(),
    )
      .post('/v1/github/sync')
      .set('Authorization', 'Bearer valid-token')
      .expect(404);

    expect(response.body.message).toBe(
      'No active GitHub connection',
    );

    expect(
      built.store.rows.syncRuns,
    ).toHaveLength(0);
  });

  it('answers 502 with a reason code when the sync fails', async () => {
    scriptNetwork({
      repos: { status: 500, body: {} },
    });

    const built = await build();
    app = await createApp(built);

    const response = await request(
      app.getHttpServer(),
    )
      .post('/v1/github/sync')
      .set('Authorization', 'Bearer valid-token')
      .expect(502);

    expect(response.body.status).toBe('FAILED');
    expect(response.body.error).toBe(
      'github:list_repositories:unavailable',
    );

    expect(
      built.store.rows.syncRuns[0]!.status,
    ).toBe('FAILED');
    expect(
      built.store.rows.evidence,
    ).toHaveLength(0);

    for (const forbidden of [
      TOKEN,
      TOKEN_PREFIX,
      'Bearer',
      'Authorization',
      'ciphertext',
    ]) {
      expect(response.text).not.toContain(
        forbidden,
      );
    }
  });

  it('answers 409 when a sync is already running', async () => {
    scriptNetwork({
      repos: { body: [repo(1)] },
    });

    const built = await build();
    app = await createApp(built);

    await built.prisma.externalSyncRun.create({
      data: {
        connectionId:
          built.store.rows.connections[0]!.id,
        userId: USER,
        status: 'RUNNING',
      },
    });

    await request(app.getHttpServer())
      .post('/v1/github/sync')
      .set('Authorization', 'Bearer valid-token')
      .expect(409);
  });
});
