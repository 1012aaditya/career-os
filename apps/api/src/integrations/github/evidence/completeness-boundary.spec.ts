import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service.js';
import { createInMemoryPrisma } from '../../test-doubles.js';
import { ExternalSyncRunService } from '../external-sync-run.service.js';
import { GithubIngestionService } from '../github-ingestion.service.js';
import {
  GithubRequestError,
  type GithubRestClient,
} from '../github-rest.client.js';
import { isCompleteScan } from '../observations/normalize.js';
import type { SyncObservation } from '../observations/types.js';

import { projectSyncEvidence } from './evidence-projection.js';
import { GithubEvidenceRepository } from './github-evidence.repository.js';

/*
 * The completeness contract, tested where it actually has to hold: at the
 * Evidence boundary, across ingestion, projection AND persistence in one
 * run.
 *
 * Each layer already has its own spec, and each of those specs can pass
 * while the contract is broken end to end - a projection that keeps a
 * count null is worthless if the write turns it into 0, and a repository
 * that never deletes is worthless if the row it keeps has been emptied of
 * everything that made it evidence. So nothing here stubs a layer: the
 * real GithubIngestionService walks a fake GitHub, the real projection
 * runs over the observation it produced, and the real repository writes
 * into the in-memory Prisma double that enforces
 * @@unique([userId, sourceType, externalId]) for real.
 *
 * Only the network is faked, and it is faked at the status-code level
 * (404 -> access_lost, 409 -> empty_repository, 429 -> rate_limited) so
 * the failure policy under test is the production one.
 *
 * The four rules being defended (phase-7-0-decisions.md, "Completeness
 * contract"):
 *
 *   1. commit counts are lower bounds, never totals
 *   2. NOT_SCANNED is never equivalent to zero
 *   3. ACCESS_LOST retains and marks stale; it never deletes
 *   4. reposScanned < reposTotal makes the run PARTIAL, never SUCCEEDED
 */

const USER = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';

const ACCOUNT = {
  accountId: '4210',
  login: 'ada',
};

const SCANNED_AT = '2026-09-07T12:00:00.000Z';

/* -------------------------------------------------------------------- */
/* A fake GitHub, described by what each repository does when asked.     */
/* -------------------------------------------------------------------- */

type CommitOutcome =
  | 'ok'
  /** 409: the repository genuinely has no commits. Zero is the truth. */
  | 'empty'
  /** 404/451: readable before, not now. */
  | 'access_lost'
  /** 429: budget gone; everything after this is NOT_SCANNED. */
  | 'rate_limited';

type RepoSpec = {
  id: number;
  name: string;
  languages?: Record<string, number>;
  commits?: CommitOutcome;
  /** How many commits GitHub attributes to ACCOUNT on the default branch. */
  commitCount?: number;
  /** The commit walk hit a page ceiling, so the count is short. */
  commitsTruncated?: boolean;
};

type Scenario = {
  repos: RepoSpec[];
  /** The repository LISTING hit a page ceiling. */
  listingTruncated?: boolean;
  /** 'unavailable' makes the authored-activity query fail outright. */
  authored?: 'unavailable' | unknown[];
  budget?: number;
  scannedAt?: string;
  scannedSince?: string | null;
};

function repoPayload(spec: RepoSpec): unknown {
  return {
    id: spec.id,
    node_id: `R_kgDO${spec.id}`,
    name: spec.name,
    full_name: `ada/${spec.name}`,
    html_url: `https://github.com/ada/${spec.name}`,
    owner: { id: 4210, login: 'ada', type: 'User' },
    private: false,
    visibility: 'public',
    fork: false,
    archived: false,
    disabled: false,
    default_branch: 'main',
    description: 'a repository',
    size: 120,
    created_at: '2024-01-05T00:00:00.000Z',
    updated_at: '2025-02-02T00:00:00.000Z',
    pushed_at: '2025-06-01T00:00:00.000Z',
  };
}

/** A commit GitHub itself resolved to ACCOUNT, which is what counts. */
function commitPayload(index: number): unknown {
  const day = String((index % 27) + 1).padStart(2, '0');

  return {
    author: { id: 4210, login: 'ada' },
    commit: {
      author: { date: `2025-05-${day}T10:00:00.000Z` },
    },
  };
}

function fakeRest(scenario: Scenario): GithubRestClient {
  const byName = new Map(
    scenario.repos.map((spec) => [spec.name, spec]),
  );

  const specFor = (path: string, pattern: RegExp): RepoSpec => {
    const match = pattern.exec(path);
    const spec = match ? byName.get(match[1] ?? '') : undefined;

    if (!spec) {
      throw new Error(`fake GitHub has no route for ${path}`);
    }

    return spec;
  };

  const client = {
    get: async (path: string) => {
      const spec = specFor(
        path,
        /^\/repos\/ada\/([^/]+)\/languages$/,
      );

      return {
        status: 'ok' as const,
        body: spec.languages ?? {},
        etag: null,
        linkNext: null,
      };
    },

    getAll: async (path: string) => {
      if (path.startsWith('/users/')) {
        return {
          items: scenario.repos.map(repoPayload),
          truncated: scenario.listingTruncated === true,
          pagesFetched: 1,
        };
      }

      if (path.startsWith('/issues')) {
        if (scenario.authored === 'unavailable') {
          throw new GithubRequestError(
            'list_authored_activity',
            503,
            'unavailable',
          );
        }

        return {
          items: Array.isArray(scenario.authored)
            ? scenario.authored
            : [],
          truncated: false,
          pagesFetched: 1,
        };
      }

      const spec = specFor(
        path,
        /^\/repos\/ada\/([^/]+)\/commits/,
      );

      if (spec.commits === 'empty') {
        throw new GithubRequestError(
          'repository_commits',
          409,
          'empty_repository',
        );
      }

      if (spec.commits === 'access_lost') {
        throw new GithubRequestError(
          'repository_commits',
          404,
          'access_lost',
        );
      }

      if (spec.commits === 'rate_limited') {
        throw new GithubRequestError(
          'repository_commits',
          429,
          'rate_limited',
        );
      }

      return {
        items: Array.from(
          { length: spec.commitCount ?? 0 },
          (_unused, index) => commitPayload(index),
        ),
        truncated: spec.commitsTruncated === true,
        pagesFetched: 1,
      };
    },
  };

  return client as unknown as GithubRestClient;
}

/* -------------------------------------------------------------------- */
/* The boundary under test: ingest -> project -> persist, one store.     */
/* -------------------------------------------------------------------- */

type PersistedMetadata = {
  provider: string;
  account: { accountId: string; login: string };
  repository: Record<string, unknown>;
  languages: Array<{ name: string; bytes: number }>;
  activity: {
    commitsAttributed: number | null;
    pullRequestsAuthored: number | null;
    issuesAuthored: number | null;
    firstActivityAt: string | null;
    lastActivityAt: string | null;
  };
  completeness: {
    commits: string;
    scannedSince: string | null;
    scannedAt: string;
    truncated: boolean;
    reposScanned: number;
    reposTotal: number;
    listingTruncated: boolean;
  };
};

function harness() {
  const store = createInMemoryPrisma();
  const prisma = store.prisma as unknown as PrismaService;

  const evidence = new GithubEvidenceRepository(prisma);
  const runs = new ExternalSyncRunService(prisma);

  /** One whole sync, all the way to rows in the store. */
  async function sync(scenario: Scenario): Promise<{
    observation: SyncObservation;
    persisted: { created: number; updated: number };
  }> {
    const ingestion = new GithubIngestionService(
      fakeRest(scenario),
    );

    const observation = await ingestion.ingest({
      accessToken: 'gho_test_token',
      account: ACCOUNT,
      scannedAt: scenario.scannedAt ?? SCANNED_AT,
      scannedSince: scenario.scannedSince ?? null,
      repositoryScanBudget: scenario.budget,
    });

    const persisted = await evidence.persistMany(
      USER,
      projectSyncEvidence(observation),
    );

    return { observation, persisted };
  }

  /** The persisted row for a repository, by its immutable numeric id. */
  function row(repoId: number) {
    const found = store.rows.evidence.find(
      (candidate) =>
        candidate.externalId === `github:repo:${repoId}`,
    );

    if (!found) {
      throw new Error(
        `no persisted evidence for repo ${repoId}`,
      );
    }

    return found;
  }

  function metadata(repoId: number): PersistedMetadata {
    return row(repoId).metadata as PersistedMetadata;
  }

  return { store, evidence, runs, sync, row, metadata };
}

describe('completeness at the Evidence boundary', () => {
  describe('first observation', () => {
    it('records a scanned repository as DEFAULT_BRANCH_ONLY', async () => {
      const boundary = harness();

      const { persisted } = await boundary.sync({
        repos: [
          {
            id: 501,
            name: 'core',
            commitCount: 3,
            languages: { TypeScript: 900 },
          },
        ],
      });

      expect(persisted).toEqual({ created: 1, updated: 0 });
      expect(boundary.store.rows.evidence).toHaveLength(1);

      const meta = boundary.metadata(501);

      expect(meta.completeness.commits).toBe(
        'DEFAULT_BRANCH_ONLY',
      );
      expect(meta.activity.commitsAttributed).toBe(3);

      /*
       * Rule 1. The count is a lower bound and the sentence has to say
       * so - a bare total would assert something only a full-history
       * walk could support.
       */
      expect(boundary.row(501).description).toContain(
        'at least 3 commits on the default branch',
      );
    });
  });

  describe('later access loss', () => {
    /*
     * Rule 3. The row must survive. This test asserts survival AND
     * pins down exactly what survives with it, because "retained" is
     * only meaningful if what is retained is still the observation.
     */
    it('retains the existing Evidence row and its identity', async () => {
      const boundary = harness();

      await boundary.sync({
        repos: [
          {
            id: 501,
            name: 'core',
            commitCount: 4,
            languages: { TypeScript: 900, CSS: 40 },
          },
        ],
      });

      const before = { ...boundary.row(501) };
      const metaBefore = boundary.metadata(501);

      expect(metaBefore.activity.commitsAttributed).toBe(4);
      expect(metaBefore.languages).toEqual([
        { name: 'TypeScript', bytes: 900 },
        { name: 'CSS', bytes: 40 },
      ]);

      const second = await boundary.sync({
        repos: [
          {
            id: 501,
            name: 'core',
            commits: 'access_lost',
            languages: { TypeScript: 900, CSS: 40 },
          },
        ],
        scannedAt: '2026-09-14T12:00:00.000Z',
      });

      /* Not deleted, not duplicated, not replaced. */
      expect(boundary.store.rows.evidence).toHaveLength(1);
      expect(second.persisted).toEqual({
        created: 0,
        updated: 1,
      });

      const after = boundary.row(501);

      expect(after.id).toBe(before.id);
      expect(after.externalId).toBe('github:repo:501');
      expect(after.title).toBe('ada/core');
      expect(after.sourceUrl).toBe(
        'https://github.com/ada/core',
      );
      expect(after.occurredAt).toEqual(before.occurredAt);
      expect(after.userId).toBe(USER);

      const metaAfter = boundary.metadata(501);

      expect(metaAfter.completeness.commits).toBe(
        'ACCESS_LOST',
      );
      expect(after.description).toContain(
        'was reachable in an earlier sync and was not reachable during this one',
      );
    });

    /*
     * FINDING, pinned as a characterization test rather than as an
     * approval.
     *
     * The row is retained, so rule 3's "never deletes" holds. But the
     * second run overwrites metadata with a shell: the four commits
     * observed in run one become null and the language composition
     * becomes []. Those were TRUE WHEN CAPTURED - which is the exact
     * thing rule 3 says the ACCESS_LOST marker exists to preserve - and
     * after this run nothing anywhere holds them.
     *
     * The description makes it worse by asserting the opposite:
     * "anything recorded for it is as last captured", said over a
     * record that was just emptied.
     *
     * That WAS this system's behaviour, and this test documented it as a
     * finding during the 7.4 integration review. The cause:
     * github-ingestion.service.ts withCompleteness() sets activity to
     * emptyActivity() and reuses the bare listing shell, whose languages
     * are [] - and the repository wrote that straight over the stored row.
     *
     * The fix lives in the persistence layer, which is the only layer that
     * can see the prior observation: a NOT_SCANNED or ACCESS_LOST run now
     * merges rather than replaces. The assertions below are inverted from
     * what they were, and are the regression guard for it.
     */
    it('retains the previously captured counts and languages', async () => {
      const boundary = harness();

      await boundary.sync({
        repos: [
          {
            id: 501,
            name: 'core',
            commitCount: 4,
            languages: { TypeScript: 900, CSS: 40 },
          },
        ],
      });

      await boundary.sync({
        repos: [
          {
            id: 501,
            name: 'core',
            commits: 'access_lost',
            languages: { TypeScript: 900, CSS: 40 },
          },
        ],
        scannedAt: '2026-09-14T12:00:00.000Z',
      });

      const meta = boundary.metadata(501);

      /* Survives: it was true when it was captured. */
      expect(
        meta.activity.commitsAttributed,
      ).toBe(4);
      expect(
        meta.activity.firstActivityAt,
      ).not.toBeNull();

      expect(meta.languages).toEqual([
        { name: 'TypeScript', bytes: 900 },
        { name: 'CSS', bytes: 40 },
      ]);

      /* The staleness itself is recorded, not hidden. */
      expect(meta.completeness.commits).toBe(
        'ACCESS_LOST',
      );

      /*
       * And the age of the surviving numbers is preserved, so a consumer
       * can say how stale they are instead of reading this run's clock as
       * the moment they were gathered.
       */
      expect(
        meta.completeness.previouslyObservedAt,
      ).toBe('2026-09-07T12:00:00.000Z');

      /*
       * Still true, and still the point: nothing became zero. An
       * ACCESS_LOST row states absence of knowledge, never absence of
       * work.
       */
      expect(
        meta.activity.commitsAttributed,
      ).not.toBe(0);
    });
  });

  describe('NOT_SCANNED', () => {
    /* Rule 2, the one the contract calls the most defamatory mistake. */
    it('is never zero - in the projection, the description or the row', async () => {
      const boundary = harness();

      const { observation } = await boundary.sync({
        repos: [
          { id: 501, name: 'core', commitCount: 7 },
          { id: 502, name: 'skipped', commitCount: 99 },
        ],
        budget: 1,
      });

      const skipped = observation.repositories.find(
        (repo) => repo.repoId === '502',
      );

      expect(skipped?.completeness.commits).toBe(
        'NOT_SCANNED',
      );

      const meta = boundary.metadata(502);

      expect(meta.completeness.commits).toBe('NOT_SCANNED');

      expect(meta.activity).toEqual({
        commitsAttributed: null,
        pullRequestsAuthored: null,
        issuesAuthored: null,
        firstActivityAt: null,
        lastActivityAt: null,
      });

      /* Said explicitly, because toEqual would also accept 0 === null
       * nowhere but a reader could still miss the point. */
      expect(meta.activity.commitsAttributed).not.toBe(0);
      expect(meta.activity.pullRequestsAuthored).not.toBe(0);
      expect(meta.activity.issuesAuthored).not.toBe(0);

      const description = boundary.row(502).description ?? '';

      expect(description).toContain(
        'listed but not scanned in this sync',
      );
      expect(description).toContain(
        'That is not the same as no activity.',
      );

      /* No count of any kind is stated for a repository nobody read. */
      expect(description).not.toMatch(/\d/);

      /* And no zero reached the column, at any depth. */
      expect(
        JSON.stringify(boundary.row(502).metadata),
      ).not.toMatch(/"(commitsAttributed|pullRequestsAuthored|issuesAuthored)":0/);
    });

    it('is produced by a rate limit too, still without zeros', async () => {
      const boundary = harness();

      await boundary.sync({
        repos: [
          {
            id: 601,
            name: 'first',
            commits: 'rate_limited',
          },
          { id: 602, name: 'second', commitCount: 12 },
        ],
      });

      /*
       * Once limited, no further requests are made - so the SECOND
       * repository is NOT_SCANNED even though nothing was wrong with it.
       */
      expect(
        boundary.metadata(602).completeness.commits,
      ).toBe('NOT_SCANNED');
      expect(
        boundary.metadata(602).activity.commitsAttributed,
      ).toBeNull();
      expect(
        boundary.metadata(601).activity.commitsAttributed,
      ).toBeNull();
    });
  });

  describe('truncated commit walks', () => {
    it('marks the row truncated and refuses to present the count as complete', async () => {
      const boundary = harness();

      await boundary.sync({
        repos: [
          {
            id: 701,
            name: 'busy',
            commitCount: 100,
            commitsTruncated: true,
          },
        ],
        scannedSince: '2024-01-01T00:00:00.000Z',
      });

      const meta = boundary.metadata(701);

      expect(meta.completeness.truncated).toBe(true);
      expect(meta.activity.commitsAttributed).toBe(100);

      const description = boundary.row(701).description ?? '';

      /* The count is stated as a floor, inside the window it was taken over. */
      expect(description).toContain(
        'at least 100 commits on the default branch',
      );
      expect(description).toContain(
        'since 2024-01-01T00:00:00.000Z',
      );

      /* And the ceiling is disclosed in the same breath. */
      expect(description).toContain(
        'A pagination limit was reached while scanning, so that figure is short of what GitHub holds.',
      );

      /* Never phrased as a total. */
      expect(description).not.toContain('100 commits total');
      expect(description).not.toMatch(/\ba total of\b/);
    });
  });

  describe('a partial run', () => {
    /* Rule 4, at the size the budget actually produces in production. */
    it('records 30 of 40 as PARTIAL, never SUCCEEDED', async () => {
      const boundary = harness();

      const repos: RepoSpec[] = Array.from(
        { length: 40 },
        (_unused, index) => ({
          id: 1000 + index,
          name: `repo-${index}`,
          commitCount: 2,
        }),
      );

      const run = await boundary.runs.start({
        connectionId: CONNECTION,
        userId: USER,
      });

      const { observation } = await boundary.sync({
        repos,
        budget: 30,
      });

      expect(observation.completeness.reposScanned).toBe(30);
      expect(observation.completeness.reposTotal).toBe(40);
      expect(isCompleteScan(observation.completeness)).toBe(
        false,
      );

      const finished = await boundary.runs.finish(
        run.id,
        observation,
      );

      expect(finished.status).toBe('PARTIAL');
      expect(finished.status).not.toBe('SUCCEEDED');

      const persistedRun = boundary.store.rows.syncRuns[0];

      expect(persistedRun?.status).toBe('PARTIAL');
      expect(persistedRun?.status).not.toBe('SUCCEEDED');

      /* All 40 are evidenced; the 10 unscanned ones say so. */
      expect(boundary.store.rows.evidence).toHaveLength(40);
      expect(
        boundary.metadata(1029).completeness.commits,
      ).toBe('DEFAULT_BRANCH_ONLY');
      expect(
        boundary.metadata(1030).completeness.commits,
      ).toBe('NOT_SCANNED');
      expect(
        boundary.metadata(1030).activity.commitsAttributed,
      ).toBeNull();

      /* Every row - scanned or not - carries the run-level coverage,
       * so no count can be read without it. */
      for (const row of boundary.store.rows.evidence) {
        const meta = row.metadata as PersistedMetadata;

        expect(meta.completeness.reposScanned).toBe(30);
        expect(meta.completeness.reposTotal).toBe(40);
      }
    });

    it('reports SUCCEEDED when the scan really was complete', async () => {
      const boundary = harness();

      const run = await boundary.runs.start({
        connectionId: CONNECTION,
        userId: USER,
      });

      const { observation } = await boundary.sync({
        repos: [
          { id: 801, name: 'one', commitCount: 1 },
          { id: 802, name: 'two', commitCount: 2 },
        ],
      });

      expect(isCompleteScan(observation.completeness)).toBe(
        true,
      );
      expect(
        (await boundary.runs.finish(run.id, observation))
          .status,
      ).toBe('SUCCEEDED');
    });

    it('reports PARTIAL when the listing itself was truncated', async () => {
      const boundary = harness();

      const run = await boundary.runs.start({
        connectionId: CONNECTION,
        userId: USER,
      });

      const { observation } = await boundary.sync({
        repos: [{ id: 803, name: 'one', commitCount: 1 }],
        listingTruncated: true,
      });

      /*
       * Everything listed WAS scanned, so reposScanned >= reposTotal.
       * The run is still partial: there are repositories that were never
       * enumerated at all.
       */
      expect(observation.completeness.reposScanned).toBe(1);
      expect(observation.completeness.reposTotal).toBe(1);
      expect(
        (await boundary.runs.finish(run.id, observation))
          .status,
      ).toBe('PARTIAL');

      expect(
        boundary.metadata(803).completeness.listingTruncated,
      ).toBe(true);
    });
  });

  describe('an empty repository', () => {
    it('records 0, distinguishably from NOT_SCANNED null', async () => {
      const boundary = harness();

      await boundary.sync({
        repos: [
          { id: 901, name: 'blank', commits: 'empty' },
          { id: 902, name: 'unread', commitCount: 5 },
        ],
        budget: 1,
      });

      const empty = boundary.metadata(901);
      const notScanned = boundary.metadata(902);

      /* Scanned, and the answer was zero. */
      expect(empty.completeness.commits).toBe(
        'DEFAULT_BRANCH_ONLY',
      );
      expect(empty.activity.commitsAttributed).toBe(0);
      expect(empty.activity.commitsAttributed).not.toBeNull();

      /* Not scanned, and therefore not zero. */
      expect(notScanned.completeness.commits).toBe(
        'NOT_SCANNED',
      );
      expect(
        notScanned.activity.commitsAttributed,
      ).toBeNull();

      /* The two are distinguishable on the persisted row alone. */
      expect(empty.activity.commitsAttributed).not.toBe(
        notScanned.activity.commitsAttributed,
      );
      expect(empty.completeness.commits).not.toBe(
        notScanned.completeness.commits,
      );

      expect(boundary.row(901).description).toContain(
        'at least 0 commits on the default branch',
      );
      expect(boundary.row(902).description).toContain(
        'listed but not scanned',
      );
    });
  });

  describe('unestablished authored activity', () => {
    it('stays null when the authored-activity query failed', async () => {
      const boundary = harness();

      await boundary.sync({
        repos: [
          { id: 950, name: 'core', commitCount: 6 },
        ],
        authored: 'unavailable',
      });

      const meta = boundary.metadata(950);

      /* The commit walk still worked, so that count is real. */
      expect(meta.completeness.commits).toBe(
        'DEFAULT_BRANCH_ONLY',
      );
      expect(meta.activity.commitsAttributed).toBe(6);

      /* The index did not, so these are not established - not zero. */
      expect(meta.activity.pullRequestsAuthored).toBeNull();
      expect(meta.activity.issuesAuthored).toBeNull();
      expect(
        meta.activity.pullRequestsAuthored,
      ).not.toBe(0);
      expect(meta.activity.issuesAuthored).not.toBe(0);

      /* And the description says nothing at all about them, rather
       * than saying nothing was authored. */
      const description = boundary.row(950).description ?? '';

      expect(description).not.toContain(
        'Pull requests authored',
      );
      expect(description).not.toContain('Issues authored');
    });

    it('records a real 0 when the index worked and the repository is absent from it', async () => {
      const boundary = harness();

      await boundary.sync({
        repos: [
          { id: 951, name: 'core', commitCount: 6 },
        ],
        /* A working index that simply holds nothing for this repo. */
        authored: [],
      });

      const meta = boundary.metadata(951);

      expect(meta.activity.pullRequestsAuthored).toBe(0);
      expect(meta.activity.issuesAuthored).toBe(0);
      expect(boundary.row(951).description).toContain(
        'Pull requests authored by the connected account and seen in the scanned window: 0.',
      );
    });
  });

  describe('the completeness record itself', () => {
    it('survives projection and persistence intact', async () => {
      const boundary = harness();

      await boundary.sync({
        repos: [
          {
            id: 960,
            name: 'core',
            commitCount: 11,
            commitsTruncated: true,
          },
          { id: 961, name: 'other', commitCount: 1 },
          { id: 962, name: 'skipped', commitCount: 4 },
        ],
        budget: 2,
        listingTruncated: true,
        scannedSince: '2025-01-01T00:00:00.000Z',
        scannedAt: '2026-09-07T12:00:00.000Z',
      });

      expect(
        boundary.metadata(960).completeness,
      ).toEqual({
        /*
         * revalidatedBy records HOW a count survived a run that did not
         * re-derive it - null here because this run read GitHub.
         */
        revalidatedBy: null,
        commits: 'DEFAULT_BRANCH_ONLY',
        scannedSince: '2025-01-01T00:00:00.000Z',
        scannedAt: '2026-09-07T12:00:00.000Z',
        truncated: true,
        reposScanned: 2,
        reposTotal: 3,
        listingTruncated: true,
      });

      /* The unscanned row carries the same run-level numbers, and its
       * own truncated flag is false rather than inherited. */
      expect(
        boundary.metadata(962).completeness,
      ).toEqual({
        commits: 'NOT_SCANNED',
        /* Nothing was carried: this repository was never read. */
        revalidatedBy: null,
        scannedSince: '2025-01-01T00:00:00.000Z',
        scannedAt: '2026-09-07T12:00:00.000Z',
        truncated: false,
        reposScanned: 2,
        reposTotal: 3,
        listingTruncated: true,
      });

      /* capturedAt is the sync's scannedAt, not a wall clock. */
      expect(boundary.row(960).capturedAt).toEqual(
        new Date('2026-09-07T12:00:00.000Z'),
      );

      /* occurredAt dates the work, not the capture. */
      expect(boundary.row(960).occurredAt).toEqual(
        new Date('2025-06-01T00:00:00.000Z'),
      );
    });

    it('does not rewrite the row when a re-sync observed nothing new', async () => {
      const boundary = harness();

      const scenario: Scenario = {
        repos: [
          {
            id: 970,
            name: 'core',
            commitCount: 3,
            languages: { Go: 400 },
          },
        ],
      };

      await boundary.sync(scenario);

      /*
       * A sentinel rather than a captured timestamp: two writes inside
       * one millisecond would compare equal and the assertion below would
       * pass without proving anything. Any write at all moves this.
       */
      const sentinel = new Date('1999-12-31T00:00:00.000Z');

      boundary.row(970).updatedAt = sentinel;

      /*
       * Everything the observation consists of, snapshotted before the
       * re-sync so the assertion below is about the WHOLE row rather than
       * the handful of fields somebody remembered to check.
       */
      const before = {
        capturedAt: boundary.row(970).capturedAt,
        occurredAt: boundary.row(970).occurredAt,
        title: boundary.row(970).title,
        description: boundary.row(970).description,
        sourceUrl: boundary.row(970).sourceUrl,
        externalId: boundary.row(970).externalId,
        metadata: JSON.stringify(boundary.row(970).metadata),
        completeness: boundary.row(970).completeness,
      };

      const again = await boundary.sync(scenario);

      expect(again.persisted).toEqual({
        created: 0,
        updated: 1,
      });
      expect(boundary.store.rows.evidence).toHaveLength(1);

      /*
       * The observation is untouched. Since PR-6's approved exception the
       * row is no longer completely inert on an unchanged run - the
       * freshness heartbeat advances lastObservedAt, because "unchanged"
       * and "unverified" are different facts and the row previously could
       * not tell them apart.
       *
       * What the no-churn guard still guarantees, and what this asserts,
       * is that the heartbeat moves ONLY that. capturedAt in particular
       * must not move: the evidence sheet orders by it, so re-stamping it
       * would reorder a user's evidence every time a sync confirmed
       * nothing had happened.
       */
      const row = boundary.row(970);

      expect(row.capturedAt).toEqual(before.capturedAt);
      expect(row.occurredAt).toEqual(before.occurredAt);
      expect(row.title).toEqual(before.title);
      expect(row.description).toEqual(before.description);
      expect(row.sourceUrl).toEqual(before.sourceUrl);
      expect(row.externalId).toEqual(before.externalId);
      expect(JSON.stringify(row.metadata)).toEqual(before.metadata);
      expect(row.completeness).toEqual(before.completeness);

      /* The heartbeat did fire, and it is the only reason the row moved. */
      expect(row.updatedAt).not.toEqual(sentinel);
      expect(row.lastObservedAt).not.toBeNull();

      expect(boundary.store.calls.evidenceUpdateMany).toHaveLength(1);
      expect(
        Object.keys(
          boundary.store.calls.evidenceUpdateMany[0]!.data,
        ),
      ).toEqual(['lastObservedAt']);
    });
  });
});
