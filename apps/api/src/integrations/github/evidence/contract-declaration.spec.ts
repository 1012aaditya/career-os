import { describe, expect, it } from 'vitest';

import type {
  RepositoryObservation,
  SyncObservation,
} from '../observations/types.js';
import {
  EVIDENCE_TRANSFORM_VERSION,
  projectRepositoryEvidence,
} from './evidence-projection.js';

/*
 * What the GitHub producer DECLARES about its own evidence.
 *
 * Phase 7 already held every one of these properties - it simply had
 * nowhere to write them down except a metadata blob only this adapter can
 * read. These tests are about the declaration being true, and in
 * particular about the two ways it could become a lie: claiming stronger
 * coverage than was obtained, and claiming a fresh observation when the
 * run did not actually make one.
 *
 * Fixtures are written out in full here rather than borrowed from
 * evidence-projection.spec.ts, whose sync fixture predates
 * `authoredActivityEstablished` and leaves it undefined. Inheriting that
 * gap would silently pin every case below to the "activity query failed"
 * branch and make the freshness tests agree with the wrong thing.
 */

const SCANNED_AT = '2026-09-07T12:00:00.000Z';
const ACCOUNT_ID = '4820193';

function repo(
  overrides: Partial<RepositoryObservation> = {},
): RepositoryObservation {
  return {
    externalId: 'github:repo:515187740',
    repoId: '515187740',
    nodeId: 'R_kgDOHqK9xA',
    name: 'payments-service',
    fullName: 'acme-corp/payments-service',
    htmlUrl: 'https://github.com/acme-corp/payments-service',
    owner: {
      id: '583231',
      login: 'acme-corp',
      type: 'Organization',
    },
    isPublic: true,
    isFork: false,
    isArchived: false,
    isDisabled: false,
    defaultBranch: 'main',
    description: 'Handles settlement',
    sizeKb: 4821,
    createdAt: '2024-03-15T10:23:45.000Z',
    updatedAt: '2026-09-01T11:00:00.000Z',
    pushedAt: '2026-08-30T09:12:00.000Z',
    languages: [{ name: 'TypeScript', bytes: 184320 }],
    activity: {
      commitsAttributed: 42,
      pullRequestsAuthored: 3,
      issuesAuthored: 1,
    },
    completeness: {
      commits: 'DEFAULT_BRANCH_ONLY',
      scannedSince: null,
      scannedAt: SCANNED_AT,
      truncated: false,
      revalidatedBy: null,
    },
    ...overrides,
  };
}

function sync(
  repositories: RepositoryObservation[],
  completeness: Partial<SyncObservation['completeness']> = {},
  account: Partial<SyncObservation['account']> = {},
): SyncObservation {
  return {
    account: {
      accountId: ACCOUNT_ID,
      login: 'octo-dev',
      ...account,
    },
    repositories,
    completeness: {
      reposScanned: 12,
      reposTotal: 40,
      scannedAt: SCANNED_AT,
      scannedSince: null,
      truncated: false,
      authoredActivityEstablished: true,
      ...completeness,
    },
  };
}

const project = (
  overrides: Partial<RepositoryObservation> = {},
  completeness: Partial<SyncObservation['completeness']> = {},
  account: Partial<SyncObservation['account']> = {},
) => {
  const repository = repo(overrides);

  return projectRepositoryEvidence(
    repository,
    sync([repository], completeness, account),
  );
};

describe('the contract a GitHub row declares', () => {
  it('declares a direct observation attributed to the authenticated account', () => {
    const input = project();

    expect(input.authenticity).toBe('DIRECT_API_OBSERVATION');
    expect(input.attribution).toBe('AUTHENTICATED_ACCOUNT');
    expect(input.transformVersion).toBe(EVIDENCE_TRANSFORM_VERSION);
    expect(input.transformVersion).toBe(1);
    expect(input.independenceKey).toBe(`github:${ACCOUNT_ID}`);
  });

  /*
   * DEFAULT_BRANCH_ONLY is a scanned repository whose counts are lower
   * bounds. PARTIAL says exactly that. COMPLETE would say the whole
   * repository was seen, which no GitHub endpoint this producer uses can
   * establish - and the input type makes COMPLETE unrepresentable so it
   * cannot start being claimed by accident.
   */
  it('maps GitHub completeness without ever claiming COMPLETE', () => {
    expect(
      project({
        completeness: { ...repo().completeness, commits: 'DEFAULT_BRANCH_ONLY' },
      }).completeness,
    ).toBe('PARTIAL');

    expect(
      project({
        completeness: { ...repo().completeness, commits: 'NOT_SCANNED' },
      }).completeness,
    ).toBe('NOT_SCANNED');

    expect(
      project({
        completeness: { ...repo().completeness, commits: 'ACCESS_LOST' },
      }).completeness,
    ).toBe('ACCESS_LOST');
  });

  it('preserves truncation in the completeness record it already kept', () => {
    const input = project({
      completeness: { ...repo().completeness, truncated: true },
    });

    /* Still an observation - truncation bounds it, it does not void it. */
    expect(input.completeness).toBe('PARTIAL');
    expect(
      (input.metadata['completeness'] as Record<string, unknown>)[
        'truncated'
      ],
    ).toBe(true);
  });
});

describe('independence comes from the account, not from names', () => {
  it('uses the authenticated numeric account id', () => {
    expect(project().independenceKey).toBe('github:4820193');
  });

  it('gives every repository of one account the same key', () => {
    const repositories = [
      repo({ externalId: 'github:repo:1', repoId: '1' }),
      repo({ externalId: 'github:repo:2', repoId: '2' }),
      repo({ externalId: 'github:repo:3', repoId: '3' }),
    ];

    const observation = sync(repositories);

    const keys = new Set(
      repositories.map(
        (repository) =>
          projectRepositoryEvidence(repository, observation)
            .independenceKey,
      ),
    );

    expect(keys.size).toBe(1);
    expect([...keys]).toEqual([`github:${ACCOUNT_ID}`]);
  });

  it('gives different accounts different keys', () => {
    expect(project({}, {}, { accountId: '999999' }).independenceKey).toBe(
      'github:999999',
    );
  });

  /*
   * The login is mutable and re-assignable, the owner login belongs to an
   * organisation rather than the user, and neither is identity. Changing
   * every one of them must leave the key alone.
   */
  it('is unaffected by login, owner or repository name', () => {
    const renamed = project(
      {
        name: 'renamed',
        fullName: 'someone-else/renamed',
        htmlUrl: 'https://github.com/someone-else/renamed',
        owner: { id: '1', login: 'someone-else', type: 'User' },
      },
      {},
      { login: 'a-completely-different-login' },
    );

    expect(renamed.independenceKey).toBe(`github:${ACCOUNT_ID}`);
    expect(renamed.attribution).toBe('AUTHENTICATED_ACCOUNT');
  });

  it('refuses a non-numeric account id rather than keying on it', () => {
    expect(
      project({}, {}, { accountId: 'octo-dev' }).independenceKey,
    ).toBeNull();

    expect(
      project({}, {}, { accountId: 'octo@example.com' }).independenceKey,
    ).toBeNull();
  });
});

describe('lastObservedAt is a claim of successful observation', () => {
  it('is set when the repository was scanned and the run was whole', () => {
    expect(project().lastObservedAt?.toISOString()).toBe(SCANNED_AT);
  });

  it('is null when the repository was not scanned', () => {
    expect(
      project({
        completeness: { ...repo().completeness, commits: 'NOT_SCANNED' },
      }).lastObservedAt,
    ).toBeNull();
  });

  /*
   * Access loss is the case where a false heartbeat would be most
   * damaging: the row keeps its historical observation, and stamping it
   * "verified today" would assert we can still see something we cannot.
   */
  it('is null when access to the repository was lost', () => {
    expect(
      project({
        completeness: { ...repo().completeness, commits: 'ACCESS_LOST' },
      }).lastObservedAt,
    ).toBeNull();
  });

  /*
   * The authored-activity query runs once per sync and supplies every
   * repository's pull-request and issue counts. When it fails, each
   * repository was listed and yet a whole dimension of its activity was
   * never established - the run happened, the observation did not.
   */
  it('is null when the authored-activity query failed, even though the repo was scanned', () => {
    const input = project(
      {},
      { authoredActivityEstablished: false },
    );

    expect(input.completeness).toBe('PARTIAL');
    expect(input.lastObservedAt).toBeNull();
  });

  it('does not read a failed run as a fresh one just because time passed', () => {
    const later = project(
      {},
      {
        authoredActivityEstablished: false,
        scannedAt: '2027-01-01T00:00:00.000Z',
      },
    );

    expect(later.lastObservedAt).toBeNull();
  });
});

describe('determinism', () => {
  it('projects byte-identical contract values twice over one observation', () => {
    const repository = repo();
    const observation = sync([repository]);

    const a = projectRepositoryEvidence(repository, observation);
    const b = projectRepositoryEvidence(repository, observation);

    expect({
      authenticity: a.authenticity,
      attribution: a.attribution,
      completeness: a.completeness,
      transformVersion: a.transformVersion,
      independenceKey: a.independenceKey,
      lastObservedAt: a.lastObservedAt?.toISOString() ?? null,
    }).toEqual({
      authenticity: b.authenticity,
      attribution: b.attribution,
      completeness: b.completeness,
      transformVersion: b.transformVersion,
      independenceKey: b.independenceKey,
      lastObservedAt: b.lastObservedAt?.toISOString() ?? null,
    });
  });

  it('changes only lastObservedAt when the same run is repeated later', () => {
    const repository = repo();

    const first = projectRepositoryEvidence(
      repository,
      sync([repository]),
    );
    const second = projectRepositoryEvidence(
      repository,
      sync([repository], { scannedAt: '2026-10-01T09:00:00.000Z' }),
    );

    expect(second.authenticity).toBe(first.authenticity);
    expect(second.attribution).toBe(first.attribution);
    expect(second.completeness).toBe(first.completeness);
    expect(second.transformVersion).toBe(first.transformVersion);
    expect(second.independenceKey).toBe(first.independenceKey);
    expect(second.externalId).toBe(first.externalId);

    expect(second.lastObservedAt?.toISOString()).toBe(
      '2026-10-01T09:00:00.000Z',
    );
  });
});
