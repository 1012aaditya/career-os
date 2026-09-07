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
  LanguageObservation,
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

/*
 * What a previous run established about one repository.
 *
 * Supplied by the sync service, which is the only layer that may read the
 * database. This service stays DB-free so it remains a pure function of
 * (GitHub responses, prior state) - which is what makes the incremental
 * decision reproducible in a test without a database.
 */
export type PriorRepositoryState = {
  externalId: string;
  pushedAt: string | null;
  defaultBranch: string | null;
  scannedSince: string | null;
  truncated: boolean;
  commits: CommitCompleteness;
  scannedAt: string;
  activity: ActivityObservation;
  languages: LanguageObservation[];
};

export type IngestionInput = {
  accessToken: string;
  account: AccountObservation;
  /** Injected, so a run is reproducible and testable. */
  scannedAt: string;
  scannedSince: string | null;
  repositoryScanBudget?: number;
  /*
   * Keyed by externalId - the row's own unique key - never by a field
   * read back out of metadata JSON. Absent on a first sync.
   */
  priorRepositories?: ReadonlyMap<
    string,
    PriorRepositoryState
  >;
};

type ActivityIndex = Map<
  string,
  { pullRequests: number; issues: number }
>;

/*
 * May a previous run's commit count be carried instead of re-derived?
 *
 * Every clause below is load-bearing; none is belt-and-braces.
 *
 *   commits === 'DEFAULT_BRANCH_ONLY'
 *     The stored count must itself be an observation. This ALSO closes a
 *     trap that is not obvious: mergeNonObserving takes the repository
 *     block from the INCOMING metadata, deliberately, so a rename is not
 *     lost. That means a rate-limited run leaves a row holding a FRESH
 *     pushedAt beside a STALE count. Comparing pushed_at alone would then
 *     mark that repository unchanged forever and its commits would never
 *     be counted again. The merge sets stored completeness to
 *     NOT_SCANNED, and this clause is what reads that.
 *
 *   truncated === false
 *     A count that hit the page ceiling is known to be short. Carrying it
 *     would freeze it short permanently, because pushed_at will not move
 *     on its behalf - and carrying truncated: true forward would force
 *     PARTIAL on every future run with no path to repair.
 *
 *   scannedSince matches
 *     The window is rendered into the evidence description. Carrying a
 *     count gathered over one window under a different window's sentence
 *     would state a falsehood.
 *
 *   defaultBranch matches, both non-null
 *     Commits are read from the default branch. Renaming master to main,
 *     or pointing it at a release branch, changes what is counted and
 *     does NOT move pushed_at.
 *
 *   pushedAt equal, both non-null
 *     Never on null === null. optionalInstant collapses absent, malformed
 *     and genuinely-null into the same null, so a naive equality would
 *     read "I have no idea" as "unchanged" - and if GitHub ever stopped
 *     sending pushed_at, every repository on every account would compare
 *     equal and the whole sync would silently stall forever. A
 *     never-pushed repository is cheap to re-read; a silent global stall
 *     is not recoverable.
 */
function canRevalidate(
  prior: PriorRepositoryState | undefined,
  shell: RepositoryObservation,
  scannedSince: string | null,
): boolean {
  if (!prior) {
    return false;
  }

  return (
    prior.commits === 'DEFAULT_BRANCH_ONLY' &&
    prior.truncated === false &&
    prior.scannedSince === scannedSince &&
    prior.defaultBranch !== null &&
    shell.defaultBranch !== null &&
    prior.defaultBranch === shell.defaultBranch &&
    prior.pushedAt !== null &&
    shell.pushedAt !== null &&
    prior.pushedAt === shell.pushedAt
  );
}

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
          revalidatedBy: null,
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
        const observed =
          await this.scanRepository(
            input,
            shell,
            activityIndex,
          );

        repositories.push(observed);

        /*
         * The budget counts repositories READ, not repositories
         * considered. A revalidated repository issues no request, so
         * spending budget on it would make the ceiling permanent: an
         * account with more repositories than the budget would revalidate
         * the same first sixty for free on every run, exhaust the budget
         * on them, and leave the remainder NOT_SCANNED forever.
         *
         * Not spending it is what makes coverage progressive - the budget
         * goes to repositories that actually need reading, so a large
         * account converges over several syncs instead of never. That is
         * the strongest argument for incremental sync, and until this it
         * was asserted in the decision record and contradicted one line
         * into the loop it described.
         */
        if (
          observed.completeness.revalidatedBy ===
          null
        ) {
          scanned += 1;
        }
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
      authoredActivityEstablished:
        activityIndex !== null,
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

    /*
     * A truncated listing is NOT an established count.
     *
     * This walk is capped at ten pages of a hundred, so an account with
     * more than ~1,000 authored issues and pull requests gets a partial
     * index - and every repository missing from it would then be written
     * with a hard 0, because a repository absent from a WORKING index
     * genuinely has none. That is the completeness contract's first rule
     * inverted: "we did not look" rendered as "this person did nothing",
     * on the user's own data, in the one place the rule is easiest to
     * miss because the request succeeded.
     *
     * Returning null routes it down the same path as an outright failure:
     * prior counts are carried, nothing becomes zero, and the run reports
     * PARTIAL rather than SUCCEEDED.
     */
    if (page.truncated) {
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

    const prior = input.priorRepositories?.get(
      shell.externalId,
    );

    const revalidated = canRevalidate(
      prior,
      shell,
      input.scannedSince,
    );

    /*
     * A revalidated repository is not read at all - neither endpoint.
     * That is the whole saving: the commit walk is paginated and can be
     * ten requests on its own, and the languages call is another.
     *
     * The residual risk is narrow and stated rather than hidden. GitHub
     * can recompute linguist classifications server-side without a push,
     * so a revalidated repository's language breakdown may lag until its
     * next push. A default-branch change - the other way languages can
     * move without a push - is already excluded by canRevalidate, which
     * compares defaultBranch. What remains is a byte-count drift, which
     * is cosmetic beside the cost of re-reading every repository forever,
     * and revalidatedBy: 'pushed_at' is what makes those rows findable if
     * that judgement turns out to be wrong.
     */
    const languages = revalidated
      ? null
      : await this.rest.get(
          `/repos/${encodeURIComponent(
            owner,
          )}/${encodeURIComponent(
            name,
          )}/languages`,
          {
            accessToken: input.accessToken,
            operation: 'repository_languages',
          },
        );

    /*
     * The whole incremental saving. A repository whose last push has not
     * moved cannot have gained or lost a commit on its default branch, so
     * the previous count is carried rather than re-derived.
     *
     * It is a weaker signal than re-reading, and knowingly so: GitHub
     * resolves commit authorship at READ time, so a user who adds an old
     * verified email gains attributed commits with no push. That is why
     * the carry is recorded as revalidatedBy: 'pushed_at' rather than
     * passed off as a fresh observation.
     */
    const commits = revalidated
      ? {
          count:
            prior!.activity.commitsAttributed,
          completeness:
            'DEFAULT_BRANCH_ONLY' as const,
          truncated: false,
          firstAt:
            prior!.activity.firstActivityAt,
          lastAt:
            prior!.activity.lastActivityAt,
        }
      : await this.fetchCommits(
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
       * Authored counts are taken fresh EVERY run, including for a
       * revalidated repository, and are never carried forward.
       *
       * Authoring an issue or a pull request does not push code, so it
       * does not move pushed_at - a revalidated repository is exactly
       * where a stale authored count would hide. They come from one
       * cross-repository call that runs regardless, so freshness here
       * costs nothing.
       *
       * When that index could not be built we fall back to the last
       * count that was established, and to null only if there has never
       * been one. Never 0: a repository absent from a WORKING index did
       * have zero, and that distinction is the whole point. Writing null
       * over a known count would be the same erasure the persistence
       * guard refuses for commits.
       */
      pullRequestsAuthored:
        activityIndex === null
          ? (prior?.activity
              .pullRequestsAuthored ?? null)
          : (authored?.pullRequests ?? 0),
      issuesAuthored:
        activityIndex === null
          ? (prior?.activity.issuesAuthored ??
            null)
          : (authored?.issues ?? 0),
      firstActivityAt: commits.firstAt,
      lastActivityAt: commits.lastAt,
    };

    return {
      ...shell,
      /*
       * Read this run when we read it; otherwise carried from the last
       * run that did.
       *
       * A 304 means "unchanged since your copy", so falling back to []
       * would turn a cache hit into a claim that the repository has no
       * languages - the same shape of error as reading "not scanned" as
       * "no activity". The empty list is only correct when there was
       * genuinely nothing before.
       */
      languages:
        languages !== null &&
        languages.status === 'ok'
          ? normalizeLanguages(languages.body)
          : (prior?.languages ?? []),
      activity,
      completeness: {
        commits: commits.completeness,
        scannedSince: input.scannedSince,
        scannedAt: input.scannedAt,
        truncated: commits.truncated,
        revalidatedBy: revalidated
          ? 'pushed_at'
          : null,
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
        revalidatedBy: null,
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
