import {
  isAuthoredBy,
  isCommitAttributedTo,
  isPullRequest,
  repositoryIdOf,
} from './attribution.js';
import { canonicalJson } from './canonical-json.js';

const ACCOUNT = '583231';
const OTHER = '999999';

/*
 * A commit as GitHub returns it. Note the two different authorships: the
 * top-level `author` is the resolved GitHub ACCOUNT, and `commit.author`
 * is unauthenticated git metadata that anyone can write.
 */
function commit(
  overrides: Record<string, unknown> = {},
) {
  return {
    sha: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432',
    commit: {
      author: {
        name: 'The User',
        email: 'user@example.com',
        date: '2024-06-02T14:31:09Z',
      },
      message: 'fix: rounding',
    },
    author: { id: 583231, login: 'octocat' },
    ...overrides,
  };
}

describe('commit attribution', () => {
  it('attributes a commit GitHub resolved to the account', () => {
    expect(
      isCommitAttributedTo(commit(), ACCOUNT),
    ).toBe(true);
  });

  it('does not attribute a commit resolved to a different account', () => {
    expect(
      isCommitAttributedTo(
        commit({
          author: { id: 999999, login: 'someone' },
        }),
        ACCOUNT,
      ),
    ).toBe(false);
  });

  /*
   * The most important test in this file.
   *
   * Git author metadata is unauthenticated - anyone can commit as anyone,
   * and rewriting history to claim an identity takes one command. If this
   * ever returns true, a stranger can manufacture evidence of our user's
   * work, and a shared machine or CI account can silently attribute a
   * colleague's commits to them.
   */
  it('refuses to attribute on git author email alone', () => {
    const unresolved = commit({
      /* GitHub could not resolve an account... */
      author: null,
      /* ...even though the git metadata names our user. */
      commit: {
        author: {
          name: 'The User',
          email: 'user@example.com',
          date: '2024-06-02T14:31:09Z',
        },
      },
    });

    expect(
      isCommitAttributedTo(unresolved, ACCOUNT),
    ).toBe(false);
  });

  it('refuses to attribute on committer identity', () => {
    expect(
      isCommitAttributedTo(
        commit({
          author: null,
          committer: {
            id: 583231,
            login: 'octocat',
          },
        }),
        ACCOUNT,
      ),
    ).toBe(false);
  });

  it('refuses to attribute on login rather than numeric id', () => {
    /*
     * A login is renameable and, once released, claimable by someone
     * else, so a login match is not an identity match.
     */
    expect(
      isCommitAttributedTo(
        commit({
          author: { id: 999999, login: 'octocat' },
        }),
        ACCOUNT,
      ),
    ).toBe(false);
  });

  it('refuses a rounded or malformed account id', () => {
    for (const id of [
      Number.MAX_SAFE_INTEGER + 2,
      'not-a-number',
      null,
      undefined,
      1.5,
    ]) {
      expect(
        isCommitAttributedTo(
          commit({ author: { id } }),
          ACCOUNT,
        ),
      ).toBe(false);
    }
  });

  it('refuses malformed commit payloads without throwing', () => {
    for (const value of [
      null,
      undefined,
      'string',
      42,
      [],
      {},
      { author: 'octocat' },
    ]) {
      expect(
        isCommitAttributedTo(value, ACCOUNT),
      ).toBe(false);
    }
  });

  it('is not satisfied by an empty account id', () => {
    expect(
      isCommitAttributedTo(
        commit({ author: {} }),
        '',
      ),
    ).toBe(false);
  });
});

describe('issue and pull request authorship', () => {
  const item = (
    overrides: Record<string, unknown> = {},
  ) => ({
    id: 1,
    number: 7,
    user: { id: 583231, login: 'octocat' },
    repository: { id: 515187740 },
    ...overrides,
  });

  it('attributes an item authored by the account', () => {
    expect(
      isAuthoredBy(item(), ACCOUNT),
    ).toBe(true);
  });

  it('does not attribute an item authored by someone else', () => {
    expect(
      isAuthoredBy(
        item({ user: { id: 999999 } }),
        ACCOUNT,
      ),
    ).toBe(false);
  });

  /*
   * Merely being assigned, mentioned or subscribed is not authorship, and
   * GitHub's issues endpoint can return all of those. Only `user` is the
   * author.
   */
  it('does not attribute on assignee or mention', () => {
    expect(
      isAuthoredBy(
        item({
          user: { id: 999999 },
          assignee: { id: 583231 },
          assignees: [{ id: 583231 }],
        }),
        ACCOUNT,
      ),
    ).toBe(false);
  });

  it('identifies pull requests by the pull_request key', () => {
    expect(isPullRequest(item())).toBe(false);

    expect(
      isPullRequest(
        item({
          pull_request: {
            url: 'https://api.github.com/repos/a/b/pulls/7',
          },
        }),
      ),
    ).toBe(true);
  });

  it('reads the repository by numeric id, never by name', () => {
    expect(repositoryIdOf(item())).toBe(
      '515187740',
    );

    expect(
      repositoryIdOf(
        item({
          repository: {
            full_name: 'acme/thing',
          },
        }),
      ),
    ).toBeNull();

    expect(repositoryIdOf({})).toBeNull();
  });

  it('handles malformed items without throwing', () => {
    for (const value of [
      null,
      undefined,
      'x',
      [],
      { user: null },
    ]) {
      expect(
        isAuthoredBy(value, ACCOUNT),
      ).toBe(false);
      expect(() =>
        isPullRequest(value),
      ).not.toThrow();
      expect(() =>
        repositoryIdOf(value),
      ).not.toThrow();
    }
  });

  it('distinguishes two accounts that differ only by id', () => {
    expect(
      isAuthoredBy(
        item({
          user: { id: 999999, login: 'octocat' },
        }),
        ACCOUNT,
      ),
    ).toBe(false);

    expect(
      isAuthoredBy(
        item({
          user: { id: 583231, login: 'renamed' },
        }),
        ACCOUNT,
      ),
    ).toBe(true);

    expect(OTHER).not.toBe(ACCOUNT);
  });
});

describe('canonicalJson', () => {
  it('is independent of key insertion order', () => {
    expect(
      canonicalJson({ b: 1, a: 2, c: 3 }),
    ).toBe(canonicalJson({ c: 3, a: 2, b: 1 }));
  });

  it('sorts nested keys too', () => {
    expect(
      canonicalJson({
        outer: { z: 1, a: { y: 2, b: 3 } },
      }),
    ).toBe(
      '{"outer":{"a":{"b":3,"y":2},"z":1}}',
    );
  });

  /* Array order is meaning here, decided in normalize.ts. */
  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe(
      '[3,1,2]',
    );
  });

  it('treats an absent field and an undefined field alike', () => {
    expect(
      canonicalJson({ a: 1, b: undefined }),
    ).toBe(canonicalJson({ a: 1 }));
  });

  it('refuses values that cannot round-trip', () => {
    expect(() =>
      canonicalJson({ n: Number.NaN }),
    ).toThrow();

    expect(() =>
      canonicalJson({ n: Infinity }),
    ).toThrow();

    expect(() =>
      canonicalJson({ f: () => 1 }),
    ).toThrow();
  });
});
