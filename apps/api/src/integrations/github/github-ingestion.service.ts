import { Injectable } from '@nestjs/common';

import {
  GithubRequestError,
  GithubRestClient,
} from './github-rest.client.js';
import {
  isAuthoredBy,
  isCommitAttributedTo,
  isPullRequest,
  repositoryIdOf,
} from './observations/attribution.js';
import {
  buildSyncObservation,
  emptyActivity,
  normalizeLanguages,
  normalizeRepository,
} from './observations/normalize.js';
import type {
  AccountObservation,
  ActivityObservation,
  CommitCompleteness,
  RepositoryObservation,
  SyncObservation,
} from './observations/types.js';

/*
 * Sync orchestration: decide what to fetch, in what order, and what to
 * record when a fetch does not come back.
 *
 * No HTTP lives here (that is GithubRestClient) and no shape decisions
 * live here (that is observations/). What lives here is the budget and
 * the failure policy - the two things that decide whether a run is honest.
 *
 * The governing rule is that an absence is never reported as a zero. A
 * repository we ran out of budget for, a repository that returned 404, an
 * issues query that the token could not run: each records "not
 * established", and the completeness contract carries that to every
 * consumer. Rendering any of them as 0 would state that a person did no
 * work, using their own data, on the strength of us not having looked.
 */

/*
 * How many repositories one run will scan in depth.
 *
 * The primary rate limit is 5,000 requests/hour and it belongs to the
 * USER - it is shared with every other GitHub integration they have
 * authorized, so we never have the whole budget. Each repository costs
 * two requests here (languages, commits), so this ceiling spends at most
 * ~120. Repositories beyond it are listed and marked NOT_SCANNED, which
 * makes the run PARTIAL rather than making it wrong.
 */
const DEFAULT_REPOSITORY_SCAN_BUDGET = 60;

export type IngestionInput = {
  accessToken: string;
  account: AccountObservation;
  /** Injected, so a run is reproducible and testable. */
  scannedAt: string;
  scannedSince: string | null;
  repositoryScanBudget?: number;
};

type ActivityIndex = Map<
  string,
  { pullRequests: number; issues: number }
>;

@Injectable()
export class GithubIngestionService {
  constructor(
    private readonly rest: GithubRestClient,
  ) {}

  async ingest(
    input: IngestionInput,
  ): Promise<SyncObservation> {
    const budget =
      input.repositoryScanBudget ??
      DEFAULT_REPOSITORY_SCAN_BUDGET;

    const listing = await this.listRepositories(
      input,
    );

    /*
     * Authored issues and pull requests come from ONE cross-repository
     * call rather than two per repository. It is dramatically cheaper
     * against the shared rate limit, and `filter=created` is GitHub's own
     * statement of authorship rather than ours.
     */
    const activityIndex =
      await this.indexAuthoredActivity(input);

    const repositories: RepositoryObservation[] =
      [];

    /*
     * Sequential. GitHub's guidance is explicit - "make requests serially
     * instead of concurrently" - and the secondary limit caps concurrency
     * across the whole API, so a Promise.all here would trip it and risk
     * the integration being banned.
     */
    let scanned = 0;
    let rateLimited = false;

    for (const raw of listing.items) {
      const shell = normalizeRepository({
        raw,
        completeness: {
          commits: 'NOT_SCANNED',
          scannedSince: input.scannedSince,
          scannedAt: input.scannedAt,
          truncated: false,
        },
      });

      if (shell === null) {
        continue;
      }

      /*
       * Once rate limited, every remaining repository is recorded as
       * NOT_SCANNED and no further requests are made. Continuing to call
       * while limited is what GitHub warns can get an integration banned.
       */
      if (rateLimited || scanned >= budget) {
        repositories.push(shell);
        continue;
      }

      try {
        repositories.push(
          await this.scanRepository(
            input,
            shell,
            activityIndex,
          ),
        );

        scanned += 1;
      } catch (error) {
        if (
          error instanceof GithubRequestError &&
          error.reason === 'rate_limited'
        ) {
          rateLimited = true;
          repositories.push(shell);
          continue;
        }

        if (
          error instanceof GithubRequestError &&
          error.reason === 'access_lost'
        ) {
          repositories.push(
            this.withCompleteness(
              shell,
              'ACCESS_LOST',
              input,
            ),
          );

          scanned += 1;
          continue;
        }

        /*
         * Anything else leaves this repository unscanned and lets the run
         * continue. One repository failing is not a reason to discard the
         * work already done on the others.
         */
        repositories.push(shell);
      }
    }

    return buildSyncObservation({
      account: input.account,
      repositories,
      reposTotal: listing.items.length,
      scannedAt: input.scannedAt,
      scannedSince: input.scannedSince,
      truncated: listing.truncated,
    });
  }

  private async listRepositories(
    input: IngestionInput,
  ) {
    /*
     * sort=created, not pushed or updated. Sorting a paginated walk by a
     * field that mutates means a repository touched mid-walk can shift
     * between pages and be seen twice or missed entirely. Creation order
     * never changes.
     *
     * type=owner because a repository the user merely has access to says
     * nothing about their work in it; membership is not authorship.
     */
    return this.rest.getAll(
      `/users/${encodeURIComponent(
        input.account.login,
      )}/repos?type=owner&sort=created&direction=asc`,
      {
        accessToken: input.accessToken,
        operation: 'list_repositories',
      },
    );
  }

  /**
   * Counts issues and pull requests GitHub says the account authored.
   *
   * Failure here is not fatal and is not zero: the counts simply stay
   * null. That matters because whether this endpoint works at all with a
   * `user:email`-only token is not documented by GitHub - so the design
   * has to be correct when it returns nothing as well as when it works.
   */
  private async indexAuthoredActivity(
    input: IngestionInput,
  ): Promise<ActivityIndex | null> {
    let page;

    try {
      page = await this.rest.getAll(
        '/issues?filter=created&state=all',
        {
          accessToken: input.accessToken,
          operation: 'list_authored_activity',
        },
      );
    } catch {
      /*
       * Null means "not established". The alternative - an empty index -
       * would make every repository report 0 authored issues, which is a
       * claim we have not earned.
       */
      return null;
    }

    const index: ActivityIndex = new Map();

    for (const item of page.items) {
      /*
       * Re-checked against the numeric account id even though
       * filter=created already means "created by you". GitHub does not
       * publish that as a guarantee, and one integer comparison converts
       * an implied promise into one we hold ourselves.
       */
      if (
        !isAuthoredBy(
          item,
          input.account.accountId,
        )
      ) {
        continue;
      }

      const repoId = repositoryIdOf(item);

      if (repoId === null) {
        continue;
      }

      const entry = index.get(repoId) ?? {
        pullRequests: 0,
        issues: 0,
      };

      if (isPullRequest(item)) {
        entry.pullRequests += 1;
      } else {
        entry.issues += 1;
      }

      index.set(repoId, entry);
    }

    return index;
  }

  private async scanRepository(
    input: IngestionInput,
    shell: RepositoryObservation,
    activityIndex: ActivityIndex | null,
  ): Promise<RepositoryObservation> {
    const owner = shell.owner.login;
    const name = shell.name;

    const languages = await this.rest.get(
      `/repos/${encodeURIComponent(
        owner,
      )}/${encodeURIComponent(name)}/languages`,
      {
        accessToken: input.accessToken,
        operation: 'repository_languages',
      },
    );

    const commits = await this.fetchCommits(
      input,
      owner,
      name,
    );

    const authored = activityIndex?.get(
      shell.repoId,
    );

    const activity: ActivityObservation = {
      commitsAttributed: commits.count,
      /*
       * null, not 0, when the authored-activity index could not be built.
       * A repository genuinely absent from a working index did have zero,
       * and that distinction is the whole point.
       */
      pullRequestsAuthored:
        activityIndex === null
          ? null
          : (authored?.pullRequests ?? 0),
      issuesAuthored:
        activityIndex === null
          ? null
          : (authored?.issues ?? 0),
      firstActivityAt: commits.firstAt,
      lastActivityAt: commits.lastAt,
    };

    return {
      ...shell,
      /*
       * A 304 leaves languages empty for this run rather than inventing
       * them. 7.6 owns carrying a cached value forward; this phase only
       * has to avoid asserting something it did not read.
       */
      languages:
        languages.status === 'ok'
          ? normalizeLanguages(languages.body)
          : [],
      activity,
      completeness: {
        commits: commits.completeness,
        scannedSince: input.scannedSince,
        scannedAt: input.scannedAt,
        truncated: commits.truncated,
      },
    };
  }

  /**
   * Counts commits GitHub attributes to the account, on the default
   * branch only.
   *
   * `?author={login}` is sent as a bandwidth optimisation and is NOT
   * trusted as the authority. GitHub documents that parameter only as
   * "GitHub username or email address" and never states whether it
   * resolves to an account or matches git metadata - so every returned
   * commit is re-checked against the numeric account id. Getting this
   * wrong would let anyone manufacture evidence of our user's work by
   * setting a git config value.
   */
  private async fetchCommits(
    input: IngestionInput,
    owner: string,
    name: string,
  ): Promise<{
    count: number;
    completeness: CommitCompleteness;
    truncated: boolean;
    firstAt: string | null;
    lastAt: string | null;
  }> {
    const query = new URLSearchParams({
      author: input.account.login,
    });

    if (input.scannedSince) {
      query.set('since', input.scannedSince);
    }

    let page;

    try {
      page = await this.rest.getAll(
        `/repos/${encodeURIComponent(
          owner,
        )}/${encodeURIComponent(
          name,
        )}/commits?${query.toString()}`,
        {
          accessToken: input.accessToken,
          operation: 'repository_commits',
        },
      );
    } catch (error) {
      /*
       * An empty repository is a real answer, not a failure: it has no
       * commits, so zero is the truth rather than an absence.
       */
      if (
        error instanceof GithubRequestError &&
        error.reason === 'empty_repository'
      ) {
        return {
          count: 0,
          completeness: 'DEFAULT_BRANCH_ONLY',
          truncated: false,
          firstAt: null,
          lastAt: null,
        };
      }

      throw error;
    }

    let count = 0;
    let firstAt: string | null = null;
    let lastAt: string | null = null;

    for (const commit of page.items) {
      if (
        !isCommitAttributedTo(
          commit,
          input.account.accountId,
        )
      ) {
        continue;
      }

      count += 1;

      const at = commitDate(commit);

      if (at === null) {
        continue;
      }

      if (firstAt === null || at < firstAt) {
        firstAt = at;
      }

      if (lastAt === null || at > lastAt) {
        lastAt = at;
      }
    }

    return {
      count,
      completeness: 'DEFAULT_BRANCH_ONLY',
      truncated: page.truncated,
      firstAt,
      lastAt,
    };
  }

  private withCompleteness(
    repository: RepositoryObservation,
    commits: CommitCompleteness,
    input: IngestionInput,
  ): RepositoryObservation {
    return {
      ...repository,
      activity: emptyActivity(),
      completeness: {
        commits,
        scannedSince: input.scannedSince,
        scannedAt: input.scannedAt,
        truncated: false,
      },
    };
  }
}

/*
 * The commit's own timestamp. Read from git metadata, which is fine here
 * and would not be fine for identity: this is used only to bound a window
 * of activity that has ALREADY been attributed by account id.
 */
function commitDate(
  commit: unknown,
): string | null {
  if (
    typeof commit !== 'object' ||
    commit === null
  ) {
    return null;
  }

  const inner = (
    commit as Record<string, unknown>
  )['commit'];

  if (
    typeof inner !== 'object' ||
    inner === null
  ) {
    return null;
  }

  const author = (
    inner as Record<string, unknown>
  )['author'];

  if (
    typeof author !== 'object' ||
    author === null
  ) {
    return null;
  }

  const date = (
    author as Record<string, unknown>
  )['date'];

  if (typeof date !== 'string') {
    return null;
  }

  const parsed = Date.parse(date);

  return Number.isNaN(parsed)
    ? null
    : new Date(parsed).toISOString();
}
