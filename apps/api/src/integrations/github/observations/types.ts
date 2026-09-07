/*
 * The normalized source-observation model.
 *
 * This is the boundary between "what GitHub said" and "what Career OS
 * records". Everything here is an OBSERVATION: a statement about what
 * GitHub reports, timestamped and attributed, carrying no judgement about
 * what it means. Nothing in this file may express skill, seniority,
 * expertise, employment, ownership or title - not because those are hard
 * to compute, but because GitHub cannot support them and a field that
 * exists will eventually be filled in.
 *
 * Phase 7.3 produces these. Phase 7.4 turns them into Evidence rows. The
 * split is deliberate: this layer is pure, so it can be tested without
 * HTTP or a database, and the tests that matter most here - determinism
 * and attribution - are exactly the ones that a network stub would make
 * meaningless.
 */

/** A GitHub language name, verbatim, with the byte count GitHub reported. */
export type LanguageObservation = {
  /*
   * Exactly as GitHub spells it. Not normalized, not mapped to a Skill,
   * not lowercased. "Jupyter Notebook" stays "Jupyter Notebook" and
   * "C++" stays "C++": the moment this layer starts tidying names it is
   * making an ontology decision, and that decision belongs to a Market
   * Graph that does not exist yet.
   */
  name: string;
  bytes: number;
};

/*
 * Why commit counts can be absent rather than zero.
 *
 * DEFAULT_BRANCH_ONLY - the repository was scanned. The count is a LOWER
 *   BOUND: only the default branch is visible through this endpoint, so
 *   work merged from other branches is invisible unless it landed there.
 * NOT_SCANNED       - the repository was not looked at, because the sync
 *   ran out of budget. This is NOT zero activity, and no consumer may
 *   render it as such.
 * ACCESS_LOST       - the repository was reachable before and is not now.
 *   The evidence was true when captured; the observation is retained and
 *   marked stale rather than deleted.
 */
export type CommitCompleteness =
  | 'DEFAULT_BRANCH_ONLY'
  | 'NOT_SCANNED'
  | 'ACCESS_LOST';

export type RepositoryCompleteness = {
  commits: CommitCompleteness;
  /** Lower bound of the scanned window; null means "since repo creation". */
  scannedSince: string | null;
  scannedAt: string;
  /** A pagination ceiling was reached, so counts are short of the truth. */
  truncated: boolean;
};

/*
 * Counts of artifacts GitHub attributes to the authenticated ACCOUNT.
 *
 * null means "not established", never "none". A consumer that renders
 * null as 0 turns "we did not look" into "this person did nothing", which
 * is the single most defamatory mistake this system could make with a
 * user's own data.
 */
export type ActivityObservation = {
  commitsAttributed: number | null;
  pullRequestsAuthored: number | null;
  issuesAuthored: number | null;
  /** Earliest and latest attributed artifact seen in the scanned window. */
  firstActivityAt: string | null;
  lastActivityAt: string | null;
};

export type RepositoryOwnerObservation = {
  id: string;
  login: string;
  type: string | null;
};

export type RepositoryObservation = {
  /*
   * The deterministic external identity. Built from the numeric id and
   * nothing else, because it is the only identifier GitHub treats as
   * immutable: logins are renameable and reusable, and full_name and
   * html_url both follow the name.
   */
  externalId: string;
  /** Numeric repository id, held as text to avoid float precision issues. */
  repoId: string;
  /*
   * Reconciliation and display only. node_id is mid-format-migration and
   * is treated as an opaque string; full_name and html_url are refreshed
   * on every sync because they can change under a rename.
   */
  nodeId: string | null;
  name: string;
  fullName: string;
  htmlUrl: string;
  owner: RepositoryOwnerObservation;

  isPublic: boolean;
  isFork: boolean;
  isArchived: boolean;
  isDisabled: boolean;

  defaultBranch: string | null;
  description: string | null;
  sizeKb: number | null;

  createdAt: string | null;
  updatedAt: string | null;
  pushedAt: string | null;

  languages: LanguageObservation[];
  activity: ActivityObservation;
  completeness: RepositoryCompleteness;
};

/** The account the observations are attributed to. */
export type AccountObservation = {
  accountId: string;
  login: string;
};

export type SyncCompleteness = {
  reposScanned: number;
  reposTotal: number;
  scannedAt: string;
  scannedSince: string | null;
  /** The repository listing itself hit a page ceiling. */
  truncated: boolean;
};

export type SyncObservation = {
  account: AccountObservation;
  repositories: RepositoryObservation[];
  completeness: SyncCompleteness;
};
