import { canonicalJson } from './observations/canonical-json.js';
import { GithubIngestionService } from './github-ingestion.service.js';
import { GithubRestClient } from './github-rest.client.js';

const TOKEN_PREFIX = 'gho';
const TOKEN = `${TOKEN_PREFIX}_16C7e42F292c6912E7710c838347Ae178B4a`;

const ACCOUNT = {
  accountId: '583231',
  login: 'octocat',
};

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
    description: null,
    size: 100,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    pushed_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function commit(
  authorId: number | null,
  date = '2024-06-02T14:31:09Z',
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

/*
 * Routes by URL shape. The real ingestion service and the real REST
 * client run; only the network is scripted, so pagination, retry and
 * attribution all execute for real.
 */
function build(
  routes: {
    repos?: Route;
    issues?: Route;
    languages?: Route | ((n: string) => Route);
    commits?: Route | ((n: string) => Route);
  },
  budget?: number,
) {
  const requested: string[] = [];

  const resolve = (
    route: Route | ((n: string) => Route) | undefined,
    name: string,
  ): Route =>
    typeof route === 'function'
      ? route(name)
      : (route ?? { body: [] });

  vi.spyOn(
    globalThis,
    'fetch',
  ).mockImplementation(async (input) => {
    const url = String(input);
    requested.push(url);

    const repoName =
      url.match(/\/repos\/[^/]+\/([^/?]+)/)?.[1] ??
      '';

    let route: Route;

    if (url.includes('/issues?')) {
      route = routes.issues ?? { body: [] };
    } else if (url.includes('/languages')) {
      route = resolve(routes.languages, repoName);
    } else if (url.includes('/commits')) {
      route = resolve(routes.commits, repoName);
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

  const service = new GithubIngestionService(
    new GithubRestClient(async () => {}),
  );

  const run = () =>
    service.ingest({
      accessToken: TOKEN,
      account: ACCOUNT,
      scannedAt: SCANNED_AT,
      scannedSince: null,
      repositoryScanBudget: budget,
    });

  return { run, requested };
}

afterEach(() => vi.restoreAllMocks());

describe('GithubIngestionService', () => {
  describe('repository listing', () => {
    it('lists by a stable sort, owned repositories only', async () => {
      const { run, requested } = build({
        repos: { body: [repo(1)] },
      });

      await run();

      const listing = new URL(requested[0]!);

      /*
       * created, not pushed or updated: sorting a paginated walk by a
       * mutating field lets a repository shift pages mid-walk and be
       * duplicated or missed.
       */
      expect(
        listing.searchParams.get('sort'),
      ).toBe('created');
      expect(
        listing.searchParams.get('type'),
      ).toBe('owner');
      expect(listing.pathname).toBe(
        '/users/octocat/repos',
      );
    });

    it('orders output by numeric id regardless of payload order', async () => {
      const { run } = build({
        repos: {
          body: [repo(30), repo(9), repo(1000)],
        },
      });

      const result = await run();

      expect(
        result.repositories.map((r) => r.repoId),
      ).toEqual(['9', '30', '1000']);
    });

    it('produces identical output for a reordered payload', async () => {
      const forwards = await build({
        repos: { body: [repo(1), repo(2), repo(3)] },
      }).run();

      vi.restoreAllMocks();

      const backwards = await build({
        repos: { body: [repo(3), repo(2), repo(1)] },
      }).run();

      expect(canonicalJson(backwards)).toBe(
        canonicalJson(forwards),
      );
    });
  });

  describe('commit attribution', () => {
    it('counts only commits GitHub resolved to the account', async () => {
      const { run } = build({
        repos: { body: [repo(1)] },
        commits: {
          body: [
            commit(583231),
            /* Someone else. */
            commit(999999),
            /* GitHub could not resolve an account. */
            commit(null),
            commit(583231, '2025-01-01T00:00:00Z'),
          ],
        },
      });

      const result = await run();

      expect(
        result.repositories[0]!.activity
          .commitsAttributed,
      ).toBe(2);
    });

    /*
     * The commit query is a bandwidth optimisation, never the authority:
     * GitHub does not document whether ?author resolves to an account or
     * matches git metadata.
     */
    it('sends the author filter but does not trust it', async () => {
      const { run, requested } = build({
        repos: { body: [repo(1)] },
        commits: {
          /* GitHub answers with a commit by someone else anyway. */
          body: [commit(999999)],
        },
      });

      const result = await run();

      const commitsUrl = requested.find((u) =>
        u.includes('/commits'),
      )!;

      expect(
        new URL(commitsUrl).searchParams.get(
          'author',
        ),
      ).toBe('octocat');

      /* ...and it is still not counted. */
      expect(
        result.repositories[0]!.activity
          .commitsAttributed,
      ).toBe(0);
    });

    it('bounds the activity window by attributed commits only', async () => {
      const { run } = build({
        repos: { body: [repo(1)] },
        commits: {
          body: [
            commit(583231, '2024-01-01T00:00:00Z'),
            commit(583231, '2025-06-01T00:00:00Z'),
            /* Not ours - must not widen the window. */
            commit(999999, '2019-01-01T00:00:00Z'),
          ],
        },
      });

      const activity = (await run())
        .repositories[0]!.activity;

      expect(activity.firstActivityAt).toBe(
        '2024-01-01T00:00:00.000Z',
      );
      expect(activity.lastActivityAt).toBe(
        '2025-06-01T00:00:00.000Z',
      );
    });
  });

  describe('authored issues and pull requests', () => {
    it('splits pull requests from issues by repository', async () => {
      const { run } = build({
        repos: { body: [repo(1), repo(2)] },
        issues: {
          body: [
            {
              user: { id: 583231 },
              repository: { id: 1 },
              pull_request: { url: 'x' },
            },
            {
              user: { id: 583231 },
              repository: { id: 1 },
            },
            {
              user: { id: 583231 },
              repository: { id: 2 },
              pull_request: { url: 'y' },
            },
            /* Authored by someone else. */
            {
              user: { id: 999999 },
              repository: { id: 1 },
            },
          ],
        },
      });

      const result = await run();

      expect(
        result.repositories[0]!.activity,
      ).toMatchObject({
        pullRequestsAuthored: 1,
        issuesAuthored: 1,
      });

      expect(
        result.repositories[1]!.activity,
      ).toMatchObject({
        pullRequestsAuthored: 1,
        issuesAuthored: 0,
      });
    });

    /*
     * Whether this endpoint works at all under a user:email-only token is
     * undocumented, so the design has to be right when it fails.
     */
    it('records null, not zero, when the activity query fails', async () => {
      const { run } = build({
        repos: { body: [repo(1)] },
        issues: { status: 403, body: {} },
      });

      const activity = (await run())
        .repositories[0]!.activity;

      expect(
        activity.pullRequestsAuthored,
      ).toBeNull();
      expect(
        activity.issuesAuthored,
      ).toBeNull();
      expect(
        activity.pullRequestsAuthored,
      ).not.toBe(0);

      /* Commits were still scanned. */
      expect(
        activity.commitsAttributed,
      ).toBe(0);
    });
  });

  describe('completeness', () => {
    it('marks a fully scanned repository DEFAULT_BRANCH_ONLY', async () => {
      const { run } = build({
        repos: { body: [repo(1)] },
        commits: { body: [commit(583231)] },
      });

      const result = await run();

      expect(
        result.repositories[0]!.completeness
          .commits,
      ).toBe('DEFAULT_BRANCH_ONLY');
      expect(
        result.completeness.reposScanned,
      ).toBe(1);
    });

    it('marks repositories beyond the budget NOT_SCANNED, with null activity', async () => {
      const { run } = build(
        {
          repos: {
            body: [repo(1), repo(2), repo(3)],
          },
          commits: { body: [commit(583231)] },
        },
        2,
      );

      const result = await run();

      const states = result.repositories.map(
        (r) => r.completeness.commits,
      );

      expect(states).toEqual([
        'DEFAULT_BRANCH_ONLY',
        'DEFAULT_BRANCH_ONLY',
        'NOT_SCANNED',
      ]);

      /* NOT_SCANNED is not zero activity. */
      expect(
        result.repositories[2]!.activity
          .commitsAttributed,
      ).toBeNull();

      expect(result.completeness).toMatchObject({
        reposScanned: 2,
        reposTotal: 3,
      });
    });

    it('marks a repository that returned 404 as ACCESS_LOST', async () => {
      const { run } = build({
        repos: { body: [repo(1), repo(2)] },
        languages: (name) =>
          name === 'repo-1'
            ? { status: 404, body: {} }
            : { body: { Go: 10 } },
        commits: { body: [commit(583231)] },
      });

      const result = await run();

      expect(
        result.repositories[0]!.completeness
          .commits,
      ).toBe('ACCESS_LOST');

      /* Its activity is not asserted as zero either. */
      expect(
        result.repositories[0]!.activity
          .commitsAttributed,
      ).toBeNull();

      /* The rest of the run continues. */
      expect(
        result.repositories[1]!.completeness
          .commits,
      ).toBe('DEFAULT_BRANCH_ONLY');
    });

    it('treats an empty repository as zero commits, not unscanned', async () => {
      const { run } = build({
        repos: { body: [repo(1)] },
        commits: { status: 409, body: {} },
      });

      const result = await run();

      expect(
        result.repositories[0]!.completeness
          .commits,
      ).toBe('DEFAULT_BRANCH_ONLY');

      /* Genuinely zero - the repository has no commits. */
      expect(
        result.repositories[0]!.activity
          .commitsAttributed,
      ).toBe(0);
    });

    /*
     * Continuing to call while rate limited is what GitHub warns can get
     * an integration banned, so the run stops and reports honestly.
     */
    it('stops scanning once rate limited and marks the rest NOT_SCANNED', async () => {
      let commitCalls = 0;

      const { run } = build({
        repos: {
          body: [repo(1), repo(2), repo(3)],
        },
        commits: () => {
          commitCalls += 1;

          return commitCalls === 1
            ? { body: [commit(583231)] }
            : {
                status: 403,
                headers: {
                  'x-ratelimit-remaining': '0',
                  'x-ratelimit-reset': String(
                    Math.floor(Date.now() / 1000) +
                      3600,
                  ),
                },
                body: {},
              };
        },
      });

      const result = await run();

      expect(
        result.repositories.map(
          (r) => r.completeness.commits,
        ),
      ).toEqual([
        'DEFAULT_BRANCH_ONLY',
        'NOT_SCANNED',
        'NOT_SCANNED',
      ]);

      expect(
        result.completeness.reposScanned,
      ).toBe(1);
    });
  });

  describe('languages', () => {
    it('preserves GitHub names and orders deterministically', async () => {
      const { run } = build({
        repos: { body: [repo(1)] },
        languages: {
          body: {
            CSS: 100,
            'Jupyter Notebook': 500,
            'C++': 500,
          },
        },
      });

      const languages = (await run())
        .repositories[0]!.languages;

      expect(languages).toEqual([
        { name: 'C++', bytes: 500 },
        { name: 'Jupyter Notebook', bytes: 500 },
        { name: 'CSS', bytes: 100 },
      ]);
    });
  });

  describe('credential handling', () => {
    it('puts no token anywhere in the observations', async () => {
      const { run } = build({
        repos: { body: [repo(1), repo(2)] },
        commits: { body: [commit(583231)] },
        languages: { body: { Go: 1 } },
        issues: {
          body: [
            {
              user: { id: 583231 },
              repository: { id: 1 },
            },
          ],
        },
      });

      const serialized = canonicalJson(
        await run(),
      );

      for (const forbidden of [
        TOKEN,
        TOKEN_PREFIX,
        'Authorization',
        'Bearer',
      ]) {
        expect(serialized).not.toContain(
          forbidden,
        );
      }
    });
  });
});
