/*
 * Projection: observations in, Evidence inputs out.
 *
 * Pure. No Prisma, no HTTP, no clock, no randomness. Every value that
 * depends on time is read from the observation that was handed in, so
 * running this twice over the same SyncObservation produces two
 * byte-identical results - which is what makes the determinism tests
 * here meaningful rather than decorative, and what stops a re-sync from
 * reading as a change.
 *
 * The line this module must not cross: it may restate what GitHub
 * reported, and it may qualify it. It may never interpret it. Nothing
 * produced here may state or imply employment, employer, job title,
 * seniority, expertise, proficiency, leadership or ownership of work -
 * GitHub cannot support any of those, and a sentence that implies one
 * is a defamation risk pointed at the user's own record.
 *
 * One EvidenceInput per REPOSITORY (Phase 7.0, Model A). Never one per
 * commit, pull request, issue or language.
 */

import { canonicalJson } from '../observations/canonical-json.js';
import type {
  ActivityObservation,
  LanguageObservation,
  RepositoryObservation,
  SyncObservation,
} from '../observations/types.js';
import type { EvidenceInput } from './evidence-input.js';
import { independenceKeyFor } from '../../../evidence/independence.js';

/*
 * How many language names the prose lists before it stops counting them
 * out. The cap exists so a polyglot repository does not produce a
 * paragraph of commas; the remainder is stated rather than dropped.
 */
const MAX_LANGUAGES_IN_PROSE = 5;

/*
 * Observations already hold instants as normalized ISO-8601 strings
 * (normalize.ts re-emits them from a parsed instant, so two spellings of
 * one moment converge). Re-parsing is therefore a conversion, not a
 * rescue: anything that does not parse becomes null instead of being
 * coerced into some nearby date. An invented timestamp is worse than an
 * absent one, because a consumer cannot tell it apart from a real one.
 */
function toInstant(
  value: string | null,
): Date | null {
  if (value === null) {
    return null;
  }

  const parsed = Date.parse(value);

  return Number.isNaN(parsed)
    ? null
    : new Date(parsed);
}

/**
 * When the evidenced thing happened, as GitHub reports it.
 *
 * `pushedAt` first, `createdAt` as the fallback, and null when neither
 * is usable. The reasoning, since this is the one field here that is a
 * genuine choice rather than a copy:
 *
 *   - `pushedAt` is the last moment GitHub says code actually landed in
 *     the repository. The row is evidence about work in a repository, so
 *     the instant that dates it should be an instant at which work
 *     happened. It moves between syncs, and that is correct: the latest
 *     known activity really did move.
 *   - `createdAt` is the fallback because a repository that has never
 *     been pushed to reports `pushedAt: null`, and in that case its
 *     creation is the only thing that has actually happened. It is not
 *     the primary because it would date a repository worked on for six
 *     years to the day it was made.
 *   - `updatedAt` is deliberately NOT in the chain. It moves for
 *     metadata-only events - a star, a description edit, a rename, a
 *     topic change - so using it would date "work happened" to a moment
 *     when demonstrably none did. It is preserved in metadata, where it
 *     is labelled for what it is.
 *   - `activity.lastActivityAt` is also NOT used, though it is the most
 *     tempting. It is bounded by `completeness.scannedSince`, so it is
 *     a fact about the SCAN WINDOW rather than about the repository, and
 *     mixing window-bounded and repository-wide instants across rows
 *     would produce a timeline whose points do not mean the same thing.
 *
 * Never the capture time. Dating a decade-old repository to today is the
 * specific error `capturedAt` exists to prevent.
 */
export function repositoryOccurredAt(
  repo: RepositoryObservation,
): Date | null {
  return (
    toInstant(repo.pushedAt) ??
    toInstant(repo.createdAt)
  );
}

/**
 * When we looked, taken from the sync rather than from a clock.
 *
 * `scannedAt` is injected upstream, so a replay of the same observation
 * reproduces the same row. Reading `new Date()` here instead would make
 * every re-run differ by construction and would quietly defeat every
 * determinism guarantee downstream of this module.
 *
 * Throws rather than substituting the wall clock: a sync observation
 * whose `scannedAt` does not parse is a bug upstream, and papering over
 * it with "now" would convert a loud failure into a silent, unfalsifiable
 * timestamp.
 */
export function syncCapturedAt(
  sync: SyncObservation,
): Date {
  const capturedAt = toInstant(
    sync.completeness.scannedAt,
  );

  if (capturedAt === null) {
    throw new Error(
      'Sync completeness has no usable scannedAt',
    );
  }

  return capturedAt;
}

function plural(
  count: number,
  noun: string,
): string {
  return count === 1
    ? `${count} ${noun}`
    : `${count} ${noun}s`;
}

/*
 * Describes the window a count was taken over.
 *
 * `scannedSince: null` means "since the repository was created" - it does
 * NOT mean "unbounded" or "all time", and phrasing it as either would
 * overstate what was looked at.
 */
function windowClause(
  scannedSince: string | null,
): string {
  return scannedSince === null
    ? ' since the repository was created'
    : ` since ${scannedSince}`;
}

/*
 * Language names are GitHub's, verbatim: "C++", "Jupyter Notebook",
 * "Objective-C++". They are not tidied, mapped or title-cased here, for
 * the same reason normalize.ts leaves them alone - renaming a language is
 * an ontology decision and belongs to a Market Graph that does not exist.
 *
 * The sentence makes no claim about the ORDER of the list. The order is
 * whatever the observation carries (normalize.ts sorts by bytes
 * descending), and this module preserves it untouched rather than
 * re-sorting - so asserting "largest first" here would be asserting
 * something this function did not establish.
 */
function languageClause(
  languages: LanguageObservation[],
): string | null {
  if (languages.length === 0) {
    return null;
  }

  const listed = languages
    .slice(0, MAX_LANGUAGES_IN_PROSE)
    .map((language) => language.name);

  const remainder =
    languages.length - listed.length;

  const names = listed.join(', ');

  const tail =
    remainder > 0
      ? `, and ${remainder} more`
      : '';

  return `Languages GitHub reports for this repository: ${names}${tail}.`;
}

/*
 * The commit sentence, and the three cases it must keep apart.
 *
 * A count is never stated bare. Only the default branch is observable
 * through the endpoints available, so every commit count is a LOWER
 * BOUND, and "at least" is load-bearing rather than hedging.
 *
 * A count that was not established says so. It must never render as
 * zero, and the sentence says out loud that absence of a count is not
 * absence of work - because that inversion is the single most
 * defamatory mistake this system could make with a user's own data.
 */
function commitClause(
  repo: RepositoryObservation,
): string[] {
  const { completeness, activity } = repo;

  if (completeness.commits === 'NOT_SCANNED') {
    return [
      'This repository was listed but not scanned in this sync, so no activity was established for it. That is not the same as no activity.',
    ];
  }

  if (completeness.commits === 'ACCESS_LOST') {
    return [
      'This repository was reachable in an earlier sync and was not reachable during this one, so anything recorded for it is as last captured.',
    ];
  }

  if (activity.commitsAttributed === null) {
    return [
      'Commit attribution was not established for this repository, which is not a statement that there is none.',
    ];
  }

  const sentences = [
    `GitHub attributes at least ${plural(
      activity.commitsAttributed,
      'commit',
    )} on the default branch to the connected account${windowClause(
      completeness.scannedSince,
    )}.`,
  ];

  if (completeness.truncated) {
    sentences.push(
      'A pagination limit was reached while scanning, so that figure is short of what GitHub holds.',
    );
  }

  return sentences;
}

/*
 * Authored counts, stated only when they were established.
 *
 * "Authored" is GitHub's own attribution and nothing more: it says who
 * opened a pull request, not who designed it, reviewed it, merged it or
 * was responsible for it. Every stronger verb available here would be an
 * inference.
 */
function authoredClauses(
  activity: ActivityObservation,
): string[] {
  const sentences: string[] = [];

  if (activity.pullRequestsAuthored !== null) {
    sentences.push(
      `Pull requests authored by the connected account and seen in the scanned window: ${activity.pullRequestsAuthored}.`,
    );
  }

  if (activity.issuesAuthored !== null) {
    sentences.push(
      `Issues authored by the connected account and seen in the scanned window: ${activity.issuesAuthored}.`,
    );
  }

  return sentences;
}

/**
 * The human-readable title: the repository's full name, verbatim.
 *
 * Identity, not a claim. No verb is added in front of it, because every
 * verb available - built, created, maintained, contributed to - asserts
 * a relationship GitHub did not report. Presence in a sync means the
 * account can see the repository; it does not say who wrote it.
 *
 * The full name rather than the short name so that two repositories
 * called "api" belonging to different accounts are distinguishable in a
 * list. Note that the title carries GitHub's own text: if an account has
 * a repository literally called "senior-tools", that word appears here.
 * That is a name being reported, not a claim being made, and sanitizing
 * it would misidentify the repository.
 */
export function repositoryEvidenceTitle(
  repo: RepositoryObservation,
): string {
  return repo.fullName;
}

/**
 * The description: observed facts, each qualified by what was actually
 * looked at, in a fixed sentence order so the string is deterministic.
 *
 * The repository's own GitHub description is deliberately NOT quoted
 * here. It is free text written by whoever set it up, it frequently
 * contains exactly the marketing language this layer must not carry, and
 * repeating it inside our description would present someone else's claim
 * as our observation. It is preserved verbatim in metadata instead, so
 * nothing is lost.
 */
export function repositoryEvidenceDescription(
  repo: RepositoryObservation,
): string {
  const sentences: string[] = [
    `GitHub repository ${repo.fullName}.`,
  ];

  /*
   * Stated as "does not report it as public" rather than "private",
   * because the observation collapsed GitHub's three-valued visibility
   * (public | private | internal) to a boolean. Calling a non-public
   * repository private would assert the specific value we no longer
   * have.
   */
  sentences.push(
    repo.isPublic
      ? 'GitHub reports it as public.'
      : 'GitHub does not report it as public.',
  );

  if (repo.isFork) {
    sentences.push(
      'GitHub marks it as a fork.',
    );
  }

  if (repo.isArchived) {
    sentences.push(
      'GitHub marks it as archived.',
    );
  }

  if (repo.isDisabled) {
    sentences.push(
      'GitHub marks it as disabled.',
    );
  }

  const languages = languageClause(
    repo.languages,
  );

  if (languages !== null) {
    sentences.push(languages);
  }

  sentences.push(...commitClause(repo));
  sentences.push(
    ...authoredClauses(repo.activity),
  );

  return sentences.join(' ');
}

/*
 * Freezes a metadata object into canonical form.
 *
 * canonicalJson sorts keys recursively and preserves array order, so
 * parsing its output back gives an object whose OWN key order is
 * canonical too. That matters because the persistence layer serializes
 * this object again on the way into a jsonb column: without this step
 * two structurally identical runs could still write different bytes and
 * a re-sync would look like an edit.
 *
 * It also throws on NaN, Infinity and anything unserializable, so a
 * corrupt count fails here rather than silently persisting as null.
 */
function freezeMetadata(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return JSON.parse(
    canonicalJson(value),
  ) as Record<string, unknown>;
}

/**
 * Which projection produced a row.
 *
 * Bumped whenever the shape or meaning of what this file emits changes,
 * so a row written by an older projection is findable and re-derivable
 * rather than silently mixed in with current ones.
 */
export const EVIDENCE_TRANSFORM_VERSION = 1;

/*
 * The two completeness states that mean we did NOT successfully observe
 * this repository on this run. Named here to match the persistence
 * layer's NON_OBSERVING set, which gates the merge for the same reason.
 */
const NOT_OBSERVED = new Set(['NOT_SCANNED', 'ACCESS_LOST']);

/**
 * GitHub's three-value completeness, widened into the universal enum.
 *
 * DEFAULT_BRANCH_ONLY becomes PARTIAL because that is exactly what it
 * means: the repository WAS scanned, and the counts are lower bounds
 * since only the default branch is visible through that endpoint. It does
 * not become COMPLETE, and the input type makes COMPLETE unrepresentable
 * here so it cannot start doing so.
 */
function contractCompleteness(
  commits: string,
): 'PARTIAL' | 'NOT_SCANNED' | 'ACCESS_LOST' {
  if (commits === 'NOT_SCANNED') {
    return 'NOT_SCANNED';
  }

  if (commits === 'ACCESS_LOST') {
    return 'ACCESS_LOST';
  }

  return 'PARTIAL';
}

/**
 * When this repository was SUCCESSFULLY re-observed, or null.
 *
 * Two conditions, and the second is the subtle one.
 *
 * The repository must have been scanned at all - NOT_SCANNED and
 * ACCESS_LOST are not observations.
 *
 * AND the run's cross-repository authored-activity query must have
 * succeeded. It runs once per sync and supplies every repository's pull
 * request and issue counts, so when it fails each repository was listed
 * and yet part of its activity was never established. Heartbeating then
 * would record "verified" over evidence a whole dimension of which we
 * failed to read - the run happened, the observation did not.
 */
function observedAt(
  repo: RepositoryObservation,
  sync: SyncObservation,
): Date | null {
  if (NOT_OBSERVED.has(repo.completeness.commits)) {
    return null;
  }

  if (!sync.completeness.authoredActivityEstablished) {
    return null;
  }

  return syncCapturedAt(sync);
}

/**
 * Projects one repository observation into one Evidence input.
 *
 * The sync is passed alongside the repository because two facts about
 * the row are properties of the RUN rather than of the repository: the
 * capture instant, and how much of the account was covered. A count
 * read without knowing that 12 of 40 repositories were scanned is a
 * count read wrongly.
 */
export function projectRepositoryEvidence(
  repo: RepositoryObservation,
  sync: SyncObservation,
): EvidenceInput {
  const metadata = freezeMetadata({
    provider: 'github',

    /*
     * Whose view produced this. Public account identity only - the id
     * and the login. No token, no header, no raw response body: nothing
     * a credential could hide inside ever reaches metadata, because
     * metadata is the field most likely to be dumped into a log or an
     * export.
     */
    account: {
      accountId: sync.account.accountId,
      login: sync.account.login,
    },

    /*
     * Repository facts as observed. fullName, htmlUrl and name all move
     * under a rename and are refreshed every sync; repoId does not, and
     * is the only one identity is keyed on.
     */
    repository: {
      repoId: repo.repoId,
      nodeId: repo.nodeId,
      name: repo.name,
      fullName: repo.fullName,
      htmlUrl: repo.htmlUrl,
      owner: {
        id: repo.owner.id,
        login: repo.owner.login,
        type: repo.owner.type,
      },
      isPublic: repo.isPublic,
      isFork: repo.isFork,
      isArchived: repo.isArchived,
      isDisabled: repo.isDisabled,
      defaultBranch: repo.defaultBranch,
      description: repo.description,
      sizeKb: repo.sizeKb,
      createdAt: repo.createdAt,
      updatedAt: repo.updatedAt,
      pushedAt: repo.pushedAt,
    },

    /*
     * Copied entry by entry in the order the observation carries, never
     * re-sorted and never re-spelled.
     */
    languages: repo.languages.map(
      (language) => ({
        name: language.name,
        bytes: language.bytes,
      }),
    ),

    /*
     * Counts exactly as observed. null stays null. No `?? 0` may ever
     * appear here: it would convert "we did not look" into "this person
     * did nothing".
     */
    activity: {
      commitsAttributed:
        repo.activity.commitsAttributed,
      pullRequestsAuthored:
        repo.activity.pullRequestsAuthored,
      issuesAuthored:
        repo.activity.issuesAuthored,
      firstActivityAt:
        repo.activity.firstActivityAt,
      lastActivityAt:
        repo.activity.lastActivityAt,
    },

    /*
     * The completeness contract, in the shape Phase 7.0 fixed: the
     * repository's own record, plus the two run-level numbers that say
     * how much of the account this row was drawn from. No consumer may
     * present a count from this row without reading these.
     */
    completeness: {
      commits: repo.completeness.commits,
      scannedSince:
        repo.completeness.scannedSince,
      scannedAt: repo.completeness.scannedAt,
      /*
       * How the count survived a run that did not re-derive it. null when
       * it was read from GitHub this run. Recorded because the basis is
       * falsifiable and the count is not - it is what makes it possible
       * to find and re-derive every count resting on the weaker signal.
       */
      revalidatedBy:
        repo.completeness.revalidatedBy,
      truncated: repo.completeness.truncated,
      reposScanned:
        sync.completeness.reposScanned,
      reposTotal: sync.completeness.reposTotal,
      /*
       * Distinct from `truncated` above, which is about this
       * repository's own pagination. This one says the LISTING hit a
       * ceiling, so there are repositories that were never enumerated
       * at all - invisible in reposTotal, and therefore invisible to a
       * reposScanned >= reposTotal check on its own.
       */
      listingTruncated:
        sync.completeness.truncated,
    },
  });



  return {
    sourceType: 'GITHUB',

    /*
     * Taken from the observation rather than rebuilt here. It is derived
     * from the immutable numeric id ("github:repo:<id>"); name, fullName,
     * htmlUrl and nodeId all move under a rename or transfer, and keying
     * on any of them would make a renamed repository look like a new one
     * and duplicate its evidence on the next sync.
     */
    externalId: repo.externalId,

    title: repositoryEvidenceTitle(repo),
    description:
      repositoryEvidenceDescription(repo),

    /* Display and verification. Never identity. */
    sourceUrl: repo.htmlUrl,

    occurredAt: repositoryOccurredAt(repo),
    capturedAt: syncCapturedAt(sync),
    metadata,

    /*
     * The reliability contract, declared rather than inferred.
     *
     * authenticity and attribution are constants because they are
     * properties of HOW this producer works, not of any particular
     * repository: every row here came from GitHub's API under the user's
     * authorization, and observations/attribution.ts already refuses to
     * attribute anything GitHub did not resolve to the authenticated
     * account by numeric id.
     */
    authenticity: 'DIRECT_API_OBSERVATION',
    attribution: 'AUTHENTICATED_ACCOUNT',
    completeness: contractCompleteness(repo.completeness.commits),
    lastObservedAt: observedAt(repo, sync),
    transformVersion: EVIDENCE_TRANSFORM_VERSION,

    /*
     * Built from the account id, never the login. A login is mutable and
     * re-assignable, so keying independence on it would split one source
     * in two on a rename and merge two people into one on a
     * re-registration. Fourteen repositories therefore share one key -
     * they are fourteen observations of a single source.
     */
    independenceKey: independenceKeyFor({
      kind: 'github',
      authenticatedAccountId: sync.account.accountId,
    }),
  };
}

/**
 * Projects a whole sync into its Evidence inputs - one per repository.
 *
 * Two properties this guarantees beyond mapping:
 *
 *   - Duplicates collapse. GitHub's paginated listings can repeat an
 *     entry when the underlying set changes mid-walk, and two rows
 *     sharing an externalId would collide on the upsert key. The FIRST
 *     occurrence wins, so the result does not depend on how far through
 *     a page the duplicate turned up.
 *   - Order is by numeric repository id ascending. That is not a new
 *     decision - it is the ordering normalize.ts already establishes -
 *     but re-applying it here means a caller who hands the repositories
 *     in a different order still gets a byte-identical result, rather
 *     than one that happens to be right because an upstream step was.
 */
export function projectSyncEvidence(
  sync: SyncObservation,
): EvidenceInput[] {
  const byRepoId = new Map<
    string,
    RepositoryObservation
  >();

  for (const repo of sync.repositories) {
    if (!byRepoId.has(repo.repoId)) {
      byRepoId.set(repo.repoId, repo);
    }
  }

  return [...byRepoId.values()]
    .sort((a, b) => {
      /*
       * Numeric, not lexical: string order would put "1000" before
       * "999", which is stable but arbitrary. The ids are safe integers
       * by construction in normalize.ts.
       */
      return Number(a.repoId) - Number(b.repoId);
    })
    .map((repo) =>
      projectRepositoryEvidence(repo, sync),
    );
}
