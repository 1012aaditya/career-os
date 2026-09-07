import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service.js';
import { createInMemoryPrisma } from '../../test-doubles.js';
import { ExternalSyncRunService } from '../external-sync-run.service.js';
import { GithubIngestionService } from '../github-ingestion.service.js';
import { GithubRestClient } from '../github-rest.client.js';
import { canonicalJson } from '../observations/canonical-json.js';
import type { SyncObservation } from '../observations/types.js';

import { projectSyncEvidence } from './evidence-projection.js';
import { GithubEvidenceRepository } from './github-evidence.repository.js';

/*
 * An independent determinism review of the Phase 7.4 chain.
 *
 * The specs beside this one each test one layer against fixtures that
 * layer's author wrote, which is the right way to test a layer and the
 * wrong way to find out whether the layers compose. Everything here
 * therefore runs the WHOLE path - scripted GitHub payloads, the real REST
 * client, the real ingestion service, the real projection, the real
 * repository, the in-memory Prisma double that enforces the unique index -
 * and asserts on the PERSISTED ROW rather than on any intermediate value.
 *
 * Three classes of failure motivate it:
 *
 *   - A determinism guarantee that each layer holds and the composition
 *     does not. Every layer sorts; the question is whether a byte reaches
 *     the database that a reordered payload would have changed.
 *   - A claim that no single layer makes but the assembled row implies.
 *     The projection's own honesty tests read `title` and `description`;
 *     nothing reads the metadata blob those tests never see.
 *   - A partial run that survives the trip and arrives looking complete.
 *
 * Deliberately not re-tested here, because the neighbouring specs already
 * prove them against the same real implementations: language ordering and
 * key-order independence (normalize.spec), commit and issue attribution by
 * numeric id (attribution.spec), externalId stability across a rename and
 * the P2002 recovery path (github-evidence.repository.spec), SUCCEEDED vs
 * PARTIAL derivation (external-sync-run.service.spec), and metadata
 * determinism at the projection boundary (evidence-projection.spec).
 */

/*
 * Assembled from parts so this file does not itself contain a string
 * matching GitHub's token pattern. It is not a credential, but secret
 * scanning cannot know that, and on a public repository GitHub revokes
 * what it finds.
 */
const TOKEN_PREFIX = 'gho';

const TOKEN =
  `${TOKEN_PREFIX}_16C7e42F292c6912E7710c838347Ae178B4a`;

const ACCOUNT = {
  accountId: '583231',
  login: 'octocat',
};

const SCANNED_AT = '2026-09-07T12:00:00.000Z';

/* A second run, a day later. Only the clock moved. */
const LATER_SCANNED_AT =
  '2026-09-08T12:00:00.000Z';

const USER_A = '11111111-1111-4111-8111-111111111111';

const CONNECTION =
  '33333333-3333-4333-8333-333333333333';

/*
 * Words that assert something GitHub cannot support.
 *
 * A superset of the list evidence-projection.spec applies to the
 * description: this one also covers the vocabulary that tends to arrive
 * later, when someone makes the prose "warmer" - contributed, maintained,
 * managed, experienced - and it is applied to every string in the
 * persisted row rather than to the description alone.
 *
 * Bare "master" is deliberately absent: it is a default branch name, so
 * including it would make this fail on a real repository for a reason that
 * has nothing to do with a claim.
 */
const FORBIDDEN =
  /\b(expert|experts|expertise|expertly|senior|seniority|junior|principal|employed|employee|employer|employment|hired|proficient|proficiency|skilled|mastery|mastered|specialist|owner|owns|owned|ownership|led|leads|leader|leadership|managed|manager|managing|architect|architected|spearheaded|responsible|contributor|contributors|contributed|maintainer|maintained|experienced|veteran|guru|talented|advanced)\b/i;

type Route = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

type World = {
  repos: unknown[];
  issues?: unknown[];
  languages?: (name: string) => Route;
  commits?: (name: string) => Route;
};

function repoPayload(
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
    },
    private: false,
    visibility: 'public',
    fork: false,
    archived: false,
    disabled: false,
    default_branch: 'main',
    description: 'Settlement plumbing',
    size: 100,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    pushed_at: '2026-02-03T04:05:06Z',
    ...overrides,
  };
}

function commitPayload(
  authorId: number | null,
  date: string,
) {
  return {
    sha: `sha-${authorId}-${date}`,
    commit: {
      author: {
        name: 'Someone',
        email: 'someone@example.com',
        date,
      },
    },
    author:
      authorId === null
        ? null
        : { id: authorId, login: 'octocat' },
  };
}

function issuePayload(
  repoId: number,
  isPullRequest: boolean,
  suffix: string,
) {
  return {
    id: Number(`${repoId}${suffix}`),
    user: { id: 583231, login: 'octocat' },
    repository: { id: repoId },
    ...(isPullRequest
      ? { pull_request: { url: 'x' } }
      : {}),
  };
}

/*
 * Scripts the network and returns the real ingestion service on top of the
 * real REST client, so pagination, attribution and the failure policy all
 * execute rather than being stubbed into agreement.
 */
function ingestion(world: World) {
  vi.spyOn(
    globalThis,
    'fetch',
  ).mockImplementation(async (input) => {
    const url = String(input);

    const repoName =
      url.match(/\/repos\/[^/]+\/([^/?]+)/)?.[1] ??
      '';

    let route: Route;

    if (url.includes('/issues?')) {
      route = { body: world.issues ?? [] };
    } else if (url.includes('/languages')) {
      route = world.languages?.(repoName) ?? {
        body: {},
      };
    } else if (url.includes('/commits')) {
      route = world.commits?.(repoName) ?? {
        body: [],
      };
    } else {
      route = { body: world.repos };
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

  return new GithubIngestionService(
    new GithubRestClient(async () => {}),
  );
}

async function sync(
  world: World,
  options: {
    scannedAt?: string;
    budget?: number;
  } = {},
): Promise<SyncObservation> {
  try {
    return await ingestion(world).ingest({
      accessToken: TOKEN,
      account: ACCOUNT,
      scannedAt: options.scannedAt ?? SCANNED_AT,
      scannedSince: null,
      repositoryScanBudget: options.budget,
    });
  } finally {
    vi.restoreAllMocks();
  }
}

function store() {
  const memory = createInMemoryPrisma();

  return {
    rows: memory.rows,
    /** Direct writes, for seeding evidence 7.4 did not create. */
    seed: (row: Record<string, unknown>) =>
      memory.prisma.evidence.create({ data: row }),
    evidence: new GithubEvidenceRepository(
      memory.prisma as unknown as PrismaService,
    ),
    runs: new ExternalSyncRunService(
      memory.prisma as unknown as PrismaService,
    ),
  };
}

type Persisted = ReturnType<
  typeof store
>['rows']['evidence'][number];

/** The persisted row minus the values that are allowed to differ. */
function comparable(row: Persisted) {
  return {
    userId: row.userId,
    resumeImportId: row.resumeImportId,
    sourceType: row.sourceType,
    externalId: row.externalId,
    title: row.title,
    description: row.description,
    sourceUrl: row.sourceUrl,
    occurredAt: row.occurredAt?.toISOString() ?? null,
    capturedAt: row.capturedAt.toISOString(),
    metadata: row.metadata,
  };
}

/** Every row a run wrote, in a comparison-stable order. */
function githubRows(rows: {
  evidence: Persisted[];
}) {
  return rows.evidence
    .filter((row) => row.sourceType === 'GITHUB')
    .slice()
    .sort((a, b) =>
      (a.externalId ?? '') < (b.externalId ?? '')
        ? -1
        : 1,
    );
}

/** Collects every string VALUE, ignoring keys - keys are structure. */
function stringValues(
  value: unknown,
  found: string[] = [],
): string[] {
  if (typeof value === 'string') {
    found.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) {
      stringValues(entry, found);
    }
  } else if (
    typeof value === 'object' &&
    value !== null
  ) {
    for (const entry of Object.values(
      value as Record<string, unknown>,
    )) {
      stringValues(entry, found);
    }
  }

  return found;
}

/** Every key path in an object, with array indices collapsed to []. */
function keyPaths(
  value: unknown,
  prefix = '',
  found: string[] = [],
): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) {
      keyPaths(entry, `${prefix}[]`, found);
    }

    return found;
  }

  if (
    typeof value === 'object' &&
    value !== null
  ) {
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const path = prefix
        ? `${prefix}.${key}`
        : key;

      const before = found.length;

      keyPaths(entry, path, found);

      if (found.length === before) {
        found.push(path);
      }
    }

    return found;
  }

  return found;
}

/* ------------------------------------------------------------------ */

describe('determinism across the whole 7.4 chain', () => {
  /*
   * Attributed, unattributable and someone else's, mixed together and out
   * of date order - the shape the commits endpoint actually returns.
   */
  const COMMITS = [
    commitPayload(583231, '2024-06-02T14:31:09Z'),
    commitPayload(999999, '2019-01-01T00:00:00Z'),
    commitPayload(583231, '2026-01-09T08:00:00Z'),
    commitPayload(null, '2020-01-01T00:00:00Z'),
  ];

  const world: World = {
    repos: [
      repoPayload(515187740),
      repoPayload(99, {
        name: 'infra-tools',
        full_name: 'octocat/infra-tools',
        html_url:
          'https://github.com/octocat/infra-tools',
      }),
      repoPayload(1000),
    ],
    issues: [
      issuePayload(515187740, true, '1'),
      issuePayload(515187740, false, '2'),
      issuePayload(99, true, '3'),
    ],
    /*
     * A byte TIE between Go and C++ on purpose. Ties are where an
     * ordering stops being decided by the comparator and starts being
     * decided by whatever order the payload happened to arrive in.
     */
    languages: () => ({
      body: {
        TypeScript: 184320,
        Go: 40960,
        'C++': 40960,
        'Jupyter Notebook': 2048,
      },
    }),
    commits: () => ({ body: COMMITS }),
  };

  async function runInto(
    into: ReturnType<typeof store>,
    world_: World,
    scannedAt = SCANNED_AT,
  ) {
    const observation = await sync(world_, {
      scannedAt,
    });

    await into.evidence.persistMany(
      USER_A,
      projectSyncEvidence(observation),
    );

    return observation;
  }

  it('persists byte-identical rows for two runs over identical payloads', async () => {
    const first = store();
    const second = store();

    await runInto(first, world);
    await runInto(second, world);

    expect(
      githubRows(second.rows).map(comparable),
    ).toEqual(
      githubRows(first.rows).map(comparable),
    );
  });

  /*
   * The property the layer specs each hold locally and nobody checks end
   * to end: GitHub is free to return any of these collections in any
   * order, and none of that order may reach a persisted byte.
   *
   * Reversed here rather than shuffled, because a shuffle that happens to
   * be the identity permutation passes a broken implementation and the
   * failure is not reproducible when it does not.
   */
  it('persists byte-identical rows when every payload array and object is reordered', async () => {
    const forward = store();
    const reversed = store();

    await runInto(forward, world);

    await runInto(reversed, {
      repos: [...world.repos].reverse(),
      issues: [...(world.issues ?? [])].reverse(),
      /* Same entries, opposite key insertion order. */
      languages: () => ({
        body: {
          'Jupyter Notebook': 2048,
          'C++': 40960,
          Go: 40960,
          TypeScript: 184320,
        },
      }),
      commits: () => ({
        body: [...COMMITS].reverse(),
      }),
    });

    expect(
      githubRows(reversed.rows).map(comparable),
    ).toEqual(
      githubRows(forward.rows).map(comparable),
    );

    /*
     * And equal to the order that was DECIDED, not merely to each other:
     * two runs that both leaked payload order in the same way would
     * satisfy the comparison above and nothing else.
     *
     * Bytes descending, then name ascending. Go and C++ tie on bytes on
     * purpose - a tie is exactly where an ordering stops being decided by
     * the comparator and starts being decided by the payload.
     */
    expect(
      (
        githubRows(reversed.rows)[0]!
          .metadata as Record<string, unknown>
      )['languages'],
    ).toEqual([
      { name: 'TypeScript', bytes: 184320 },
      { name: 'C++', bytes: 40960 },
      { name: 'Go', bytes: 40960 },
      { name: 'Jupyter Notebook', bytes: 2048 },
    ]);

    /*
     * Rows were WRITTEN in numeric-id order - 99, 1000, 515187740 - and
     * not in the order GitHub listed them, which here was the reverse.
     * Read from the store unsorted, since sorting is what the assertion
     * is about.
     */
    expect(
      reversed.rows.evidence.map(
        (row) => row.externalId,
      ),
    ).toEqual([
      'github:repo:99',
      'github:repo:1000',
      'github:repo:515187740',
    ]);
  });

  /*
   * Persistence order is not data. A run that writes the same set of
   * repositories in the opposite order must leave the same rows - the
   * only thing an order could plausibly leak into is a row that reads
   * anything about its siblings, and none may.
   */
  it('leaves the same rows whichever order a run persists them in', async () => {
    const forward = store();
    const backward = store();

    const observation = await sync(world);
    const inputs = projectSyncEvidence(observation);

    await forward.evidence.persistMany(
      USER_A,
      inputs,
    );

    await backward.evidence.persistMany(
      USER_A,
      [...inputs].reverse(),
    );

    expect(
      githubRows(backward.rows).map(comparable),
    ).toEqual(
      githubRows(forward.rows).map(comparable),
    );
  });

  /*
   * Nothing in the chain formats a date or a number for humans.
   *
   * toLocaleString would render 1234567 as "1,234,567" under en-US and
   * "1.234.567" under de-DE, and either would be a different persisted
   * byte on a differently-configured host. The assertion is on the
   * absence of a separator rather than on the call site, because a call
   * site can be reintroduced and this cannot be satisfied by accident.
   */
  it('writes numbers without locale grouping', async () => {
    const memory = store();

    await runInto(memory, {
      ...world,
      repos: [repoPayload(515187740)],
      languages: () => ({
        body: { TypeScript: 9876543 },
      }),
      commits: () => ({
        body: Array.from(
          { length: 1234 },
          (_unused, index) =>
            commitPayload(
              583231,
              `2024-06-02T14:31:${String(
                index % 60,
              ).padStart(2, '0')}Z`,
            ),
        ),
      }),
    });

    const row = githubRows(memory.rows)[0]!;
    const serialized = canonicalJson(row.metadata);

    expect(row.description).toContain(
      'at least 1234 commits',
    );
    expect(serialized).toContain(
      '"bytes":9876543',
    );
    /*
     * A digit, a separator, then exactly three digits ending a run:
     * "1,234" (en-US), "1.234" (de-DE), "1\u202f234" (fr-FR, with the
     * narrow no-break space it actually emits). The trailing \b is
     * load-bearing - it is what stops the ".000Z" of every ISO instant in
     * metadata from reading as a thousands group.
     */
    expect(
      [row.title, row.description, serialized]
        .join(' ')
        .match(/\d[,.\u00a0\u202f ]\d{3}\b/),
    ).toBeNull();
  });

  /*
   * The process timezone is host configuration, not data.
   *
   * Every instant in the chain is re-emitted through toISOString, which
   * is UTC by definition - but the guard is cheap and the failure it
   * catches (a `new Date(...)` without a zone, or a toString anywhere in
   * the prose) is silent and produces evidence dated to a different day
   * depending on which machine ran the sync.
   */
  it('writes identical rows under a different process timezone', async () => {
    const original = process.env.TZ;

    const utc = store();
    const kolkata = store();

    try {
      process.env.TZ = 'UTC';
      await runInto(utc, world);

      process.env.TZ = 'Asia/Kolkata';
      await runInto(kolkata, world);
    } finally {
      if (original === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = original;
      }
    }

    expect(
      githubRows(kolkata.rows).map(comparable),
    ).toEqual(githubRows(utc.rows).map(comparable));
  });

  /*
   * A re-sync a day later, over an unchanged account.
   *
   * capturedAt legitimately moves. These four do not: they are statements
   * about the repository, not about the observation, and a row whose
   * title or description churns on the clock cannot be diffed for real
   * change by anything downstream.
   */
  it('moves nothing but the capture instant when only the clock has advanced', async () => {
    const memory = store();

    await runInto(memory, world);

    const before = githubRows(memory.rows).map(
      (row) => ({
        externalId: row.externalId,
        title: row.title,
        description: row.description,
        sourceUrl: row.sourceUrl,
        occurredAt:
          row.occurredAt?.toISOString() ?? null,
      }),
    );

    await runInto(
      memory,
      world,
      LATER_SCANNED_AT,
    );

    const after = githubRows(memory.rows).map(
      (row) => ({
        externalId: row.externalId,
        title: row.title,
        description: row.description,
        sourceUrl: row.sourceUrl,
        occurredAt:
          row.occurredAt?.toISOString() ?? null,
      }),
    );

    expect(after).toEqual(before);
    expect(githubRows(memory.rows)).toHaveLength(
      world.repos.length,
    );
  });

  /*
   * The same no-churn property on the path it actually runs on most.
   *
   * For any account past the scan budget - which the repository's own
   * comment calls the normal case rather than the edge one - the majority
   * of rows are written through mergeNonObserving on every sync. Two
   * consecutive budget-exhausted runs observe exactly the same nothing,
   * and the merged result is identical apart from the run-varying fields
   * the comparison already excludes, so the second must write nothing.
   *
   * capturedAt is the witness again: it moves only as part of a real
   * write, so it still holding the SECOND run's instant after the third
   * is proof the third decided there was nothing to say.
   *
   * This was a KNOWN FAILURE when the review found it: the unchanged
   * check ran against `next`, the raw shell, while `merged` was computed
   * afterwards and never re-checked - so the path that runs for every
   * repository past the scan budget wrote unconditionally. A seam the
   * merge itself introduced.
   *
   * Fixed by moving the check after the merge. The first assertion inside
   * is a live guard on the setup, so this cannot pass for an unrelated
   * reason.
   */
  it('does not rewrite an unscanned row that a later sync also did not scan', async () => {
    const memory = store();

    /* One real observation, so there is something worth preserving. */
    await runInto(memory, world);

    /* Budget exhausted: everything is NOT_SCANNED from here on. */
    const secondRun = '2026-09-08T12:00:00.000Z';
    const thirdRun = '2026-09-09T12:00:00.000Z';

    await memory.evidence.persistMany(
      USER_A,
      projectSyncEvidence(
        await sync(world, {
          scannedAt: secondRun,
          budget: 0,
        }),
      ),
    );

    expect(
      githubRows(memory.rows).map((row) =>
        row.capturedAt.toISOString(),
      ),
    ).toEqual(world.repos.map(() => secondRun));

    await memory.evidence.persistMany(
      USER_A,
      projectSyncEvidence(
        await sync(world, {
          scannedAt: thirdRun,
          budget: 0,
        }),
      ),
    );

    expect(
      githubRows(memory.rows).map((row) =>
        row.capturedAt.toISOString(),
      ),
    ).toEqual(world.repos.map(() => secondRun));
  });

  /*
   * How stale the surviving numbers are, and whether the row says so.
   *
   * mergeNonObserving keeps the last real observation's activity and
   * languages when a later sync could not look, and stamps
   * previouslyObservedAt so a consumer can tell how old they are - the
   * whole point of the field, per its own doc comment: "when the
   * surviving numbers were really gathered".
   *
   * It is read from the stored row's `scannedAt`, which after one
   * non-observing write is the clock of a run that gathered nothing. So
   * every further non-observing write drags it forward, and a row whose
   * counts are a year old reports them as observed last week.
   *
   * A rename is used to force the third write, because a rename is a fact
   * the LISTING establishes even when the scan never runs - so this is
   * reachable independently of the unconditional-write defect above.
   *
   * This was a KNOWN FAILURE when the review found it: the merge read
   * storedCompleteness.scannedAt unconditionally. Fixed by carrying the
   * stored previouslyObservedAt forward when the stored record is itself
   * non-observing, so the age tracks the last real observation rather
   * than the last write.
   */
  it('does not let the observation age drift forward across unscanned syncs', async () => {
    const memory = store();

    const observedAt = SCANNED_AT;
    const renamed = world.repos.map((raw) => ({
      ...(raw as Record<string, unknown>),
      name: 'renamed',
      full_name: 'octocat/renamed',
    }));

    await runInto(memory, world);

    await memory.evidence.persistMany(
      USER_A,
      projectSyncEvidence(
        await sync(world, {
          scannedAt: '2026-09-08T12:00:00.000Z',
          budget: 0,
        }),
      ),
    );

    await memory.evidence.persistMany(
      USER_A,
      projectSyncEvidence(
        await sync(
          { ...world, repos: renamed },
          {
            scannedAt: '2026-09-09T12:00:00.000Z',
            budget: 0,
          },
        ),
      ),
    );

    const completeness = (
      githubRows(memory.rows)[0]!
        .metadata as Record<
        string,
        Record<string, unknown>
      >
    )['completeness']!;

    /* The rename landed, so a write definitely happened. */
    expect(githubRows(memory.rows)[0]!.title).toBe(
      'octocat/renamed',
    );

    /* And the surviving counts are still the ones gathered on day one. */
    expect(
      completeness['previouslyObservedAt'],
    ).toBe(observedAt);
  });

  /*
   * The guard the whole no-churn design rests on, exercised end to end.
   *
   * isUnchanged deliberately excludes capturedAt so that an unchanged
   * re-sync writes nothing. That mechanism is defeatable one layer up:
   * the projection copies the same capture instant into
   * metadata.completeness.scannedAt, and metadata IS compared - so unless
   * the run-varying fields are excluded from the metadata comparison too,
   * an account where nothing whatsoever happened rewrites every row on
   * every sync and the row's updatedAt stops meaning "something changed".
   *
   * It has to be asserted through the real projection. A hand-written
   * EvidenceInput fixture simply omits the field that makes this false,
   * which is exactly how the defect survived its own layer's test.
   *
   * The witness is capturedAt, not updatedAt. capturedAt is written ONLY
   * as part of a real write, so a stored capturedAt still holding the
   * FIRST run's instant is proof the second run decided there was nothing
   * to say. (updatedAt is unusable here: both runs land inside the same
   * millisecond, so it agrees whether or not a write happened.)
   */
  it(
    'does not rewrite a row when a re-sync observed nothing new',
    async () => {
      const memory = store();

      await runInto(memory, world);

      await runInto(
        memory,
        world,
        LATER_SCANNED_AT,
      );

      expect(
        githubRows(memory.rows).map((row) =>
          row.capturedAt.toISOString(),
        ),
      ).toEqual(
        world.repos.map(() => SCANNED_AT),
      );
    },
  );
});

/* ------------------------------------------------------------------ */

describe('what the persisted row is allowed to say', () => {
  async function persistOne(
    overrides: Record<string, unknown> = {},
    world: Partial<World> = {},
    budget?: number,
  ) {
    const memory = store();

    const observation = await sync({
      repos: [repoPayload(515187740, overrides)],
      languages: () => ({
        body: { TypeScript: 184320, 'C++': 4096 },
      }),
      commits: () => ({
        body: [
          commitPayload(
            583231,
            '2024-06-02T14:31:09Z',
          ),
        ],
      }),
      ...world,
    }, { budget });

    await memory.evidence.persistMany(
      USER_A,
      projectSyncEvidence(observation),
    );

    return githubRows(memory.rows)[0]!;
  }

  /*
   * A field that exists will eventually be filled in.
   *
   * observations/types.ts states that as the reason nothing in the model
   * may express skill, seniority or employment - but nothing enforces it
   * on the metadata blob, which is where a `seniorityHint` or a
   * `primarySkill` would arrive without touching a single existing
   * assertion. Pinning the exact key inventory means adding one is a
   * decision somebody has to make on purpose.
   */
  it('holds exactly the metadata keys it is supposed to, and no others', async () => {
    const row = await persistOne();

    expect(
      [
        ...new Set(keyPaths(row.metadata)),
      ].sort(),
    ).toEqual([
      'account.accountId',
      'account.login',
      'activity.commitsAttributed',
      'activity.firstActivityAt',
      'activity.issuesAuthored',
      'activity.lastActivityAt',
      'activity.pullRequestsAuthored',
      'completeness.commits',
      'completeness.listingTruncated',
      'completeness.reposScanned',
      'completeness.reposTotal',
      'completeness.revalidatedBy',
      'completeness.scannedAt',
      'completeness.scannedSince',
      'completeness.truncated',
      'languages[].bytes',
      'languages[].name',
      'provider',
      'repository.createdAt',
      'repository.defaultBranch',
      'repository.description',
      'repository.fullName',
      'repository.htmlUrl',
      'repository.isArchived',
      'repository.isDisabled',
      'repository.isFork',
      'repository.name',
      'repository.nodeId',
      'repository.owner.id',
      'repository.owner.login',
      'repository.owner.type',
      'repository.isPublic',
      'repository.pushedAt',
      'repository.repoId',
      'repository.sizeKb',
      'repository.updatedAt',
    ].sort());
  });

  /*
   * The projection's own honesty tests read `title` and `description`.
   * The metadata blob is the larger half of the row, it is what a résumé
   * generator or an export will actually read, and nothing looks at it.
   *
   * The GitHub text in this fixture is deliberately neutral, so any hit
   * anywhere in the row is language THIS SYSTEM wrote.
   */
  it('puts no claim vocabulary anywhere in the persisted row, in any completeness branch', async () => {
    const rows = [
      await persistOne(),

      /*
       * An observed zero: an empty repository really has no commits, and
       * no languages. The row that is most tempting to phrase as a
       * judgement, because there is nothing else to say about it.
       */
      await persistOne(
        {},
        {
          commits: () => ({ status: 409 }),
          languages: () => ({ body: {} }),
        },
      ),

      /* Never looked at: absence of a count, not a count of none. */
      await persistOne({}, {}, 0),

      /* Fork, archived, disabled, and not public. */
      await persistOne({
        private: true,
        visibility: 'private',
        fork: true,
        archived: true,
        disabled: true,
      }),

      /* Access lost between the listing and the scan. */
      await persistOne(
        {},
        { languages: () => ({ status: 404 }) },
      ),
    ];

    for (const row of rows) {
      const values = stringValues({
        title: row.title,
        description: row.description,
        sourceUrl: row.sourceUrl,
        metadata: row.metadata,
      });

      /*
       * A scan that found nothing to scan would pass this silently, so
       * the count is asserted first. The row carries a title, a
       * description, a URL and a dozen metadata strings.
       */
      expect(
        values.length,
      ).toBeGreaterThanOrEqual(12);

      for (const value of values) {
        expect(value).not.toMatch(FORBIDDEN);
      }
    }
  });

  /*
   * GitHub's own text is the adversarial case, and it is not hypothetical:
   * repository names and blurbs are marketing copy far more often than
   * they are descriptions.
   *
   * The rule this pins down is quarantine, not sanitisation. A repository
   * called "senior-expert-ownership" must keep that name - renaming it
   * would misidentify the repository - but the blurb must never be lifted
   * into a sentence of ours, and no claim word may appear in the row
   * except as a verbatim echo of a GitHub field.
   */
  it('quarantines GitHub-authored claim language instead of restating it', async () => {
    const blurb =
      'Led by the platform team. Expert-level ownership of settlement, maintained by senior staff.';

    const row = await persistOne({
      name: 'senior-expert-ownership',
      full_name: 'octocat/senior-expert-ownership',
      html_url:
        'https://github.com/octocat/senior-expert-ownership',
      description: blurb,
    });

    /* The blurb is preserved, labelled as GitHub's. */
    expect(
      (
        (row.metadata as Record<string, unknown>)[
          'repository'
        ] as Record<string, unknown>
      )['description'],
    ).toBe(blurb);

    /* And appears in no sentence this system wrote. */
    expect(row.description).not.toContain(blurb);
    expect(row.description).not.toContain(
      'platform team',
    );

    /*
     * Every verbatim GitHub value, removed. What is left is our prose,
     * and our prose may contain none of these words.
     */
    const passthrough = [
      'octocat/senior-expert-ownership',
      'senior-expert-ownership',
      blurb,
    ];

    for (const value of stringValues({
      title: row.title,
      description: row.description,
      sourceUrl: row.sourceUrl,
      metadata: row.metadata,
    })) {
      const ours = passthrough.reduce(
        (text, echo) =>
          text.split(echo).join(' '),
        value,
      );

      expect(ours).not.toMatch(FORBIDDEN);
    }
  });
});

/* ------------------------------------------------------------------ */

describe('a partial run cannot arrive looking complete', () => {
  const three: World = {
    repos: [
      repoPayload(1),
      repoPayload(2),
      repoPayload(3),
    ],
    languages: () => ({
      body: { TypeScript: 100 },
    }),
    commits: () => ({
      body: [
        commitPayload(
          583231,
          '2024-06-02T14:31:09Z',
        ),
      ],
    }),
  };

  function metadataOf(row: Persisted) {
    const metadata = row.metadata as Record<
      string,
      Record<string, unknown>
    >;

    return {
      activity: metadata['activity']!,
      completeness: metadata['completeness']!,
    };
  }

  async function ledger(
    observation: SyncObservation,
  ) {
    const memory = store();

    const run = await memory.runs.start({
      connectionId: CONNECTION,
      userId: USER_A,
    });

    const finished = await memory.runs.finish(
      run.id,
      observation,
    );

    await memory.evidence.persistMany(
      USER_A,
      projectSyncEvidence(observation),
    );

    return { memory, finished };
  }

  /*
   * The row for a repository nobody looked at is the one that has to be
   * unmistakable. It carries no count - not a zero - it says out loud
   * that the absence is ours and not the user's, and it carries the
   * run-level ratio so a reader cannot take it for a whole picture.
   */
  it('marks every unscanned repository as unscanned, in the row and in the ledger', async () => {
    const observation = await sync(three, {
      budget: 1,
    });

    const { memory, finished } = await ledger(
      observation,
    );

    expect(finished.status).toBe('PARTIAL');

    const rows = githubRows(memory.rows);

    expect(rows).toHaveLength(3);

    const unscanned = rows.filter(
      (row) =>
        metadataOf(row).completeness['commits'] ===
        'NOT_SCANNED',
    );

    expect(unscanned).toHaveLength(2);

    for (const row of unscanned) {
      /* Never a zero. Absence of a count, not a count of none. */
      expect(
        Object.values(metadataOf(row).activity),
      ).toEqual([
        null,
        null,
        null,
        null,
        null,
      ]);

      expect(row.description).toContain(
        'That is not the same as no activity.',
      );

      /* Every row carries the ratio, including the scanned one. */
      expect(
        metadataOf(row).completeness[
          'reposScanned'
        ],
      ).toBe(1);
      expect(
        metadataOf(row).completeness['reposTotal'],
      ).toBe(3);
    }
  });

  /*
   * A repository the normalizer refuses - no numeric id, so no stable
   * identity - is dropped silently and correctly. The question is whether
   * the run then reports itself as having seen everything.
   *
   * It must not: reposTotal is taken from the LISTING, so a dropped entry
   * leaves scanned short of total and the run is PARTIAL. Without that,
   * a payload change at GitHub's end would quietly shrink a user's
   * evidence under a green run.
   */
  it('reports PARTIAL when a listed repository could not be normalized', async () => {
    const observation = await sync({
      ...three,
      repos: [
        repoPayload(1),
        /* No id: no identity, so no row can be written for it. */
        repoPayload(2, { id: undefined }),
        repoPayload(3),
      ],
    });

    const { memory, finished } = await ledger(
      observation,
    );

    expect(finished.status).toBe('PARTIAL');
    expect(githubRows(memory.rows)).toHaveLength(
      2,
    );

    expect(
      metadataOf(
        githubRows(memory.rows)[0]!,
      ).completeness['reposTotal'],
    ).toBe(3);
  });

  /*
   * A run in which every repository became unreadable mid-scan.
   *
   * Whatever status such a run is given, the per-repository record has to
   * say that nothing was read - that record is the only thing standing
   * between "we could not look" and "there was nothing to see".
   */
  it('records why nothing was read when access is lost everywhere', async () => {
    const observation = await sync({
      ...three,
      languages: () => ({ status: 404 }),
    });

    const { memory, finished } = await ledger(
      observation,
    );

    const stats = memory.rows.syncRuns[0]!
      .stats as {
      repositories: Array<{ commits: string }>;
    };

    expect(
      stats.repositories.map(
        (entry) => entry.commits,
      ),
    ).toEqual([
      'ACCESS_LOST',
      'ACCESS_LOST',
      'ACCESS_LOST',
    ]);

    for (const row of githubRows(memory.rows)) {
      expect(
        Object.values(metadataOf(row).activity),
      ).toEqual([
        null,
        null,
        null,
        null,
        null,
      ]);

      expect(row.description).toContain(
        'as last captured',
      );
    }

    /*
     * And the run does not close green.
     *
     * buildSyncObservation counts ACCESS_LOST as "scanned" - defensibly,
     * since the repository was listed and then attempted - so
     * isCompleteScan alone reports this run as complete. finish() does not
     * rely on it: it recomputes from the per-repository records and only
     * DEFAULT_BRANCH_ONLY counts as observed, which is what stops a run
     * that read nothing at all from being reported as a run that read
     * everything.
     */
    expect(finished.status).toBe('PARTIAL');
  });
});

/* ------------------------------------------------------------------ */

describe('evidence that 7.4 must not touch', () => {
  /*
   * Confirmed resume evidence is the user's own reviewed record, and a
   * background sync is the last thing that should be able to move it.
   *
   * github-evidence.repository.spec proves one persist leaves one resume
   * row alone. This runs a whole projection and persistMany cycle TWICE
   * over a multi-repository account, including a run where every row is
   * rewritten, and compares the non-GitHub rows byte for byte - updatedAt
   * included, because a touched row is a touched row even when the values
   * happen to land back where they started.
   */
  it('leaves every non-GitHub row byte-identical through a full sync cycle', async () => {
    const memory = store();

    const seeded = [
      {
        userId: USER_A,
        sourceType: 'RESUME',
        title: 'Staff Engineer, Acme',
        description:
          'Led the payments rewrite and owned the settlement domain.',
        externalId: null,
        resumeImportId:
          '44444444-4444-4444-8444-444444444444',
        metadata: { confirmed: true },
      },
      {
        userId: USER_A,
        sourceType: 'RESUME',
        title: 'Second confirmed item',
        externalId: null,
        metadata: null,
      },
      /*
       * The defensive case: a non-GitHub row that happens to carry the
       * exact externalId a GitHub row will claim. The unique index is on
       * (userId, sourceType, externalId), so these must not collide - and
       * a lookup that dropped sourceType would find this row and rewrite
       * somebody's LinkedIn import with a repository.
       */
      {
        userId: USER_A,
        sourceType: 'LINKEDIN',
        title: 'Imported profile item',
        externalId: 'github:repo:515187740',
        metadata: { source: 'linkedin' },
      },
    ];

    for (const row of seeded) {
      await memory.seed(row);
    }

    const untouched = () =>
      memory.rows.evidence
        .filter(
          (row) => row.sourceType !== 'GITHUB',
        )
        .map((row) => ({
          ...comparable(row),
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        }));

    const before = untouched();

    /* Seeded, and carrying exactly the claim language a resume carries. */
    expect(before).toHaveLength(3);
    expect(before[0]!.description).toMatch(
      FORBIDDEN,
    );

    const world: World = {
      repos: [
        repoPayload(515187740),
        repoPayload(99),
      ],
      languages: () => ({
        body: { TypeScript: 10 },
      }),
      commits: () => ({
        body: [
          commitPayload(
            583231,
            '2024-06-02T14:31:09Z',
          ),
        ],
      }),
    };

    await memory.evidence.persistMany(
      USER_A,
      projectSyncEvidence(await sync(world)),
    );

    /* A second cycle where every GitHub row genuinely changes. */
    await memory.evidence.persistMany(
      USER_A,
      projectSyncEvidence(
        await sync(
          {
            ...world,
            languages: () => ({
              body: { TypeScript: 999 },
            }),
          },
          { scannedAt: LATER_SCANNED_AT },
        ),
      ),
    );

    expect(untouched()).toEqual(before);
    expect(githubRows(memory.rows)).toHaveLength(
      2,
    );
  });
});

/* ------------------------------------------------------------------ */

describe('two syncs racing on one repository', () => {
  /*
   * github-evidence.repository.spec proves the P2002 RECOVERY path by
   * injecting a violation. This proves the path that actually runs when
   * two syncs overlap and neither errors: both read "absent", because
   * under READ COMMITTED neither sees the other's uncommitted insert, and
   * both then write through the unique key.
   *
   * The outcome that matters is one row, not the created/updated tally -
   * which the implementation documents as a report rather than a
   * guarantee, and which is genuinely wrong here.
   */
  it('leaves exactly one row when two overlapping persists write the same repository', async () => {
    const memory = store();

    const observation = await sync({
      repos: [repoPayload(515187740)],
      languages: () => ({
        body: { TypeScript: 10 },
      }),
      commits: () => ({
        body: [
          commitPayload(
            583231,
            '2024-06-02T14:31:09Z',
          ),
        ],
      }),
    });

    const [input] =
      projectSyncEvidence(observation);

    await Promise.all([
      memory.evidence.persist(USER_A, input!),
      memory.evidence.persist(USER_A, input!),
    ]);

    const rows = githubRows(memory.rows);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.externalId).toBe(
      'github:repo:515187740',
    );
    expect(rows[0]!.title).toBe(input!.title);
  });
});
