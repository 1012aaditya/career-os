import {
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

import { Prisma } from '@prisma/client';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { AuthenticatedRequest } from '../../../auth/auth.guard.js';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import { connectionTokenAad } from '../../crypto/aad.js';
import { toStorageBytes } from '../../crypto/bytes.js';
import { EncryptionService } from '../../crypto/encryption.service.js';
import {
  createInMemoryPrisma,
  stubConfig,
  TEST_ENCRYPTION_CONFIG,
} from '../../test-doubles.js';
import { ExternalSyncRunService } from '../external-sync-run.service.js';
import { GithubApiClient } from '../github-api.client.js';
import { GithubConnectionService } from '../github-connection.service.js';
import { GithubIngestionService } from '../github-ingestion.service.js';
import {
  GithubRequestError,
  GithubRestClient,
} from '../github-rest.client.js';
import {
  GithubSyncFailedError,
  GithubSyncService,
} from '../github-sync.service.js';
import { GithubController } from '../github.controller.js';
import type { GithubOAuthService } from '../github-oauth.service.js';

import type { EvidenceInput } from './evidence-input.js';
import { projectSyncEvidence } from './evidence-projection.js';
import { GithubEvidenceRepository } from './github-evidence.repository.js';

/*
 * The persistence boundary.
 *
 * Phase 7.4 introduces the first place where GitHub-derived data becomes
 * DURABLE: Evidence.metadata is a jsonb blob, it is queryable, it is
 * rendered to the user, and it is the field most likely to be dumped into
 * a log, a support ticket or a data export. Anything that reaches it
 * leaks permanently and leaks everywhere at once.
 *
 * So these tests are not about the projection being tidy. They are about
 * one claim: no credential material - not the access token, not the
 * Authorization header carrying it, not the ciphertext/iv/tag the token
 * is stored as, not the client secret - can reach Evidence.metadata,
 * Evidence's other columns, ExternalSyncRun.stats or
 * ExternalSyncRun.errorMessage, on ANY path including the failing ones.
 *
 * Every test here runs the real services against the in-memory Prisma
 * double and a scripted network. Only the socket is fake: the REST
 * client's retry and classification, the ingestion service's failure
 * policy, the projection and the repository's upsert all execute for
 * real. A test that stubbed the ingestion service would be asserting that
 * a fixture is clean, which is not a security property of anything.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const CONNECTION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/*
 * Split so the constant itself cannot be matched by the substring scan it
 * feeds - the scan looks for the PREFIX, which is what a real leaked token
 * of any age or type starts with.
 */
const TOKEN_PREFIX = 'gho';
const TOKEN = `${TOKEN_PREFIX}_16C7e42F292c6912E7710c838347Ae178B4a`;
const AUTHORIZATION = `Bearer ${TOKEN}`;

const ACCOUNT = {
  accountId: '583231',
  login: 'octocat',
};

const SCANNED_AT = '2026-09-07T12:00:00.000Z';

/*
 * Every documented GitHub credential prefix, plus the header and config
 * names that carry one. Matched case-insensitively against every
 * serialization of every persisted row: a leak that only shows up under
 * util.inspect, or only on a non-enumerable property, is still a leak,
 * and error reporters walk exactly those.
 */
const VALUE_NEEDLES = [
  'gho_',
  'ghu_',
  'ghp_',
  'ghs_',
  'ghr_',
  'github_pat_',
  'bearer ',
];

/*
 * Names rather than values. A field called `accessToken` or `ciphertext`
 * on a persisted row is a leak waiting to be filled in even when this
 * particular fixture leaves it empty, so the names are refused too.
 */
const FIELD_NEEDLES = [
  'authorization',
  'client_secret',
  'ciphertext',
  'accesstoken',
  'access_token',
];

/*
 * Stack frames name functions, and a function may legitimately be called
 * `decryptAccessToken`. A frame cannot contain a credential VALUE - those
 * are still scanned everywhere, including here - so frames are dropped
 * before the field-name pass rather than being allowed to fail it.
 */
function withoutStackFrames(text: string) {
  return text.replace(
    /(?:\\n|\n)\s*at\s(?:(?!\\n|\n).)*/g,
    '',
  );
}

function serializations(value: unknown): string[] {
  return [
    String(value),
    JSON.stringify(value) ?? '',
    /*
     * The own-property-names form catches a credential parked on a
     * non-enumerable property - which is where a wrapped HTTP error puts
     * its request, and where a naive `JSON.stringify(err)` would find
     * nothing while a structured logger finds everything.
     */
    JSON.stringify(
      value,
      Object.getOwnPropertyNames(Object(value)),
    ) ?? '',
    inspect(value, {
      depth: null,
      showHidden: true,
    }),
    (value as { stack?: string })?.stack ?? '',
  ];
}

/**
 * Asserts that nothing credential-shaped survives into `value`, under any
 * of the serializations something downstream might apply to it.
 *
 * Failures name the needle and quote the neighbourhood, because "expected
 * false to be true" on a 40KB blob is a test nobody can act on.
 */
function expectNoCredentials(
  label: string,
  value: unknown,
) {
  for (const text of serializations(value)) {
    const haystacks: Array<
      [string, string[]]
    > = [
      [text.toLowerCase(), VALUE_NEEDLES],
      [
        withoutStackFrames(
          text,
        ).toLowerCase(),
        FIELD_NEEDLES,
      ],
    ];

    for (const [
      haystack,
      needles,
    ] of haystacks) {
      for (const needle of needles) {
        const at = haystack.indexOf(needle);

        const verdict =
          at === -1
            ? 'clean'
            : `LEAKED "${needle}" near: ${haystack.slice(
                Math.max(0, at - 80),
                at + 120,
              )}`;

        expect(`${label}: ${verdict}`).toBe(
          `${label}: clean`,
        );
      }
    }
  }
}

/*
 * A repository payload carrying fields GitHub does not send and a
 * projection must not carry: an echoed Authorization header, an
 * access_token, a stored-ciphertext column name. They are here so that a
 * future `...source` spread in normalizeRepository, or a `...raw` in the
 * projection, fails this file instead of shipping.
 */
function hostileRepo(
  id: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    node_id: `R_${id}`,
    name: `repo-${id}`,
    full_name: `octocat/repo-${id}`,
    html_url: `https://github.com/octocat/repo-${id}`,
    owner: {
      id: 583231,
      login: 'octocat',
      type: 'User',
      /* An owner sub-object is the easiest place for a spread to hide. */
      access_token: TOKEN,
    },
    private: false,
    visibility: 'public',
    fork: false,
    archived: false,
    disabled: false,
    default_branch: 'main',
    description: 'A repository',
    size: 100,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    pushed_at: '2026-01-01T00:00:00Z',

    access_token: TOKEN,
    authorization: AUTHORIZATION,
    tokenCiphertext: 'ZmFrZS1jaXBoZXJ0ZXh0',
    _request: {
      headers: { Authorization: AUTHORIZATION },
      url: 'https://api.github.com/user/repos',
    },
    ...overrides,
  };
}

function commit(date = '2024-06-02T14:31:09Z') {
  return {
    sha: `sha-${date}`,
    commit: {
      author: {
        name: 'Someone',
        email: 'someone@example.com',
        date,
      },
    },
    author: { id: 583231, login: 'octocat' },
  };
}

type Route = {
  status?: number;
  body?: unknown;
};

type Scripted = {
  repos?: Route;
  issues?: Route;
  languages?: Route;
  commits?: Route;
  /* When set, fetch REJECTS for these routes instead of responding. */
  rejectOn?: (url: string) => boolean;
  rejection?: unknown;
};

/**
 * Scripts the network and returns the real stack wired to it.
 *
 * `sentAuthorization` records the headers actually put on the wire, so
 * the no-leak assertions cannot pass vacuously against a run that never
 * presented a credential in the first place.
 */
function build(script: Scripted) {
  const sentAuthorization: string[] = [];

  vi.spyOn(
    globalThis,
    'fetch',
  ).mockImplementation(
    async (input, init) => {
      const url = String(input);

      const headers = (init?.headers ??
        {}) as Record<string, string>;

      if (headers['Authorization']) {
        sentAuthorization.push(
          headers['Authorization'],
        );
      }

      if (script.rejectOn?.(url)) {
        throw script.rejection;
      }

      let route: Route;

      if (url.includes('/issues?')) {
        route = script.issues ?? { body: [] };
      } else if (url.includes('/languages')) {
        route = script.languages ?? { body: {} };
      } else if (url.includes('/commits')) {
        route = script.commits ?? { body: [] };
      } else {
        route = script.repos ?? { body: [] };
      }

      return new Response(
        JSON.stringify(route.body ?? []),
        {
          status: route.status ?? 200,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );
    },
  );

  const store = createInMemoryPrisma();
  const prisma =
    store.prisma as unknown as PrismaService;

  return {
    store,
    sentAuthorization,
    /* No-op sleep: the real backoff decisions run, the waiting does not. */
    ingestion: new GithubIngestionService(
      new GithubRestClient(async () => {}),
    ),
    evidence: new GithubEvidenceRepository(
      prisma,
    ),
    runs: new ExternalSyncRunService(prisma),
  };
}

/** The whole 7.4 path: fetch -> observe -> project -> persist -> close run. */
async function syncOnce(script: Scripted) {
  const harness = build(script);

  const run = await harness.runs.start({
    connectionId: CONNECTION,
    userId: USER,
  });

  const observation =
    await harness.ingestion.ingest({
      accessToken: TOKEN,
      account: ACCOUNT,
      scannedAt: SCANNED_AT,
      scannedSince: null,
    });

  const inputs = projectSyncEvidence(observation);

  const persisted =
    await harness.evidence.persistMany(
      USER,
      inputs,
    );

  const closed = await harness.runs.finish(
    run.id,
    observation,
  );

  return {
    ...harness,
    observation,
    inputs,
    persisted,
    status: closed.status,
  };
}

/**
 * The same stack, plus the pieces POST /v1/github/sync actually runs: a
 * real encrypted connection row, the sync use case, and the controller
 * that maps its failures onto an HTTP body.
 */
function buildRoute(
  script: Scripted,
  options: { tamper?: boolean } = {},
) {
  const harness = build(script);

  const encryption = new EncryptionService(
    stubConfig(TEST_ENCRYPTION_CONFIG),
  );

  const record = encryption.encrypt(
    TOKEN,
    connectionTokenAad(USER, 'GITHUB'),
  );

  const ciphertext = toStorageBytes(
    record.ciphertext,
  );

  if (options.tamper) {
    /* A byte flip: GCM authentication fails and decrypt() throws. */
    ciphertext[0] = ciphertext[0]! ^ 0xff;
  }

  const seed = async () =>
    await harness.store.prisma.externalConnection.upsert(
      {
        where: {
          userId_provider: {
            userId: USER,
            provider: 'GITHUB',
          },
        },
        create: {
          userId: USER,
          provider: 'GITHUB',
          externalAccountId: ACCOUNT.accountId,
          externalAccountLogin: ACCOUNT.login,
          tokenCiphertext: ciphertext,
          tokenIv: toStorageBytes(record.iv),
          tokenTag: toStorageBytes(record.tag),
          tokenKeyVersion: record.keyVersion,
          tokenAlg: record.alg,
          grantedScopes: ['user:email'],
          status: 'ACTIVE',
          lastVerifiedAt: new Date(),
        },
        update: {},
      },
    );

  const sync = new GithubSyncService(
    harness.store
      .prisma as unknown as PrismaService,
    encryption,
    harness.ingestion,
    harness.runs,
    harness.evidence,
  );

  const controller = new GithubController(
    {} as GithubOAuthService,
    {} as GithubConnectionService,
    sync,
  );

  const request = {
    user: { id: USER },
  } as AuthenticatedRequest;

  return {
    ...harness,
    encryption,
    record,
    seed,
    sync,
    controller,
    request,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('7.4 persistence boundary', () => {
  /*
   * Every assertion in this file is a NEGATIVE one, and a negative
   * assertion whose detector is broken passes forever without anybody
   * noticing. So the detector is tested first, against a planted
   * credential in the exact place - a metadata blob - the rest of the
   * file claims one can never appear.
   */
  it('detects a planted credential, so the rest of this file cannot pass vacuously', () => {
    expect(() =>
      expectNoCredentials('planted', {
        metadata: { note: AUTHORIZATION },
      }),
    ).toThrow();

    expect(() =>
      expectNoCredentials('planted', {
        metadata: { note: TOKEN },
      }),
    ).toThrow();

    /*
     * And a credential-shaped FIELD, empty of any value. Stack frames are
     * stripped before this pass, so this proves the stripping did not
     * take the field check with it.
     */
    expect(() =>
      expectNoCredentials('planted', {
        metadata: { tokenCiphertext: '' },
      }),
    ).toThrow();

    expect(() =>
      expectNoCredentials('planted', {
        metadata: { accessToken: '' },
      }),
    ).toThrow();

    /*
     * And a credential hidden where only a walking serializer finds it:
     * a non-enumerable property, which is where HTTP clients park the
     * request they failed on.
     */
    const hidden = {};

    Object.defineProperty(hidden, 'config', {
      enumerable: false,
      value: {
        headers: {
          Authorization: AUTHORIZATION,
        },
      },
    });

    expect(() =>
      expectNoCredentials('planted', hidden),
    ).toThrow();
  });

  describe('the happy path', () => {
    it('persists no credential material in any Evidence column or sync-run row', async () => {
      const {
        store,
        sentAuthorization,
        persisted,
        status,
      } = await syncOnce({
        repos: { body: [hostileRepo(1)] },
        languages: {
          body: { TypeScript: 1200, CSS: 40 },
        },
        commits: { body: [commit()] },
      });

      /*
       * The run really did present the token. Without this the assertions
       * below would also pass against a sync that never authenticated.
       */
      expect(sentAuthorization).toContain(
        AUTHORIZATION,
      );

      expect(persisted).toEqual({
        created: 1,
        updated: 0,
      });
      expect(status).toBe('SUCCEEDED');
      expect(store.rows.evidence).toHaveLength(1);

      expectNoCredentials(
        'evidence rows',
        store.rows.evidence,
      );
      expectNoCredentials(
        'sync run rows',
        store.rows.syncRuns,
      );
    });

    it('writes only named, projected fields into metadata - never the raw response', async () => {
      const { store } = await syncOnce({
        repos: { body: [hostileRepo(1)] },
        languages: { body: { TypeScript: 1200 } },
        commits: { body: [commit()] },
      });

      const metadata = store.rows.evidence[0]!
        .metadata as Record<string, unknown>;

      /*
       * An allowlist, asserted as an exact set. A raw body persisted
       * wholesale - or merged in "just for debugging" - shows up here as
       * an extra key rather than having to be noticed inside a blob.
       */
      expect(Object.keys(metadata).sort()).toEqual(
        [
          'account',
          'activity',
          'completeness',
          'languages',
          'provider',
          'repository',
        ],
      );

      const repository = metadata[
        'repository'
      ] as Record<string, unknown>;

      expect(
        Object.keys(repository).sort(),
      ).toEqual([
        'createdAt',
        'defaultBranch',
        'description',
        'fullName',
        'htmlUrl',
        'isArchived',
        'isDisabled',
        'isFork',
        'isPublic',
        'name',
        'nodeId',
        'owner',
        'pushedAt',
        'repoId',
        'sizeKb',
        'updatedAt',
      ]);

      expect(
        Object.keys(
          repository['owner'] as Record<
            string,
            unknown
          >,
        ).sort(),
      ).toEqual(['id', 'login', 'type']);

      /*
       * The account block is public identity only. `accessToken` would be
       * the natural field for a future "so we know whose view this was"
       * change to reach for.
       */
      expect(
        Object.keys(
          metadata['account'] as Record<
            string,
            unknown
          >,
        ).sort(),
      ).toEqual(['accountId', 'login']);
    });

    it('keeps a credential smuggled onto an EvidenceInput out of the row and out of the query', async () => {
      const harness = build({});

      /*
       * The projection is not the only caller this repository can ever
       * have. This asserts the repository itself is the boundary: it
       * writes the columns it names, so a caller handing it extra fields
       * - or a future EvidenceInput that grows one - cannot widen what
       * reaches the database or what a failing query could echo back.
       */
      const upsertCalls: Array<
        Record<string, unknown>
      > = [];

      const model = harness.store.prisma
        .evidence as unknown as {
        upsert: (
          args: Record<string, unknown>,
        ) => Promise<unknown>;
      };

      const realUpsert = model.upsert.bind(model);

      model.upsert = async (args) => {
        upsertCalls.push(args);
        return await realUpsert(args);
      };

      const smuggled = {
        sourceType: 'GITHUB',
        externalId: 'github:repo:1',
        title: 'octocat/repo-1',
        description: 'A repository',
        sourceUrl:
          'https://github.com/octocat/repo-1',
        occurredAt: new Date(SCANNED_AT),
        capturedAt: new Date(SCANNED_AT),
        metadata: { provider: 'github' },

        accessToken: TOKEN,
        authorization: AUTHORIZATION,
        tokenCiphertext: 'ZmFrZS1jaXBoZXJ0ZXh0',
      } as unknown as EvidenceInput;

      await harness.evidence.persist(
        USER,
        smuggled,
      );

      expect(upsertCalls).toHaveLength(1);

      const allowed = new Set([
        'userId',
        'sourceType',
        'externalId',
        'resumeImportId',
        'title',
        'description',
        'sourceUrl',
        'occurredAt',
        'capturedAt',
        'metadata',
      ]);

      const args = upsertCalls[0]!;

      for (const section of [
        'create',
        'update',
      ] as const) {
        for (const key of Object.keys(
          (args[section] ?? {}) as Record<
            string,
            unknown
          >,
        )) {
          expect(
            `${section}.${
              allowed.has(key)
                ? 'allowed'
                : `UNEXPECTED ${key}`
            }`,
          ).toBe(`${section}.allowed`);
        }
      }

      expectNoCredentials(
        'query sent to prisma',
        upsertCalls,
      );
      expectNoCredentials(
        'evidence rows',
        harness.store.rows.evidence,
      );
    });
  });

  describe('failure paths', () => {
    /*
     * The classic leak, reproduced faithfully: an HTTP client rejects
     * with an error object that has the request - and therefore the
     * Authorization header - hanging off it. Every field below is one a
     * real client (axios, got, node-fetch wrappers) actually populates.
     */
    function credentialBearingRejection() {
      const error = new Error(
        'connect ECONNREFUSED 140.82.121.6:443',
      ) as Error & Record<string, unknown>;

      error['config'] = {
        method: 'get',
        url: 'https://api.github.com/users/octocat/repos',
        headers: {
          Authorization: AUTHORIZATION,
          'User-Agent': 'career-os',
        },
      };

      error['request'] = {
        _header: `GET /users/octocat/repos HTTP/1.1\r\nAuthorization: ${AUTHORIZATION}\r\n\r\n`,
      };

      error['response'] = {
        config: {
          headers: {
            Authorization: AUTHORIZATION,
          },
        },
      };

      return error;
    }

    it('does not carry the Authorization header out of a failed listing, into the error or the run', async () => {
      const harness = build({
        rejectOn: () => true,
        rejection: credentialBearingRejection(),
      });

      const run = await harness.runs.start({
        connectionId: CONNECTION,
        userId: USER,
      });

      let caught: unknown;

      try {
        await harness.ingestion.ingest({
          accessToken: TOKEN,
          account: ACCOUNT,
          scannedAt: SCANNED_AT,
          scannedSince: null,
        });
      } catch (error) {
        caught = error;
      }

      /* The real path was taken: the rejection was reached and replaced. */
      expect(caught).toBeInstanceOf(
        GithubRequestError,
      );
      expect(
        (caught as GithubRequestError).reason,
      ).toBe('network_error');
      expect(harness.sentAuthorization).toContain(
        AUTHORIZATION,
      );

      /*
       * Including the cause chain, which is where a "wrap it, don't
       * discard it" refactor would put the original.
       */
      expectNoCredentials(
        'thrown error',
        caught,
      );
      expectNoCredentials(
        'error cause',
        (caught as { cause?: unknown }).cause,
      );

      /*
       * The two strings a sync orchestrator is most likely to hand to
       * fail(). Both must already be safe: a boundary that only holds
       * when every caller remembers to sanitize is not a boundary.
       */
      expectNoCredentials(
        'error.message',
        (caught as Error).message,
      );
      expectNoCredentials(
        'String(error)',
        String(caught),
      );

      await harness.runs.fail(
        run.id,
        (caught as Error).message,
      );

      const row = harness.store.rows.syncRuns[0]!;

      expect(row.status).toBe('FAILED');
      expectNoCredentials(
        'sync run errorMessage',
        row.errorMessage,
      );
      expectNoCredentials(
        'sync run rows',
        harness.store.rows.syncRuns,
      );

      /* A listing that never returned must write no evidence at all. */
      expect(harness.store.rows.evidence).toEqual(
        [],
      );
    });

    it('records a repository whose scan failed with a credential-bearing error as unscanned, and persists nothing from it', async () => {
      /*
       * The listing succeeds and the per-repository scan rejects, so the
       * error is SWALLOWED by the ingestion service rather than thrown.
       * That is the more dangerous shape: a swallowed error is one that
       * something may decide to record "for diagnostics" inside the
       * observation, which is on its way to jsonb.
       */
      const { store, observation, status } =
        await syncOnce({
          repos: { body: [hostileRepo(1)] },
          rejectOn: (url) =>
            url.includes('/languages') ||
            url.includes('/commits'),
          rejection: credentialBearingRejection(),
        });

      const repository =
        observation.repositories[0]!;

      /* The failure path really was taken. */
      expect(
        repository.completeness.commits,
      ).toBe('NOT_SCANNED');
      expect(
        repository.activity.commitsAttributed,
      ).toBeNull();
      expect(status).toBe('PARTIAL');

      /*
       * Whether a NOT_SCANNED repository gets a row at all is the sync
       * layer's withholding policy, not a security property, so it is
       * not asserted here. What is asserted is that whatever WAS written
       * carries nothing from the error that caused the skip.
       */
      expectNoCredentials(
        'observation',
        observation,
      );
      expectNoCredentials(
        'evidence rows',
        store.rows.evidence,
      );
      expectNoCredentials(
        'sync run rows',
        store.rows.syncRuns,
      );
    });

    it('rethrows a Prisma unique-violation without attaching anything credential-bearing', async () => {
      /*
       * Prisma errors are the other classic disclosure: they can carry
       * the failing query and its parameters, and they are exactly the
       * kind of object a catch block hands to a logger. Here the
       * repository's "P2002 with no row behind it" path runs - the one
       * that rethrows untouched - and the assertion is that the error
       * escapes unenriched and that the parameters it could name are
       * credential-free.
       */
      const harness = build({});

      const violation =
        new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed on the fields: (`userId`,`sourceType`,`externalId`)',
          {
            code: 'P2002',
            clientVersion: 'test',
            meta: {
              target: [
                'userId',
                'sourceType',
                'externalId',
              ],
            },
          },
        );

      const model = harness.store.prisma
        .evidence as unknown as {
        upsert: () => Promise<unknown>;
      };

      model.upsert = async () => {
        throw violation;
      };

      let caught: unknown;

      try {
        await harness.evidence.persist(USER, {
          sourceType: 'GITHUB',
          externalId: 'github:repo:1',
          title: 'octocat/repo-1',
          description: 'A repository',
          sourceUrl:
            'https://github.com/octocat/repo-1',
          occurredAt: new Date(SCANNED_AT),
          capturedAt: new Date(SCANNED_AT),
          metadata: { provider: 'github' },
        });
      } catch (error) {
        caught = error;
      }

      /* Untouched: the same object, with nothing added to it. */
      expect(caught).toBe(violation);
      expect(
        Object.keys(caught as object),
      ).not.toContain('input');

      expectNoCredentials(
        'prisma error',
        caught,
      );
      expectNoCredentials(
        'prisma error meta',
        (caught as { meta?: unknown }).meta,
      );
    });
  });

  describe('stored credential material', () => {
    it('never copies connection ciphertext into evidence, a sync run, or GET /github/status', async () => {
      const harness = build({
        repos: { body: [hostileRepo(1)] },
        languages: { body: { TypeScript: 1200 } },
        commits: { body: [commit()] },
      });

      const encryption = new EncryptionService(
        stubConfig(TEST_ENCRYPTION_CONFIG),
      );

      const record = encryption.encrypt(
        TOKEN,
        connectionTokenAad(USER, 'GITHUB'),
      );

      /*
       * A real encrypted connection for this user, written the way the
       * connection service writes one. If any part of 7.4 ever reads the
       * connection row and carries it forward - "so metadata knows which
       * connection produced it" - these bytes are what would ride along.
       */
      await harness.store.prisma.externalConnection.upsert(
        {
          where: {
            userId_provider: {
              userId: USER,
              provider: 'GITHUB',
            },
          },
          create: {
            userId: USER,
            provider: 'GITHUB',
            externalAccountId: ACCOUNT.accountId,
            externalAccountLogin: ACCOUNT.login,
            tokenCiphertext: toStorageBytes(
              record.ciphertext,
            ),
            tokenIv: toStorageBytes(record.iv),
            tokenTag: toStorageBytes(record.tag),
            tokenKeyVersion: record.keyVersion,
            tokenAlg: record.alg,
            grantedScopes: ['user:email'],
            status: 'ACTIVE',
            lastVerifiedAt: new Date(),
          },
          update: {},
        },
      );

      const run = await harness.runs.start({
        connectionId: CONNECTION,
        userId: USER,
      });

      const observation =
        await harness.ingestion.ingest({
          accessToken: TOKEN,
          account: ACCOUNT,
          scannedAt: SCANNED_AT,
          scannedSince: null,
        });

      await harness.evidence.persistMany(
        USER,
        projectSyncEvidence(observation),
      );

      await harness.runs.finish(
        run.id,
        observation,
      );

      const ciphertextBase64 =
        record.ciphertext.toString('base64');

      const persisted = [
        ...serializations(
          harness.store.rows.evidence,
        ),
        ...serializations(
          harness.store.rows.syncRuns,
        ),
      ].join('\n');

      expect(persisted).not.toContain(
        ciphertextBase64,
      );
      expect(persisted).not.toContain(
        record.ciphertext.toString('hex'),
      );
      expect(persisted).not.toContain(
        record.iv.toString('base64'),
      );
      expect(persisted).not.toContain(
        record.tag.toString('base64'),
      );

      expectNoCredentials(
        'evidence rows',
        harness.store.rows.evidence,
      );
      expectNoCredentials(
        'sync run rows',
        harness.store.rows.syncRuns,
      );

      /*
       * The read side of the same boundary. GET /github/status is the
       * route the app polls after a sync, so it is the most-called place
       * a widened select would surface token columns.
       */
      const connections =
        new GithubConnectionService(
          harness.store
            .prisma as unknown as PrismaService,
          encryption,
          {} as GithubApiClient,
        );

      const status = await connections.getStatus(
        USER,
      );

      expectNoCredentials(
        'GET /github/status',
        status,
      );
      expect(status.connected).toBe(true);
    });
  });

  /*
   * POST /v1/github/sync, end to end.
   *
   * This is the whole 7.4 surface in one call: it decrypts a real stored
   * credential, presents it to GitHub, writes Evidence, closes a ledger
   * row and returns a body over the network. Every earlier test in this
   * file checks one segment of that; these check the composition, which
   * is where a leak that no single layer introduces can still appear.
   */
  describe('POST /v1/github/sync', () => {
    it('returns a body with no credential material and writes none', async () => {
      const harness = buildRoute({
        repos: { body: [hostileRepo(1)] },
        languages: { body: { TypeScript: 1200 } },
        commits: { body: [commit()] },
      });

      await harness.seed();

      const summary =
        await harness.controller.runSync(
          harness.request,
        );

      /* The stored credential really was decrypted and presented. */
      expect(harness.sentAuthorization).toContain(
        AUTHORIZATION,
      );
      expect(summary.status).toBe('SUCCEEDED');
      expect(summary.counts.created).toBe(1);

      expectNoCredentials(
        'sync response body',
        summary,
      );
      expectNoCredentials(
        'evidence rows',
        harness.store.rows.evidence,
      );
      expectNoCredentials(
        'sync run rows',
        harness.store.rows.syncRuns,
      );
    });

    it('answers a credential-bearing network failure with a reason code, not an error', async () => {
      const rejection = new Error(
        'connect ECONNREFUSED',
      ) as Error & Record<string, unknown>;

      rejection['config'] = {
        headers: { Authorization: AUTHORIZATION },
      };

      const harness = buildRoute({
        rejectOn: () => true,
        rejection,
      });

      await harness.seed();

      let caught: unknown;

      try {
        await harness.controller.runSync(
          harness.request,
        );
      } catch (error) {
        caught = error;
      }

      /* The failing path really ran against a live credential. */
      expect(harness.sentAuthorization).toContain(
        AUTHORIZATION,
      );
      expect(caught).toBeDefined();

      /*
       * The HTTP body is what crosses the network, so it is checked
       * separately from the exception object: an exception can be safe
       * to log and still render something unsafe.
       */
      const body = (
        caught as {
          getResponse?: () => unknown;
        }
      ).getResponse?.();

      expectNoCredentials(
        'thrown HTTP exception',
        caught,
      );
      expectNoCredentials(
        'HTTP response body',
        body,
      );
      expectNoCredentials(
        'exception cause',
        (caught as { cause?: unknown }).cause,
      );

      const row =
        harness.store.rows.syncRuns[0]!;

      expect(row.status).toBe('FAILED');
      expect(row.errorMessage).toBe(
        'github:list_repositories:network_error',
      );
      expectNoCredentials(
        'sync run rows',
        harness.store.rows.syncRuns,
      );

      expect(
        harness.store.rows.evidence,
      ).toEqual([]);
    });

    it('reports an undecryptable credential without echoing any of it', async () => {
      const harness = buildRoute(
        { repos: { body: [] } },
        { tamper: true },
      );

      await harness.seed();

      let caught: unknown;

      try {
        await harness.sync.sync(USER);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(
        GithubSyncFailedError,
      );
      expect(
        (caught as GithubSyncFailedError)
          .reasonCode,
      ).toBe('credential_unreadable');

      expectNoCredentials(
        'decryption failure',
        caught,
      );

      const serialized = serializations(
        caught,
      ).join('\n');

      expect(serialized).not.toContain(
        harness.record.ciphertext.toString(
          'base64',
        ),
      );
      expect(serialized).not.toContain(
        harness.record.iv.toString('base64'),
      );

      /* Nothing was attempted at GitHub, so no ledger row was opened. */
      expect(
        harness.store.rows.syncRuns,
      ).toEqual([]);
      expect(
        harness.store.rows.evidence,
      ).toEqual([]);
    });
  });

  /*
   * The static rule, checked statically.
   *
   * Every leak the runtime tests above prevent is one an author can
   * reintroduce in a single line, in a file that does not exist yet - and
   * the 7.4 sync orchestrator is being written alongside this file. So
   * the source itself is scanned for the one construct that causes this
   * class of disclosure: handing a caught error OBJECT to a logger, which
   * walks it, finds the request the HTTP client attached, and prints the
   * Authorization header.
   *
   * Interpolating a sanitized string is fine and is what the existing
   * services do; this only refuses the object form.
   */
  describe('source rules', () => {
    const INTEGRATIONS = fileURLToPath(
      new URL('../../', import.meta.url),
    );

    function sources(dir: string): string[] {
      const found: string[] = [];

      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);

        if (statSync(path).isDirectory()) {
          found.push(...sources(path));
          continue;
        }

        if (
          entry.endsWith('.ts') &&
          !entry.endsWith('.spec.ts')
        ) {
          found.push(path);
        }
      }

      return found;
    }

    /* Comments discuss this exact anti-pattern by name. */
    function stripComments(source: string) {
      return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
    }

    it('passes no caught error object to a logger anywhere in integrations', () => {
      const offenders: string[] = [];

      const bareError =
        /\.(log|warn|error|debug|verbose|fatal)\s*\(\s*(error|err|e|exception|cause)\s*[,)]/;

      const errorInObject =
        /\.(log|warn|error|debug|verbose|fatal)\s*\(\s*\{[^}]*\b(error|err|exception|cause)\b/;

      const files = sources(INTEGRATIONS);

      /* The scan reached the source tree rather than an empty directory. */
      expect(files.length).toBeGreaterThan(10);

      for (const file of files) {
        const lines = stripComments(
          readFileSync(file, 'utf8'),
        ).split('\n');

        lines.forEach((line, index) => {
          if (
            bareError.test(line) ||
            errorInObject.test(line)
          ) {
            offenders.push(
              `${file}:${index + 1}: ${line.trim()}`,
            );
          }
        });
      }

      expect(offenders).toEqual([]);
    });
  });
});
