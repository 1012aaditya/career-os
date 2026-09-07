import { PrismaService } from '../../prisma/prisma.service.js';
import { EncryptionService } from '../crypto/encryption.service.js';
import {
  createInMemoryPrisma,
  stubConfig,
  TEST_ENCRYPTION_CONFIG,
  TEST_GITHUB_CONFIG,
} from '../test-doubles.js';

import { ExternalSyncRunService } from './external-sync-run.service.js';
import { GithubApiClient } from './github-api.client.js';
import { GithubConnectionService } from './github-connection.service.js';
import { GithubIngestionService } from './github-ingestion.service.js';
import { GithubOAuthConfig } from './github-oauth.config.js';
import { GithubRestClient } from './github-rest.client.js';
import {
  GithubSyncFailedError,
  GithubSyncService,
} from './github-sync.service.js';
import { GithubEvidenceRepository } from './evidence/github-evidence.repository.js';

/*
 * Phase 7.6: the sync stops rescanning what it already knows.
 *
 * WHAT THIS FILE IS FOR, AND WHY IT IS SHAPED LIKE THIS.
 *
 * "Incremental" is not a property you can observe from the outside by
 * looking at rows. A sync that re-fetched every repository and then wrote
 * the same values back would produce byte-identical Evidence and pass
 * every row-level assertion in this repository - while still spending the
 * user's shared rate-limit budget on work it did not need to do. The only
 * evidence that a sync was incremental is the set of HTTP requests it did
 * NOT make. So every test here that claims something about incrementality
 * asserts on the recorded request URLs, not only on what was persisted.
 *
 * Everything above the network and the database is the REAL object graph:
 * the real ingestion service, the real REST client with its real
 * pagination, retry and 304 handling, the real projection, the real
 * persistence with the unique index enforced, and the real ledger. Only
 * `fetch` and Prisma are substituted. That matters most for the
 * "incomplete run must not unlearn" tests: a stubbed ingestion service
 * handing back a hand-written observation would let them pass against an
 * implementation with no merge and no budget logic at all, because the
 * fixture would be doing the work the code is supposed to do.
 *
 * THE RULE THESE TESTS DEFEND, stated once.
 *
 * Skipping work is only safe if skipping is indistinguishable from doing
 * the work. A repository we chose not to look at must end the sync
 * holding exactly what it held before - the same counts, the same
 * languages, the same row, unwritten - and a run that skipped something
 * it could not prove was unchanged must never call itself SUCCEEDED. The
 * failure mode this file exists to catch is not "the sync is slow". It is
 * "the sync decided nothing changed, was wrong, and quietly replaced a
 * real observation with an absence".
 *
 * A NOTE ON COMMIT COUNTS. They stay ABSOLUTE totals from a full walk of
 * a changed repository, deliberately NOT deltas from a `since` window.
 * Summing deltas is not idempotent under retry: a run that dies after
 * persisting and before closing its ledger row would have its delta
 * counted twice by the retry. No test below assumes delta semantics, and
 * one that did would be encoding a bug as a requirement.
 */

const USER = '11111111-1111-4111-8111-111111111111';

/*
 * Split so the literal credential never appears in this file as a
 * contiguous string, and - more usefully - so the leak assertions can
 * look for the PREFIX independently of the full value.
 */
const TOKEN_PREFIX = 'gho';
const TOKEN = `${TOKEN_PREFIX}_16C7e42F292c6912E7710c838347Ae178B4a`;
const AUTHORIZATION = `Bearer ${TOKEN}`;

const ACCOUNT_ID = '583231';
const LOGIN = 'octocat';

/* A second account, so attribution has something to reject. */
const STRANGER_ID = 999001;

const FIRST_SCAN = '2026-09-07T12:00:00.000Z';
const SECOND_SCAN = '2026-09-08T12:00:00.000Z';
const THIRD_SCAN = '2026-09-09T12:00:00.000Z';

/* The default `pushed_at`, and the value that means "code landed since". */
const PUSHED = '2026-01-01T00:00:00Z';
const PUSHED_LATER = '2026-06-01T00:00:00Z';

type Store = ReturnType<
  typeof createInMemoryPrisma
>;

type EvidenceRow =
  Store['rows']['evidence'][number];

/* The parts of persisted metadata these tests read back. */
type StoredMetadata = {
  repository: {
    repoId: string;
    fullName: string;
    pushedAt: string | null;
  };
  languages: Array<{
    name: string;
    bytes: number;
  }>;
  activity: {
    commitsAttributed: number | null;
    pullRequestsAuthored: number | null;
    issuesAuthored: number | null;
    firstActivityAt: string | null;
    lastActivityAt: string | null;
  };
  completeness: {
    commits: string;
    scannedAt: string;
    scannedSince: string | null;
    truncated: boolean;
    reposScanned: number;
    reposTotal: number;
    listingTruncated: boolean;
    previouslyObservedAt?: string | null;
  };
};

function metadataOf(
  row: EvidenceRow,
): StoredMetadata {
  return row.metadata as StoredMetadata;
}

function evidenceFor(
  store: Store,
  repoId: number,
): EvidenceRow {
  const row = store.rows.evidence.find(
    (candidate) =>
      candidate.externalId ===
      `github:repo:${repoId}`,
  );

  if (!row) {
    throw new Error(
      `No Evidence row for repository ${repoId}`,
    );
  }

  return row;
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

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
    pushed_at: PUSHED,
    ...overrides,
  };
}

/* A commit GitHub resolved to the connected account. */
function commit(
  date = '2024-06-02T14:31:09Z',
  authorId = Number(ACCOUNT_ID),
) {
  return {
    sha: `sha-${date}-${authorId}`,
    commit: {
      author: {
        name: 'Octo Cat',
        email: 'octocat@example.com',
        date,
      },
    },
    /*
     * The top-level `author` is the GitHub ACCOUNT, which is the only
     * thing attribution may key on. `commit.author` above is git
     * metadata and is forgeable by anyone.
     */
    author: { id: authorId, login: LOGIN },
  };
}

/* `n` attributed commits, each with a distinct instant. */
function commits(n: number) {
  return Array.from({ length: n }, (_, i) =>
    commit(
      `2024-06-${String(i + 2).padStart(
        2,
        '0',
      )}T14:31:09Z`,
    ),
  );
}

function issue(
  repoId: number,
  authorId = Number(ACCOUNT_ID),
) {
  return {
    id: 900_000 + repoId * 10 + authorId % 10,
    number: 1,
    title: 'An issue',
    user: { id: authorId, login: LOGIN },
    repository: {
      id: repoId,
      name: `repo-${repoId}`,
    },
  };
}

function pull(repoId: number) {
  return {
    ...issue(repoId),
    id: 800_000 + repoId,
    /*
     * GitHub's own discriminator: every pull request is an issue, and
     * the two are told apart by the presence of this key.
     */
    pull_request: {
      url: `https://api.github.com/repos/${LOGIN}/repo-${repoId}/pulls/1`,
    },
  };
}

/* ------------------------------------------------------------------ */
/* The network                                                         */
/* ------------------------------------------------------------------ */

type Route = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

/* Per-repository routes may vary by repository name. */
type RepoRoute = Route | ((name: string) => Route);

type Script = {
  repos?: Route;
  issues?: Route;
  languages?: RepoRoute;
  commits?: RepoRoute;
  /* When set, fetch REJECTS instead of responding. */
  rejectOn?: (url: string) => boolean;
  rejection?: unknown;
};

const REPO_PATH = /\/repos\/[^/]+\/([^/?]+)\//;

function repoNameOf(url: string): string {
  return REPO_PATH.exec(url)?.[1] ?? '';
}

function resolveRoute(
  route: RepoRoute | undefined,
  fallback: Route,
  url: string,
): Route {
  if (route === undefined) {
    return fallback;
  }

  return typeof route === 'function'
    ? route(repoNameOf(url))
    : route;
}

/**
 * Scripts the network and records what was asked for.
 *
 * `requested` is the load-bearing part of this harness. Assertions about
 * which endpoints were NOT called are the only direct evidence that a
 * sync skipped work rather than redoing it and writing the same answer
 * back, so the recorder is deliberately per-URL and resettable between
 * syncs in the same test.
 *
 * `sentAuthorization` records the headers actually put on the wire, so a
 * no-leak assertion cannot pass vacuously against a run that never
 * presented a credential at all.
 */
function network(initial: Script) {
  let script = initial;

  const requested: string[] = [];
  const sentAuthorization: string[] = [];

  vi.spyOn(
    globalThis,
    'fetch',
  ).mockImplementation(
    async (input, init) => {
      const url = String(input);

      requested.push(url);

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
        route = resolveRoute(
          script.languages,
          { body: { TypeScript: 1000 } },
          url,
        );
      } else if (url.includes('/commits')) {
        route = resolveRoute(
          script.commits,
          { body: [commit()] },
          url,
        );
      } else {
        route = script.repos ?? { body: [] };
      }

      /*
       * A 304 (and any other null-body status) must be constructed with
       * a null body or Response itself throws - which is why an absent
       * `body` is null here rather than an empty array.
       */
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
    },
  );

  return {
    requested,
    sentAuthorization,
    /** Swap the scripted payloads between syncs in one test. */
    script(next: Script) {
      script = next;
    },
    /** Forget history, so the NEXT sync can be asserted on alone. */
    reset() {
      requested.length = 0;
    },
    /** Did anything ask about this repository's own endpoints? */
    touched(name: string): boolean {
      return requested.some((url) =>
        url.includes(`/${name}/`),
      );
    },
    /** Was the cross-repository authored-activity query made? */
    askedForAuthoredActivity(): boolean {
      return requested.some((url) =>
        url.includes('/issues?'),
      );
    },
  };
}

/* ------------------------------------------------------------------ */
/* The object graph                                                    */
/* ------------------------------------------------------------------ */

/**
 * Wires the real services over an in-memory database.
 *
 * The connection is written through the REAL GithubConnectionService, so
 * the stored token went through the real encrypt path with the real AAD.
 * A hand-seeded row would let the credential tests pass against a service
 * that reconstructed the AAD wrongly.
 */
async function build() {
  const store = createInMemoryPrisma();

  const prisma =
    store.prisma as unknown as PrismaService;

  const encryption = new EncryptionService(
    stubConfig(TEST_ENCRYPTION_CONFIG),
  );

  const oauthConfig = new GithubOAuthConfig(
    stubConfig(TEST_GITHUB_CONFIG),
  );

  const connections =
    new GithubConnectionService(
      prisma,
      encryption,
      new GithubApiClient(oauthConfig),
    );

  await connections.upsertConnection({
    userId: USER,
    accountId: ACCOUNT_ID,
    login: LOGIN,
    accessToken: TOKEN,
    grantedScopes: ['read:user'],
  });

  /*
   * The sleep is stubbed, not the client. The retry DECISIONS - how many
   * attempts a 500 gets, whether a rate limit is waited out - still
   * execute for real; a test that actually waited would be slow enough
   * that somebody would eventually delete it.
   */
  const sync = new GithubSyncService(
    prisma,
    encryption,
    new GithubIngestionService(
      new GithubRestClient(async () => {}),
    ),
    new ExternalSyncRunService(prisma),
    new GithubEvidenceRepository(prisma),
  );

  return { store, prisma, sync };
}

/**
 * The persisted rows, stripped of everything that cannot be equal across
 * two independent runs.
 *
 * `id` is a fresh UUID and `createdAt`/`updatedAt` are wall-clock, so
 * comparing them across two separately-built stores would compare the
 * test harness rather than the sync. Everything that the sync actually
 * DECIDES survives: identity, prose, instants and metadata.
 */
function persistedShape(store: Store) {
  return store.rows.evidence
    .map((row) => ({
      externalId: row.externalId,
      sourceType: row.sourceType,
      title: row.title,
      description: row.description,
      sourceUrl: row.sourceUrl,
      occurredAt:
        row.occurredAt?.toISOString() ?? null,
      capturedAt: row.capturedAt.toISOString(),
      metadata: row.metadata,
    }))
    .sort((a, b) =>
      (a.externalId ?? '') <
      (b.externalId ?? '')
        ? -1
        : 1,
    );
}

/* ------------------------------------------------------------------ */
/* Credential scanning                                                 */
/* ------------------------------------------------------------------ */

const FORBIDDEN = [
  TOKEN,
  `${TOKEN_PREFIX}_`,
  'Bearer',
  'Authorization',
  'ciphertext',
];

/**
 * Flattens a value - own properties, non-enumerables, and cause chains
 * included - into text.
 *
 * JSON.stringify is not sufficient here. The classic leak is an HTTP
 * client rejecting with an error that has the request hanging off it as a
 * NON-ENUMERABLE property, or as `cause`; JSON.stringify shows neither,
 * so a check built on it would report "clean" on exactly the object that
 * is carrying the token.
 */
function flatten(value: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];

  const walk = (node: unknown): void => {
    if (node === null || node === undefined) {
      return;
    }

    if (typeof node === 'string') {
      parts.push(node);
      return;
    }

    if (typeof node !== 'object') {
      parts.push(String(node));
      return;
    }

    if (seen.has(node)) {
      return;
    }

    seen.add(node);

    for (const key of Reflect.ownKeys(node)) {
      if (typeof key !== 'string') {
        continue;
      }

      /* The KEY too: a bare `Authorization:` header name is a leak. */
      parts.push(key);
      walk(
        (node as Record<string, unknown>)[key],
      );
    }

    if (node instanceof Error) {
      walk(node.cause);
    }
  };

  walk(value);

  return parts.join('\n');
}

function expectNoCredentials(
  label: string,
  value: unknown,
): void {
  const text = flatten(value);

  for (const forbidden of FORBIDDEN) {
    expect(
      text.includes(forbidden),
      `${label} leaked ${forbidden}`,
    ).toBe(false);
  }
}

/**
 * A rejection of exactly the shape a real HTTP client produces.
 *
 * Every field below is one axios, got or a node-fetch wrapper actually
 * populates on a transport failure, and each of them holds the request -
 * Authorization header included. This is the object the sync must drop on
 * the floor rather than wrap, log or attach as a cause.
 */
function credentialBearingRejection(): Error {
  const error = new Error(
    'connect ECONNREFUSED 140.82.121.6:443',
  ) as Error & Record<string, unknown>;

  error['config'] = {
    method: 'get',
    url: `https://api.github.com/users/${LOGIN}/repos`,
    headers: {
      Authorization: AUTHORIZATION,
      'User-Agent': 'career-os',
    },
  };

  error['request'] = {
    _header: `GET /users/${LOGIN}/repos HTTP/1.1\r\nAuthorization: ${AUTHORIZATION}\r\n\r\n`,
  };

  error['response'] = {
    config: {
      headers: { Authorization: AUTHORIZATION },
    },
  };

  return error;
}

afterEach(() => vi.restoreAllMocks());

/* ================================================================== */

describe('the first sync of a repository', () => {
  it('turns a repository never seen before into one Evidence row', async () => {
    network({ repos: { body: [repo(1)] } });

    const { sync, store } = await build();

    const result = await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    expect(result.status).toBe('SUCCEEDED');
    expect(result.counts.created).toBe(1);
    expect(store.rows.evidence).toHaveLength(1);

    const row = evidenceFor(store, 1);

    expect(row.userId).toBe(USER);
    expect(row.sourceType).toBe('GITHUB');
    /*
     * Keyed on the immutable numeric id, never the name: a rename must
     * land on this same row rather than duplicating it.
     */
    expect(row.externalId).toBe(
      'github:repo:1',
    );
    expect(row.title).toBe(`${LOGIN}/repo-1`);
  });

  it('counts only what GitHub attributes to the connected account', async () => {
    network({
      repos: { body: [repo(1)] },
      commits: {
        /*
         * One commit GitHub resolved to us, one it resolved to somebody
         * else. Attribution keys on the numeric account id, so the
         * stranger's must not be counted - otherwise anyone could
         * manufacture evidence of our user's work.
         */
        body: [
          commit('2024-06-02T14:31:09Z'),
          commit(
            '2024-06-03T14:31:09Z',
            STRANGER_ID,
          ),
        ],
      },
      issues: {
        body: [
          issue(1),
          pull(1),
          issue(1, STRANGER_ID),
        ],
      },
    });

    const { sync, store } = await build();

    await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    const activity = metadataOf(
      evidenceFor(store, 1),
    ).activity;

    expect(activity.commitsAttributed).toBe(1);
    expect(activity.issuesAuthored).toBe(1);
    expect(
      activity.pullRequestsAuthored,
    ).toBe(1);
  });

  it('records the completeness of what it actually looked at', async () => {
    network({ repos: { body: [repo(1)] } });

    const { sync, store } = await build();

    await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    const completeness = metadataOf(
      evidenceFor(store, 1),
    ).completeness;

    /*
     * DEFAULT_BRANCH_ONLY is the strongest claim available: only the
     * default branch is observable through these endpoints, so the count
     * is a lower bound and the row must say so.
     */
    expect(completeness.commits).toBe(
      'DEFAULT_BRANCH_ONLY',
    );
    expect(completeness.scannedAt).toBe(
      FIRST_SCAN,
    );
    expect(completeness.reposScanned).toBe(1);
    expect(completeness.reposTotal).toBe(1);
    expect(completeness.truncated).toBe(false);
    expect(
      completeness.listingTruncated,
    ).toBe(false);
  });
});

describe('a second sync over an unchanged repository', () => {
  it('recognises the repository it already holds instead of inserting a second row', async () => {
    network({ repos: { body: [repo(1)] } });

    const { sync, store } = await build();

    await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    const second = await sync.sync(USER, {
      scannedAt: SECOND_SCAN,
    });

    expect(second.counts.created).toBe(0);
    expect(store.rows.evidence).toHaveLength(1);
  });

  it('writes nothing at all, so updatedAt and capturedAt do not churn', async () => {
    network({ repos: { body: [repo(1)] } });

    const { sync, store } = await build();

    await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    const before = evidenceFor(store, 1);

    const updatedAt = before.updatedAt.getTime();
    const capturedAt =
      before.capturedAt.getTime();

    await sync.sync(USER, {
      scannedAt: SECOND_SCAN,
    });

    const after = evidenceFor(store, 1);

    expect(after.updatedAt.getTime()).toBe(
      updatedAt,
    );
    expect(after.capturedAt.getTime()).toBe(
      capturedAt,
    );

    /*
     * The decisive assertion, because two writes inside one millisecond
     * would make the timestamps above agree by accident. The stored
     * metadata still carries the FIRST run's scannedAt, which is only
     * possible if the second run wrote nothing.
     */
    expect(
      metadataOf(after).completeness.scannedAt,
    ).toBe(FIRST_SCAN);
  });

  it('does not call the languages or commits endpoints for an unchanged repository', async () => {
    const net = network({
      repos: { body: [repo(1)] },
    });

    const { sync } = await build();

    await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    /* Only the SECOND sync's requests are under test. */
    net.reset();

    await sync.sync(USER, {
      scannedAt: SECOND_SCAN,
    });

    /*
     * The whole point of 7.6. `pushed_at` is unchanged and the stored
     * completeness is DEFAULT_BRANCH_ONLY, so there is nothing here two
     * more requests could tell us - and those two requests, multiplied
     * by every repository on every run, are the user's shared rate-limit
     * budget being spent to re-learn what we already know.
     */
    expect(
      net.requested.some((url) =>
        url.includes('/languages'),
      ),
    ).toBe(false);

    expect(
      net.requested.some((url) =>
        url.includes('/commits'),
      ),
    ).toBe(false);
  });

  it('still reports SUCCEEDED when every repository was recognised as unchanged', async () => {
    network({
      repos: { body: [repo(1), repo(2)] },
    });

    const { sync } = await build();

    await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    const second = await sync.sync(USER, {
      scannedAt: SECOND_SCAN,
    });

    /*
     * The trap this guards. `reposScanned` counts repositories whose
     * commit completeness is not NOT_SCANNED, and the ledger requires
     * DEFAULT_BRANCH_ONLY on every repository before it will say
     * SUCCEEDED. So a carried-forward repository modelled as a new
     * completeness value - or worse, as NOT_SCANNED - would make every
     * steady-state sync report PARTIAL and, because NOT_SCANNED rows are
     * withheld from Evidence entirely, would look identical to running
     * out of budget. "Nothing changed" is a COMPLETE answer, not a
     * partial one, and the run must say so.
     */
    expect(second.status).toBe('SUCCEEDED');
    expect(second.counts.reposScanned).toBe(2);
    expect(second.counts.reposSkipped).toBe(0);
  });

  it('still asks for authored issues and pull requests, because authoring does not move pushed_at', async () => {
    const net = network({
      repos: { body: [repo(1)] },
      issues: { body: [issue(1)] },
    });

    const { sync } = await build();

    await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    net.reset();

    await sync.sync(USER, {
      scannedAt: SECOND_SCAN,
    });

    /*
     * The counterweight to the test above. Opening an issue or a pull
     * request does NOT move a repository's `pushed_at`, so a sync that
     * used `pushed_at` to skip the cross-repository authored-activity
     * query would silently freeze those counts forever. It is one call
     * for the whole account, so it is cheap to keep making.
     */
    expect(
      net.askedForAuthoredActivity(),
    ).toBe(true);
  });
});

describe('a repository that is new in the second sync', () => {
  it('processes only the new repository and leaves the known one untouched', async () => {
    const net = network({
      repos: { body: [repo(1)] },
    });

    const { sync } = await build();

    await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    net.script({
      repos: { body: [repo(1), repo(3)] },
    });
    net.reset();

    await sync.sync(USER, {
      scannedAt: SECOND_SCAN,
    });

    /* Never seen before, so there is nothing to carry forward. */
    expect(net.touched('repo-3')).toBe(true);

    /* Already known and unmoved, so nothing to ask about. */
    expect(net.touched('repo-1')).toBe(false);
  });

  it('adds the new repository as its own row without disturbing the existing one', async () => {
    const net = network({
      repos: { body: [repo(1)] },
    });

    const { sync, store } = await build();

    await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    const existing = evidenceFor(store, 1);
    const untouchedAt =
      existing.updatedAt.getTime();

    net.script({
      repos: { body: [repo(1), repo(3)] },
    });

    const second = await sync.sync(USER, {
      scannedAt: SECOND_SCAN,
    });

    expect(second.counts.created).toBe(1);
    expect(store.rows.evidence).toHaveLength(2);

    expect(
      evidenceFor(
        store,
        3,
      ).externalId,
    ).toBe('github:repo:3');

    expect(
      evidenceFor(store, 1).updatedAt.getTime(),
    ).toBe(untouchedAt);
  });
});

describe('a repository whose pushed_at advanced', () => {
  it('is rescanned, and its counts move', async () => {
    const net = network({
      repos: { body: [repo(1)] },
      commits: { body: commits(1) },
    });

    const { sync, store } = await build();

    await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    expect(
      metadataOf(evidenceFor(store, 1)).activity
        .commitsAttributed,
    ).toBe(1);

    net.script({
      repos: {
        body: [
          repo(1, { pushed_at: PUSHED_LATER }),
        ],
      },
      commits: { body: commits(3) },
    });
    net.reset();

    await sync.sync(USER, {
      scannedAt: SECOND_SCAN,
    });

    expect(net.touched('repo-1')).toBe(true);

    const after = metadataOf(
      evidenceFor(store, 1),
    );

    /*
     * An ABSOLUTE total from a full walk, not 1 + a delta. Deltas are
     * not idempotent under retry, so a re-run of a sync that already
     * persisted would double-count.
     */
    expect(
      after.activity.commitsAttributed,
    ).toBe(3);

    /* And the row now dates to the new push. */
    expect(after.repository.pushedAt).toBe(
      new Date(PUSHED_LATER).toISOString(),
    );
  });

  it('is rescanned without dragging its unchanged sibling along', async () => {
    const net = network({
      repos: { body: [repo(1), repo(2)] },
    });

    const { sync } = await build();

    await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    net.script({
      repos: {
        body: [
          repo(1, { pushed_at: PUSHED_LATER }),
          repo(2),
        ],
      },
    });
    net.reset();

    await sync.sync(USER, {
      scannedAt: SECOND_SCAN,
    });

    expect(net.touched('repo-1')).toBe(true);
    expect(net.touched('repo-2')).toBe(false);
  });

  it('rescans a repository whose stored record says it was never actually observed', async () => {
    const net = network({
      repos: { body: [repo(1)] },
    });

    const { sync, store } = await build();

    /* Sync 1: a real observation. */
    await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    /*
     * Sync 2: access is lost, so the row is marked ACCESS_LOST.
     *
     * pushed_at is advanced here on purpose. Without it the repository
     * would be REVALIDATED - unmoved push, so neither endpoint is called
     * - and the 404 would never be issued, so the loss would go
     * undiscovered. That is correct behaviour rather than a gap: a run
     * that made no request learned nothing, and the stored observation is
     * carried with revalidatedBy set rather than being restated as fresh.
     * This test is about sync 3, so the setup has to make sync 2 actually
     * look.
     */
    net.script({
      repos: {
        body: [
          repo(1, {
            pushed_at: '2026-02-01T00:00:00Z',
          }),
        ],
      },
      languages: { status: 404, body: {} },
    });

    await sync.sync(USER, {
      scannedAt: SECOND_SCAN,
    });

    expect(
      metadataOf(evidenceFor(store, 1))
        .completeness.commits,
    ).toBe('ACCESS_LOST');

    /* Sync 3: access is back, and `pushed_at` never moved. */
    net.script({ repos: { body: [repo(1)] } });
    net.reset();

    await sync.sync(USER, {
      scannedAt: THIRD_SCAN,
    });

    /*
     * The completeness half of the skip rule, which an implementation
     * keyed only on `pushed_at` would get wrong. An unmoved `pushed_at`
     * over a record that was never actually scanned is not "nothing
     * changed" - it is "we still have not looked", and skipping it would
     * strand the repository as permanently stale.
     */
    expect(net.touched('repo-1')).toBe(true);

    expect(
      metadataOf(evidenceFor(store, 1))
        .completeness.commits,
    ).toBe('DEFAULT_BRANCH_ONLY');
  });
});

describe('a repository that disappears from the listing', () => {
  it('keeps its historical Evidence, unchanged and undeleted', async () => {
    const net = network({
      repos: { body: [repo(1), repo(2)] },
    });

    const { sync, store } = await build();

    await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    const goneBefore = JSON.stringify(
      evidenceFor(store, 2),
    );

    net.script({ repos: { body: [repo(1)] } });

    await sync.sync(USER, {
      scannedAt: SECOND_SCAN,
    });

    /*
     * Absence from a sync is not evidence of absence. A token can lose a
     * scope, a listing can truncate, a repository can be transferred to
     * an org we can no longer read - and every one of those looks exactly
     * like a deletion from where this code stands. Deleting on that
     * signal would destroy a user's record because of our own rate limit.
     */
    expect(store.rows.evidence).toHaveLength(2);
    expect(
      JSON.stringify(evidenceFor(store, 2)),
    ).toBe(goneBefore);
  });
});

describe('a 304 Not Modified', () => {
  it('on the repository listing leaves every existing row untouched and is not SUCCEEDED', async () => {
    const net = network({
      repos: { body: [repo(1)] },
    });

    const { sync, store } = await build();

    await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    const before = persistedShape(store);

    /*
     * The REST client turns a 304 into `{status: 'not_modified'}`, and
     * getAll BREAKS out of its walk on it - so the listing comes back
     * with zero items and `truncated: true`, because the next link was
     * never cleared. Zero repositories must therefore not read as "this
     * account has no repositories".
     */
    net.script({ repos: { status: 304 } });

    const second = await sync.sync(USER, {
      scannedAt: SECOND_SCAN,
    });

    expect(second.status).not.toBe('SUCCEEDED');
    expect(persistedShape(store)).toEqual(
      before,
    );
  });

  it('on the languages endpoint must not erase the languages already stored', async () => {
    const net = network({
      repos: { body: [repo(1)] },
      languages: {
        body: { TypeScript: 1000, CSS: 20 },
      },
    });

    const { sync, store } = await build();

    await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    expect(
      metadataOf(
        evidenceFor(store, 1),
      ).languages.map((language) => language.name),
    ).toEqual(['TypeScript', 'CSS']);

    /*
     * `pushed_at` advances, so this repository IS rescanned under both
     * the old and the new behaviour - which is what makes this a test of
     * the 304 handling rather than of the skip rule.
     *
     * A 304 means "unchanged since the ETag you sent". It is the
     * strongest possible statement that the stored value is still
     * correct, so treating it as an empty languages map - which is what
     * an unconditional `status === 'ok' ? … : []` does - inverts its
     * meaning and blanks a true observation.
     */
    net.script({
      repos: {
        body: [
          repo(1, { pushed_at: PUSHED_LATER }),
        ],
      },
      languages: { status: 304 },
    });

    await sync.sync(USER, {
      scannedAt: SECOND_SCAN,
    });

    expect(
      metadataOf(
        evidenceFor(store, 1),
      ).languages.map((language) => language.name),
    ).toEqual(['TypeScript', 'CSS']);
  });
});

describe('an incomplete second sync must not unlearn the first', () => {
  it('keeps the counts of a rate-limited repository, and is not SUCCEEDED', async () => {
    const net = network({
      repos: { body: [repo(1)] },
      commits: { body: commits(4) },
    });

    const { sync, store } = await build();

    await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    /*
     * 403 with a zero remaining budget is GitHub's primary rate limit.
     * No Retry-After and no reset header, so the client cannot wait it
     * out and correctly gives up rather than hammering an endpoint it has
     * been told to stop calling.
     */
    net.script({
      repos: {
        body: [
          repo(1, { pushed_at: PUSHED_LATER }),
        ],
      },
      commits: {
        status: 403,
        body: {},
        headers: { 'x-ratelimit-remaining': '0' },
      },
    });

    const second = await sync.sync(USER, {
      scannedAt: SECOND_SCAN,
    });

    expect(second.status).not.toBe('SUCCEEDED');

    const activity = metadataOf(
      evidenceFor(store, 1),
    ).activity;

    /*
     * Four commits were true when they were captured and are still the
     * best thing we know. Rendering this as 0 - or as null - would use
     * the user's own data to say they did no work, on the strength of our
     * having been rate limited.
     */
    expect(activity.commitsAttributed).toBe(4);
  });

  it('keeps the counts of a repository skipped for scan budget', async () => {
    const net = network({
      repos: { body: [repo(1), repo(2)] },
      commits: { body: commits(4) },
    });

    const { sync, store } = await build();

    await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    const before = JSON.stringify(
      evidenceFor(store, 2),
    );

    /* Both moved, but only one fits in the budget. */
    net.script({
      repos: {
        body: [
          repo(1, { pushed_at: PUSHED_LATER }),
          repo(2, { pushed_at: PUSHED_LATER }),
        ],
      },
      commits: { body: commits(9) },
    });

    const second = await sync.sync(USER, {
      scannedAt: SECOND_SCAN,
      repositoryScanBudget: 1,
    });

    expect(second.status).toBe('PARTIAL');

    /*
     * Untouched, byte for byte. A repository we ran out of budget for
     * produces no write at all - not a write that says "0".
     */
    expect(
      JSON.stringify(evidenceFor(store, 2)),
    ).toBe(before);

    expect(
      metadataOf(evidenceFor(store, 2)).activity
        .commitsAttributed,
    ).toBe(4);
  });

  it('keeps the counts and languages of a repository whose access was lost', async () => {
    const net = network({
      repos: { body: [repo(1)] },
      commits: { body: commits(4) },
      languages: { body: { Rust: 500 } },
    });

    const { sync, store } = await build();

    await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    /*
     * GitHub answers 404 rather than 403 for something a token can no
     * longer see, deliberately, so the API does not confirm whether a
     * private resource exists. Either way it means "no longer readable",
     * which is a finding about the SYNC and not about the repository.
     */
    net.script({
      repos: {
        body: [
          repo(1, { pushed_at: PUSHED_LATER }),
        ],
      },
      languages: { status: 404, body: {} },
    });

    const second = await sync.sync(USER, {
      scannedAt: SECOND_SCAN,
    });

    expect(second.status).not.toBe('SUCCEEDED');

    const metadata = metadataOf(
      evidenceFor(store, 1),
    );

    expect(metadata.completeness.commits).toBe(
      'ACCESS_LOST',
    );

    expect(
      metadata.activity.commitsAttributed,
    ).toBe(4);

    expect(
      metadata.languages.map(
        (language) => language.name,
      ),
    ).toEqual(['Rust']);

    /*
     * And the row says how old the surviving numbers are, rather than
     * letting this run's clock pass for when they were gathered.
     */
    expect(
      metadata.completeness.previouslyObservedAt,
    ).toBe(FIRST_SCAN);
  });

  it('does not blank authored counts when the authored-activity query fails', async () => {
    const net = network({
      repos: { body: [repo(1)] },
      issues: { body: [issue(1), pull(1)] },
    });

    const { sync, store } = await build();

    await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    const first = metadataOf(
      evidenceFor(store, 1),
    ).activity;

    expect(first.issuesAuthored).toBe(1);
    expect(first.pullRequestsAuthored).toBe(1);

    /*
     * The one cross-repository call fails. The ingestion layer correctly
     * refuses to invent an empty index - null means "not established",
     * never "none" - but null is only safe if it stops at the projection.
     * Written through onto a row that already holds real counts, it
     * destroys them.
     */
    net.script({
      repos: { body: [repo(1)] },
      issues: { status: 500, body: {} },
    });

    await sync.sync(USER, {
      scannedAt: SECOND_SCAN,
    });

    const after = metadataOf(
      evidenceFor(store, 1),
    ).activity;

    expect(after.issuesAuthored).toBe(1);
    expect(after.pullRequestsAuthored).toBe(1);
  });

  it('does not report SUCCEEDED when the authored-activity query failed', async () => {
    network({
      repos: { body: [repo(1)] },
      issues: { status: 500, body: {} },
    });

    const { sync } = await build();

    const result = await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    /*
     * The run read the repositories but could not read authorship, so
     * two of the three counts on every row are "not established". A
     * status of SUCCEEDED over that tells a caller the picture is
     * complete when a third of it is missing.
     */
    expect(result.status).not.toBe('SUCCEEDED');
  });
});

describe('determinism', () => {
  it('persists identical rows when the same sync is run twice', async () => {
    network({ repos: { body: [repo(1), repo(2)] } });

    const { sync, store } = await build();

    await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    const first = persistedShape(store);

    await sync.sync(USER, {
      scannedAt: SECOND_SCAN,
    });

    /*
     * Including capturedAt and the metadata's scannedAt. A re-sync that
     * observed nothing new is not an edit, and letting it re-stamp every
     * row would make the audit trail useless for spotting a real change.
     */
    expect(persistedShape(store)).toEqual(first);
  });

  it('persists identical rows when the API returns the repositories in a different order', async () => {
    const net = network({
      repos: { body: [repo(1), repo(2)] },
    });

    const ascending = await build();

    await ascending.sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    /*
     * GitHub's paging order is an artifact of the walk, not a fact about
     * the account, so nothing persisted may depend on it.
     */
    net.script({
      repos: { body: [repo(2), repo(1)] },
    });

    const descending = await build();

    await descending.sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    expect(
      persistedShape(descending.store),
    ).toEqual(persistedShape(ascending.store));
  });

  it('persists identical rows, and skips identically, when the database returns prior Evidence in a different order', async () => {
    const net = network({
      repos: { body: [repo(1), repo(2)] },
    });

    const ordered = await build();
    const shuffled = await build();

    await ordered.sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });
    await shuffled.sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    /*
     * Row order out of a findMany with no ORDER BY is whatever the
     * storage engine feels like - it changes with vacuum, with page
     * layout, with a replica. If the prior-state map that decides what to
     * skip is built by iterating those rows, an implementation that keeps
     * the LAST match rather than keying by repoId, or that reads only the
     * first N, would be correct in development and wrong in production
     * for reasons no test could reproduce. So the order is inverted here
     * deliberately.
     */
    shuffled.store.rows.evidence.reverse();

    net.reset();
    await ordered.sync.sync(USER, {
      scannedAt: SECOND_SCAN,
    });
    const orderedRequests = [...net.requested];

    net.reset();
    await shuffled.sync.sync(USER, {
      scannedAt: SECOND_SCAN,
    });
    const shuffledRequests = [...net.requested];

    expect(
      persistedShape(shuffled.store),
    ).toEqual(persistedShape(ordered.store));

    /* The same decisions, in the same order, from the same facts. */
    expect(shuffledRequests).toEqual(
      orderedRequests,
    );

    /* And both recognised both repositories as already known. */
    expect(net.touched('repo-1')).toBe(false);
    expect(net.touched('repo-2')).toBe(false);
  });
});

describe('concurrency', () => {
  it('refuses a second sync while one is live, without touching the live run', async () => {
    network({ repos: { body: [repo(1)] } });

    const { sync, store, prisma } =
      await build();

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
        scannedAt: FIRST_SCAN,
      }),
    ).rejects.toThrow(/already running/i);

    /*
     * A refusal must not close somebody else's run and must not write a
     * FAILED row of its own.
     */
    expect(store.rows.syncRuns).toHaveLength(1);
    expect(
      store.rows.syncRuns[0]!.status,
    ).toBe('RUNNING');
    expect(store.rows.evidence).toHaveLength(0);
  });

  it('reclaims an abandoned RUNNING run rather than blocking forever', async () => {
    network({ repos: { body: [repo(1)] } });

    const { sync, store, prisma } =
      await build();

    /*
     * A process that died mid-sync leaves RUNNING behind with no lease
     * and nothing to clear it. There is a live defect of exactly this
     * shape elsewhere in this codebase - resume imports strand in
     * PROCESSING - and repeating it here would mean one crash disables a
     * user's GitHub sync permanently.
     */
    await prisma.externalSyncRun.create({
      data: {
        connectionId:
          store.rows.connections[0]!.id,
        userId: USER,
        status: 'RUNNING',
        startedAt: new Date(
          Date.now() - 40 * 60 * 1000,
        ),
      },
    });

    const result = await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    expect(result.status).toBe('SUCCEEDED');

    const abandoned = store.rows.syncRuns.find(
      (run) => run.id !== result.runId,
    )!;

    expect(abandoned.status).toBe('FAILED');
    expect(abandoned.finishedAt).not.toBeNull();
  });
});

describe('the credential', () => {
  it('does not escape a real failure that carries the Authorization header', async () => {
    const net = network({
      rejectOn: () => true,
      rejection: credentialBearingRejection(),
    });

    const { sync, store } = await build();

    const failure = await sync
      .sync(USER, { scannedAt: FIRST_SCAN })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(
      GithubSyncFailedError,
    );

    /*
     * The real path was taken: the credential genuinely went out on the
     * wire and the credential-bearing rejection was genuinely reached.
     * Without this the no-leak assertions below could pass against a run
     * that failed before it ever authenticated.
     */
    expect(net.sentAuthorization).toContain(
      AUTHORIZATION,
    );

    expectNoCredentials(
      'thrown error',
      failure,
    );

    expect(
      (failure as GithubSyncFailedError).cause,
    ).toBeUndefined();

    /*
     * The ledger records a reason CODE from a fixed vocabulary, never a
     * caught error's message - a message is arbitrary text from an
     * arbitrary layer, and at an authenticated HTTP boundary the one
     * thing it must never contain is the thing it is most likely to.
     */
    const run = store.rows.syncRuns[0]!;

    expect(run.status).toBe('FAILED');
    expect(run.errorMessage).toMatch(
      /^[a-z0-9_]+(:[a-z0-9_]+)*$/,
    );

    expectNoCredentials('sync run row', run);
  });

  it('does not reach the sync result, the Evidence rows or the ledger on a successful run', async () => {
    const net = network({
      repos: { body: [repo(1), repo(2)] },
    });

    const { sync, store } = await build();

    const result = await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    /* Again: the token really was presented. */
    expect(net.sentAuthorization).toContain(
      AUTHORIZATION,
    );

    expectNoCredentials(
      'sync result',
      result,
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

  it('does not reach the ledger on a second, incremental run either', async () => {
    network({ repos: { body: [repo(1)] } });

    const { sync, store } = await build();

    await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    const second = await sync.sync(USER, {
      scannedAt: SECOND_SCAN,
    });

    /*
     * 7.6 adds a prior-state read and a skip decision between the
     * credential and the ledger. Any new field it puts on the run's stats
     * - "what we compared against", a cached response, a request record -
     * is a new surface, so the same assertion is repeated on this path
     * rather than assumed to be covered by the first-run one.
     */
    expectNoCredentials(
      'incremental sync result',
      second,
    );
    expectNoCredentials(
      'sync run rows',
      store.rows.syncRuns,
    );
  });
});

describe('the connection record', () => {
  it('stamps lastSyncedAt when a run finishes SUCCEEDED', async () => {
    network({ repos: { body: [repo(1)] } });

    const { sync, store } = await build();

    expect(
      store.rows.connections[0]!.lastSyncedAt,
    ).toBeNull();

    const result = await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    expect(result.status).toBe('SUCCEEDED');

    /*
     * The connection is what the UI reads to say "last synced". Without
     * this it stays null forever and every sync looks like the first one.
     */
    expect(
      store.rows.connections[0]!.lastSyncedAt,
    ).not.toBeNull();
  });

  it('stamps lastSyncedAt when a run finishes PARTIAL', async () => {
    network({
      repos: { body: [repo(1), repo(2)] },
    });

    const { sync, store } = await build();

    const result = await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
      repositoryScanBudget: 1,
    });

    expect(result.status).toBe('PARTIAL');

    /*
     * PARTIAL is not a failure: the run did read what it read, and the
     * repositories it reached are genuinely up to date. Withholding the
     * stamp would make an account that is permanently past the scan
     * budget - the normal case for a large account - report as never
     * having synced.
     */
    expect(
      store.rows.connections[0]!.lastSyncedAt,
    ).not.toBeNull();
  });

  it('leaves lastSyncedAt alone when the run FAILS', async () => {
    network({
      repos: { status: 500, body: {} },
    });

    const { sync, store } = await build();

    await sync
      .sync(USER, { scannedAt: FIRST_SCAN })
      .catch(() => undefined);

    expect(
      store.rows.syncRuns[0]!.status,
    ).toBe('FAILED');

    /*
     * Nothing was established, so nothing may claim otherwise. A stamp
     * here would make a run of consecutive failures indistinguishable
     * from a healthy connection.
     */
    expect(
      store.rows.connections[0]!.lastSyncedAt,
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

/*
 * Two contract violations found by the Phase 7.8 acceptance audit. Both
 * were single-line defects against otherwise correct architecture, and
 * both contradicted a claim the project had already written down - which
 * is the worst kind, because the document stops being a description and
 * starts being a promise nobody is checking.
 */
describe('7.8 audit regressions', () => {
  /*
   * The authored-activity walk is capped at ten pages of a hundred. An
   * account past ~1,000 authored issues and pull requests got a PARTIAL
   * index, and every repository missing from it was written with a hard
   * 0 - because a repository absent from a WORKING index genuinely has
   * none. The request succeeded, so nothing looked wrong.
   *
   * That is the completeness contract's first rule inverted, on the
   * user's own data: "we did not look" rendered as "this person did
   * nothing".
   */
  it('does not turn a truncated authored listing into zero counts', async () => {
    const net = network({
      repos: { body: [repo(1)] },
      issues: { body: [issue(1), pull(1)] },
    });

    const { sync, store } = await build();

    await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
    });

    expect(
      metadataOf(evidenceFor(store, 1)).activity
        .issuesAuthored,
    ).toBe(1);

    /*
     * The second run's listing is truncated: a full page plus a next
     * link, repeated past the page ceiling. repo-1 is absent from what
     * came back.
     */
    net.script({
      repos: { body: [repo(1)] },
      issues: {
        body: Array.from(
          { length: 100 },
          (_, i) => issue(9000 + i),
        ),
        headers: {
          link: '<https://api.github.com/issues?page=2>; rel="next"',
        },
      },
    });

    const result = await sync.sync(USER, {
      scannedAt: SECOND_SCAN,
    });

    const activity = metadataOf(
      evidenceFor(store, 1),
    ).activity;

    /* Not zero. The prior count survives. */
    expect(activity.issuesAuthored).toBe(1);
    expect(activity.issuesAuthored).not.toBe(0);
    expect(
      activity.pullRequestsAuthored,
    ).not.toBe(0);

    /* And the run does not claim to have seen everything. */
    expect(result.status).not.toBe('SUCCEEDED');
  });

  /*
   * The scan budget must count repositories READ, not repositories
   * considered.
   *
   * Revalidated repositories issue no request, but they used to spend
   * budget anyway - so an account larger than the budget revalidated the
   * same first N for free on every run, exhausted the budget on them, and
   * left the remainder NOT_SCANNED forever. The decision record claimed
   * the opposite as incremental sync's strongest justification.
   */
  it('lets coverage advance past the budget across successive syncs', async () => {
    const all = [repo(1), repo(2), repo(3)];

    const net = network({ repos: { body: all } });

    const { sync, store } = await build();

    /* Run 1: budget of two, so repo-3 is never looked at. */
    await sync.sync(USER, {
      scannedAt: FIRST_SCAN,
      repositoryScanBudget: 2,
    });

    expect(store.rows.evidence).toHaveLength(2);

    /*
     * Run 2, same budget and nothing pushed. repo-1 and repo-2 revalidate
     * without a request, so the budget is free for repo-3.
     */
    net.script({ repos: { body: all } });

    await sync.sync(USER, {
      scannedAt: SECOND_SCAN,
      repositoryScanBudget: 2,
    });

    expect(store.rows.evidence).toHaveLength(3);

    const third = metadataOf(
      evidenceFor(store, 3),
    );

    expect(third.completeness.commits).toBe(
      'DEFAULT_BRANCH_ONLY',
    );

    /* It was genuinely read, not carried. */
    expect(
      third.completeness.revalidatedBy,
    ).toBeNull();
  });
});
