import { describe, expect, it } from 'vitest';

import { independenceKeyFor } from './independence.js';

/*
 * Independence is the one dimension a trust system can inflate without
 * anyone lying, so these tests are mostly about what must NOT produce a
 * new key.
 */

const IMPORT = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACCOUNT = '555';

describe('one resume import is one source', () => {
  it('gives the same key every time for the same import', () => {
    expect(
      independenceKeyFor({ kind: 'resume', resumeImportId: IMPORT }),
    ).toBe(`resume:${IMPORT}`);

    expect(
      independenceKeyFor({ kind: 'resume', resumeImportId: IMPORT }),
    ).toBe(
      independenceKeyFor({ kind: 'resume', resumeImportId: IMPORT }),
    );
  });

  /*
   * The Phase 6 freeze warns that scoring the Evidence joins would be
   * "counting imports rather than facts". One resume can produce forty
   * EvidenceSkill rows; the function cannot see them, and that is the
   * point - the guarantee is structural, not remembered.
   */
  it('does not change however many career-graph joins the import produced', () => {
    const keys = new Set(
      Array.from({ length: 40 }, () =>
        independenceKeyFor({ kind: 'resume', resumeImportId: IMPORT }),
      ),
    );

    expect(keys.size).toBe(1);
  });

  it('distinguishes two different imports', () => {
    expect(
      independenceKeyFor({
        kind: 'resume',
        resumeImportId: 'bbbbbbbb-0000-0000-0000-000000000002',
      }),
    ).not.toBe(`resume:${IMPORT}`);
  });

  it('refuses an id that is not a uuid, rather than inventing a key', () => {
    for (const bad of ['', '   ', 'not-a-uuid', '12345', 'DROP TABLE']) {
      expect(
        independenceKeyFor({ kind: 'resume', resumeImportId: bad }),
      ).toBeNull();
    }
  });

  /* Postgres renders uuid::text lowercase; the backfill wrote it that way. */
  it('normalises case so it agrees with the migration byte for byte', () => {
    expect(
      independenceKeyFor({
        kind: 'resume',
        resumeImportId: IMPORT.toUpperCase(),
      }),
    ).toBe(`resume:${IMPORT}`);
  });
});

describe('one authenticated GitHub account is one source', () => {
  it('gives one key across every repository that account owns', () => {
    /*
     * Fourteen repositories - the number the live verification actually
     * observed. They are fourteen observations of ONE source, and the
     * function has no repository parameter with which to say otherwise.
     */
    const keys = new Set(
      Array.from({ length: 14 }, () =>
        independenceKeyFor({
          kind: 'github',
          authenticatedAccountId: ACCOUNT,
        }),
      ),
    );

    expect(keys.size).toBe(1);
    expect([...keys]).toEqual([`github:${ACCOUNT}`]);
  });

  it('distinguishes two different accounts', () => {
    expect(
      independenceKeyFor({
        kind: 'github',
        authenticatedAccountId: '999',
      }),
    ).not.toBe(`github:${ACCOUNT}`);
  });

  /*
   * THE attribution rule, restated for independence. A login is mutable
   * and re-assignable; an email is whatever someone typed into a git
   * config. Accepting either would let a rename split one source into
   * two, or let two people merge into one.
   */
  it('refuses a login, email, display name or commit author as identity', () => {
    for (const bad of [
      'octocat',
      'octocat@example.com',
      'Octo Cat',
      'Octo Cat <octo@example.com>',
      'user-555',
      '555a',
      '',
      '  ',
    ]) {
      expect(
        independenceKeyFor({
          kind: 'github',
          authenticatedAccountId: bad,
        }),
      ).toBeNull();
    }
  });

  it('accepts an int64-scale numeric id', () => {
    expect(
      independenceKeyFor({
        kind: 'github',
        authenticatedAccountId: '9223372036854775807',
      }),
    ).toBe('github:9223372036854775807');
  });
});

describe('sources cannot collide', () => {
  it('never produces the same key for a resume and a github account', () => {
    const resume = independenceKeyFor({
      kind: 'resume',
      resumeImportId: IMPORT,
    });
    const github = independenceKeyFor({
      kind: 'github',
      authenticatedAccountId: ACCOUNT,
    });

    expect(resume).not.toBe(github);
  });

  /*
   * Two users' evidence never shares a key, because the identifiers
   * themselves differ: a resume import belongs to one user, and two
   * people cannot hold the same GitHub account id. The key carries no
   * userId of its own - identity is enforced at the query, and this
   * module is deliberately unable to reason about whose evidence it is.
   */
  it('separates two users by the identifiers they cannot share', () => {
    const mine = independenceKeyFor({
      kind: 'resume',
      resumeImportId: IMPORT,
    });
    const theirs = independenceKeyFor({
      kind: 'resume',
      resumeImportId: 'cccccccc-0000-0000-0000-000000000003',
    });

    expect(mine).not.toBe(theirs);
  });
});
