/*
 * Who did GitHub say made this?
 *
 * The rule, stated once and enforced here: an artifact counts as the
 * user's only when GitHub itself links it to the authenticated ACCOUNT,
 * identified by numeric id. Nothing else qualifies.
 *
 * The temptation this exists to resist is the git author email. A commit
 * object carries two different notions of authorship and they are not the
 * same fact:
 *
 *   commit.author        - git metadata. A name and an email typed into a
 *                          local git config. Entirely unauthenticated:
 *                          anyone can author a commit as anyone, and
 *                          rewriting history to claim someone else's
 *                          identity takes one command.
 *   author (top level)   - the GitHub ACCOUNT GitHub resolved the commit
 *                          to. Null when GitHub cannot resolve one.
 *
 * Only the second is evidence. Matching on the first would let any person
 * on earth manufacture "evidence" of our user's work, or - more likely and
 * more quietly - attribute a colleague's commits to them because two people
 * shared a machine or a CI account used a shared address.
 *
 * The same reasoning rules out the other tempting shortcuts:
 *
 *   - Repository ownership proves the account created a repository. It
 *     says nothing about who wrote what is inside it.
 *   - Repository membership proves access, not authorship.
 *   - Login similarity and display-name similarity prove nothing at all.
 *
 * We ALSO do not trust our own query. Asking GitHub for
 * `?author={login}` narrows the result server-side, but login is a
 * mutable, re-assignable handle, and a rename between the query being
 * built and the response being read would silently change who the filter
 * meant. Every returned artifact is therefore re-checked here against the
 * numeric account id - the query is an optimisation, the check is the
 * control.
 */

function readNestedId(
  value: unknown,
  key: string,
): string | null {
  if (
    typeof value !== 'object' ||
    value === null
  ) {
    return null;
  }

  const nested = (
    value as Record<string, unknown>
  )[key];

  if (
    typeof nested !== 'object' ||
    nested === null
  ) {
    return null;
  }

  const id = (nested as Record<string, unknown>)[
    'id'
  ];

  /*
   * isSafeInteger rather than a truthiness check. GitHub types account
   * ids as int64 and JSON.parse yields a double, so a value past 2^53
   * would arrive already rounded - and a rounded id could collide with a
   * different account. Refusing to attribute is the safe failure.
   */
  if (
    typeof id !== 'number' ||
    !Number.isSafeInteger(id)
  ) {
    return null;
  }

  return String(id);
}

/**
 * True only when GitHub resolved this commit to the given account.
 *
 * A commit whose `author` is null is NOT attributed. That is common and
 * expected - GitHub cannot resolve an account for a commit written with
 * an email that is not registered - and it means the count is a lower
 * bound, which the completeness contract already says it is.
 */
export function isCommitAttributedTo(
  commit: unknown,
  accountId: string,
): boolean {
  return (
    readNestedId(commit, 'author') === accountId
  );
}

/**
 * True only when GitHub records the given account as the author.
 *
 * Used for issues and pull requests alike: GitHub's issues endpoints
 * return both, and both carry the author under `user`.
 */
export function isAuthoredBy(
  item: unknown,
  accountId: string,
): boolean {
  return (
    readNestedId(item, 'user') === accountId
  );
}

/**
 * Whether an issues-endpoint item is a pull request.
 *
 * GitHub's own framing: every pull request is an issue, but not every
 * issue is a pull request, and the two are told apart by the presence of
 * a `pull_request` key. Note the id in that payload is an ISSUE id, so it
 * must never be used where a pull request id is meant.
 */
export function isPullRequest(
  item: unknown,
): boolean {
  return (
    typeof item === 'object' &&
    item !== null &&
    'pull_request' in
      (item as Record<string, unknown>)
  );
}

/**
 * The repository an issues-endpoint item belongs to, by numeric id.
 *
 * Returned as an id rather than a name so activity is joined to
 * repositories the same way everything else is - by the immutable
 * identifier, never by `full_name`.
 */
export function repositoryIdOf(
  item: unknown,
): string | null {
  return readNestedId(item, 'repository');
}
