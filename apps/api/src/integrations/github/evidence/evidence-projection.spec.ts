/*
 * These tests are the contract, not a smoke screen.
 *
 * The properties checked here are the ones whose failure would be
 * invisible in the product until it had already done damage: a re-sync
 * that reads as an edit, a renamed repository that duplicates itself, a
 * "not scanned" repository rendered as a person who did nothing, or a
 * sentence that quietly promotes a commit count into a claim about
 * seniority. Each of those is cheap to assert and expensive to discover
 * later, so each is asserted.
 */

import { canonicalJson } from '../observations/canonical-json.js';

/*
 * A JSON-safe view of projected inputs, for byte-comparison in tests.
 *
 * EvidenceInput carries real Date objects in occurredAt and capturedAt,
 * because those map onto Prisma DateTime columns. canonicalJson refuses
 * non-plain objects - deliberately, so that binary or a Date can never be
 * silently misrepresented on its way into the metadata column - so the
 * dates are converted here rather than the guard being loosened.
 *
 * Production never hits this: only `metadata` is canonicalized on the
 * write path, and metadata is plain data by construction.
 */
function comparable(
  inputs: ReturnType<typeof projectSyncEvidence>,
) {
  return canonicalJson(
    inputs.map((input) => ({
      ...input,
      occurredAt:
        input.occurredAt?.toISOString() ?? null,
      capturedAt:
        input.capturedAt.toISOString(),
    })),
  );
}
import type {
  ActivityObservation,
  RepositoryObservation,
  SyncObservation,
} from '../observations/types.js';
import {
  projectRepositoryEvidence,
  projectSyncEvidence,
  repositoryOccurredAt,
  syncCapturedAt,
} from './evidence-projection.js';

const SCANNED_AT = '2026-09-07T12:00:00.000Z';

const ACTIVITY: ActivityObservation = {
  commitsAttributed: 214,
  pullRequestsAuthored: 31,
  issuesAuthored: 7,
  firstActivityAt: '2024-04-02T08:00:00.000Z',
  lastActivityAt: '2026-08-30T09:12:00.000Z',
};

const EMPTY_ACTIVITY: ActivityObservation = {
  commitsAttributed: null,
  pullRequestsAuthored: null,
  issuesAuthored: null,
  firstActivityAt: null,
  lastActivityAt: null,
};

function repo(
  overrides: Partial<RepositoryObservation> = {},
): RepositoryObservation {
  return {
    externalId: 'github:repo:515187740',
    repoId: '515187740',
    nodeId: 'R_kgDOHqK9xA',
    name: 'payments-service',
    fullName: 'acme-corp/payments-service',
    htmlUrl:
      'https://github.com/acme-corp/payments-service',
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
    languages: [
      { name: 'TypeScript', bytes: 184320 },
      { name: 'C++', bytes: 40960 },
      { name: 'Jupyter Notebook', bytes: 2048 },
    ],
    activity: ACTIVITY,
    completeness: {
      commits: 'DEFAULT_BRANCH_ONLY',
      scannedSince: null,
      scannedAt: SCANNED_AT,
      truncated: false,
    },
    ...overrides,
  };
}

function sync(
  repositories: RepositoryObservation[] = [
    repo(),
  ],
  completeness: Partial<
    SyncObservation['completeness']
  > = {},
): SyncObservation {
  return {
    account: {
      accountId: '4820193',
      login: 'octo-dev',
    },
    repositories,
    completeness: {
      reposScanned: 12,
      reposTotal: 40,
      scannedAt: SCANNED_AT,
      scannedSince: null,
      truncated: false,
      ...completeness,
    },
  };
}

const project = (
  overrides: Partial<RepositoryObservation> = {},
) => {
  const repository = repo(overrides);

  return projectRepositoryEvidence(
    repository,
    sync([repository]),
  );
};

describe('projectRepositoryEvidence', () => {
  describe('identity and shape', () => {
    it('carries the observation externalId, built from the numeric id', () => {
      expect(project().externalId).toBe(
        'github:repo:515187740',
      );
    });

    /*
     * Every downstream record is keyed on externalId, so if it moved
     * under a rename the next sync would create a second row for the
     * same repository instead of updating the first.
     */
    it('keeps externalId stable across a rename or transfer', () => {
      const before = project();

      const after = project({
        name: 'billing-service',
        fullName: 'newco/billing-service',
        htmlUrl:
          'https://github.com/newco/billing-service',
        nodeId: 'R_kgDOchangedNodeId',
        owner: {
          id: '999',
          login: 'newco',
          type: 'Organization',
        },
      });

      expect(after.externalId).toBe(
        before.externalId,
      );

      /* Display fields do follow the rename. */
      expect(after.title).toBe(
        'newco/billing-service',
      );
      expect(after.sourceUrl).toBe(
        'https://github.com/newco/billing-service',
      );
    });

    it('never derives externalId from a mutable field', () => {
      const row = project();

      for (const mutable of [
        row.title,
        row.sourceUrl,
        'R_kgDOHqK9xA',
        'payments-service',
      ]) {
        expect(row.externalId).not.toBe(
          mutable,
        );
      }
    });

    it('sets sourceType and the canonical sourceUrl', () => {
      const row = project();

      expect(row.sourceType).toBe('GITHUB');
      expect(row.sourceUrl).toBe(
        'https://github.com/acme-corp/payments-service',
      );
    });

    /*
     * Ownership belongs to the persistence layer, which reads it from
     * the authenticated connection. A projection that could set it
     * could also write a row onto the wrong account.
     */
    it('does not carry userId', () => {
      expect(
        Object.keys(project()),
      ).not.toContain('userId');
    });
  });

  describe('occurredAt and capturedAt', () => {
    /*
     * The two are different questions - when did it happen, and when
     * did we look - and conflating them would date a decade-old
     * repository to today.
     */
    it('dates the row by pushedAt, not by capture time', () => {
      const row = project();

      expect(
        row.occurredAt?.toISOString(),
      ).toBe('2026-08-30T09:12:00.000Z');

      expect(row.capturedAt.toISOString()).toBe(
        SCANNED_AT,
      );

      expect(row.occurredAt).not.toEqual(
        row.capturedAt,
      );
    });

    it('falls back to createdAt when the repository was never pushed to', () => {
      expect(
        project({
          pushedAt: null,
        }).occurredAt?.toISOString(),
      ).toBe('2024-03-15T10:23:45.000Z');
    });

    /*
     * updatedAt moves for a star, a description edit or a rename, so
     * using it would date "work happened" to a moment when none did.
     */
    it('never uses updatedAt', () => {
      const row = project({
        pushedAt: null,
        createdAt: null,
        updatedAt: '2026-09-01T11:00:00.000Z',
      });

      expect(row.occurredAt).toBeNull();
    });

    it('leaves occurredAt null rather than inventing a date', () => {
      expect(
        project({
          pushedAt: null,
          createdAt: null,
        }).occurredAt,
      ).toBeNull();

      expect(
        repositoryOccurredAt(
          repo({
            pushedAt: 'not-a-date',
            createdAt: null,
          }),
        ),
      ).toBeNull();
    });

    it('takes capturedAt from the injected sync clock, as a Date', () => {
      const observation = sync([repo()], {
        scannedAt: '2026-01-02T03:04:05.000Z',
      });

      const row = projectRepositoryEvidence(
        repo(),
        observation,
      );

      expect(row.capturedAt).toBeInstanceOf(
        Date,
      );
      expect(row.capturedAt.toISOString()).toBe(
        '2026-01-02T03:04:05.000Z',
      );
    });

    /*
     * Substituting the wall clock here would silently defeat every
     * determinism guarantee in this module, so it fails loudly instead.
     */
    it('refuses a sync with no usable scannedAt', () => {
      expect(() =>
        syncCapturedAt(
          sync([repo()], {
            scannedAt: 'whenever',
          }),
        ),
      ).toThrow();
    });
  });

  describe('metadata determinism', () => {
    it('produces byte-identical metadata for the same observation twice', () => {
      expect(
        canonicalJson(project().metadata),
      ).toBe(
        canonicalJson(project().metadata),
      );
    });

    /*
     * The persistence layer serializes this object again on the way
     * into jsonb, so canonical CONTENT is not enough - the object's own
     * key order has to be canonical too, or two identical runs write
     * different bytes and a re-sync reads as an edit.
     */
    it('emits metadata whose own key order is already canonical', () => {
      const metadata = project().metadata;

      expect(JSON.stringify(metadata)).toBe(
        canonicalJson(metadata),
      );
    });

    it('holds only JSON-safe values, never Date objects', () => {
      const metadata = project().metadata;

      expect(
        JSON.parse(JSON.stringify(metadata)),
      ).toEqual(metadata);
    });
  });

  describe('metadata content', () => {
    it('preserves the completeness record and the run-level counts', () => {
      const row = projectRepositoryEvidence(
        repo({
          completeness: {
            commits: 'DEFAULT_BRANCH_ONLY',
            scannedSince:
              '2024-01-01T00:00:00.000Z',
            scannedAt: SCANNED_AT,
            truncated: true,
          },
        }),
        sync([repo()], {
          reposScanned: 12,
          reposTotal: 40,
          truncated: true,
        }),
      );

      expect(
        row.metadata.completeness,
      ).toEqual({
        commits: 'DEFAULT_BRANCH_ONLY',
        scannedSince:
          '2024-01-01T00:00:00.000Z',
        scannedAt: SCANNED_AT,
        truncated: true,
        reposScanned: 12,
        reposTotal: 40,
        listingTruncated: true,
      });
    });

    it('carries NOT_SCANNED through instead of dropping it', () => {
      const row = project({
        activity: EMPTY_ACTIVITY,
        completeness: {
          commits: 'NOT_SCANNED',
          scannedSince: null,
          scannedAt: SCANNED_AT,
          truncated: false,
        },
      });

      expect(
        (
          row.metadata.completeness as Record<
            string,
            unknown
          >
        ).commits,
      ).toBe('NOT_SCANNED');
    });

    it('preserves repository facts', () => {
      expect(
        project().metadata.repository,
      ).toEqual({
        repoId: '515187740',
        nodeId: 'R_kgDOHqK9xA',
        name: 'payments-service',
        fullName: 'acme-corp/payments-service',
        htmlUrl:
          'https://github.com/acme-corp/payments-service',
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
      });
    });
  });

  describe('languages', () => {
    /*
     * "C++" and "Jupyter Notebook" are the two spellings a tidying step
     * would mangle first, which is why they are the fixtures.
     */
    it('preserves GitHub spellings verbatim', () => {
      expect(
        project().metadata.languages,
      ).toEqual([
        { name: 'TypeScript', bytes: 184320 },
        { name: 'C++', bytes: 40960 },
        {
          name: 'Jupyter Notebook',
          bytes: 2048,
        },
      ]);
    });

    /*
     * Array order is meaning in this model and is decided in
     * normalize.ts. This module must carry it, not re-decide it.
     */
    it('carries the observation order rather than re-sorting', () => {
      const reversed = project({
        languages: [
          {
            name: 'Jupyter Notebook',
            bytes: 2048,
          },
          { name: 'C++', bytes: 40960 },
          {
            name: 'TypeScript',
            bytes: 184320,
          },
        ],
      });

      expect(
        (
          reversed.metadata
            .languages as Array<{
            name: string;
          }>
        ).map((language) => language.name),
      ).toEqual([
        'Jupyter Notebook',
        'C++',
        'TypeScript',
      ]);
    });

    it('names languages in the description without claiming an order', () => {
      const description =
        project().description ?? '';

      expect(description).toContain('C++');
      expect(description).toContain(
        'Jupyter Notebook',
      );
      expect(description).not.toMatch(
        /largest|most used|primary language/i,
      );
    });
  });

  describe('activity counts', () => {
    /*
     * The single most defamatory mistake available to this system:
     * rendering "we did not look" as "this person did nothing".
     */
    it('keeps null counts null and never turns them into zero', () => {
      const row = project({
        activity: EMPTY_ACTIVITY,
      });

      expect(row.metadata.activity).toEqual({
        commitsAttributed: null,
        pullRequestsAuthored: null,
        issuesAuthored: null,
        firstActivityAt: null,
        lastActivityAt: null,
      });

      expect(
        canonicalJson(row.metadata.activity),
      ).not.toContain('0');
    });

    it('distinguishes an observed zero from an unestablished count', () => {
      const observedZero = project({
        activity: {
          ...EMPTY_ACTIVITY,
          commitsAttributed: 0,
        },
      });

      const unestablished = project({
        activity: EMPTY_ACTIVITY,
      });

      expect(
        (
          observedZero.metadata
            .activity as ActivityObservation
        ).commitsAttributed,
      ).toBe(0);

      expect(
        (
          unestablished.metadata
            .activity as ActivityObservation
        ).commitsAttributed,
      ).toBeNull();
    });

    it('copies established counts through unchanged', () => {
      expect(project().metadata.activity).toEqual(
        ACTIVITY,
      );
    });
  });

  describe('title and description honesty', () => {
    /*
     * Words that assert something GitHub cannot support. Matched on
     * word boundaries so that "listed" does not trip the "led" rule and
     * turn this test into noise nobody trusts.
     */
    const FORBIDDEN =
      /\b(expert|experts|expertise|senior|seniority|junior|employed|employee|employer|employment|hired|proficient|proficiency|skilled|mastery|specialist|owner|owns|ownership|led|leader|leadership|architected|spearheaded|responsible)\b/i;

    it('adds no inference language to the title', () => {
      const title = project().title;

      expect(title).toBe(
        'acme-corp/payments-service',
      );
      expect(title).not.toMatch(FORBIDDEN);
    });

    it('adds no inference language to the description, in any branch', () => {
      const rows = [
        project(),
        project({ activity: EMPTY_ACTIVITY }),
        project({
          isPublic: false,
          isFork: true,
          isArchived: true,
          isDisabled: true,
        }),
        project({
          languages: [],
          completeness: {
            commits: 'NOT_SCANNED',
            scannedSince: null,
            scannedAt: SCANNED_AT,
            truncated: true,
          },
        }),
        project({
          completeness: {
            commits: 'ACCESS_LOST',
            scannedSince:
              '2024-01-01T00:00:00.000Z',
            scannedAt: SCANNED_AT,
            truncated: true,
          },
        }),
      ];

      for (const row of rows) {
        expect(row.description).not.toMatch(
          FORBIDDEN,
        );
      }
    });

    /*
     * Only the default branch is observable, so a bare total would be a
     * lie by construction. "at least" is load-bearing.
     */
    it('qualifies every commit count as a default-branch lower bound', () => {
      const description =
        project().description ?? '';

      expect(description).toContain(
        'at least 214 commits',
      );
      expect(description).toContain(
        'default branch',
      );
    });

    it('states the scanned window a count was taken over', () => {
      expect(
        project().description,
      ).toContain(
        'since the repository was created',
      );

      expect(
        project({
          completeness: {
            commits: 'DEFAULT_BRANCH_ONLY',
            scannedSince:
              '2024-01-01T00:00:00.000Z',
            scannedAt: SCANNED_AT,
            truncated: false,
          },
        }).description,
      ).toContain(
        'since 2024-01-01T00:00:00.000Z',
      );
    });

    it('says a truncated scan is short of the truth', () => {
      expect(
        project({
          completeness: {
            commits: 'DEFAULT_BRANCH_ONLY',
            scannedSince: null,
            scannedAt: SCANNED_AT,
            truncated: true,
          },
        }).description,
      ).toContain('pagination limit');
    });

    it('says out loud that not scanned is not the same as no activity', () => {
      const description =
        project({
          activity: EMPTY_ACTIVITY,
          completeness: {
            commits: 'NOT_SCANNED',
            scannedSince: null,
            scannedAt: SCANNED_AT,
            truncated: false,
          },
        }).description ?? '';

      expect(description).toContain(
        'not scanned in this sync',
      );
      expect(description).toContain(
        'not the same as no activity',
      );
    });

    it('states no count at all when none was established', () => {
      const description =
        project({
          activity: EMPTY_ACTIVITY,
        }).description ?? '';

      expect(description).toContain(
        'not established',
      );
      expect(description).not.toMatch(
        /\b0 commits\b/,
      );
      expect(description).not.toContain(
        'Pull requests authored',
      );
    });

    /*
     * The repository's own blurb is written by whoever set it up and
     * frequently contains exactly the language this layer must not
     * carry. It stays in metadata, where it is data rather than our
     * claim.
     */
    it('does not quote the repository blurb into the description', () => {
      const row = project({
        description:
          'Owned end to end by the senior payments team',
      });

      expect(row.description).not.toContain(
        'senior payments team',
      );

      expect(
        (
          row.metadata.repository as Record<
            string,
            unknown
          >
        ).description,
      ).toBe(
        'Owned end to end by the senior payments team',
      );
    });
  });

  describe('credential safety', () => {
    /*
     * metadata is the field most likely to end up in a log line or a
     * data export, so nothing a credential could hide inside may reach
     * it - no token, no header, no raw response body.
     */
    it('emits nothing that looks like credential material', () => {
      const serialized = comparable(
        projectSyncEvidence(
          sync([
            repo(),
            repo({
              externalId: 'github:repo:22',
              repoId: '22',
              activity: EMPTY_ACTIVITY,
            }),
          ]),
        ),
      );

      expect(serialized).not.toMatch(
        /token|authorization|bearer|secret|password|credential|ghp_|gho_|refresh/i,
      );
    });
  });
});

describe('projectSyncEvidence', () => {
  const other = repo({
    externalId: 'github:repo:99',
    repoId: '99',
    name: 'infra-tools',
    fullName: 'octo-dev/infra-tools',
    htmlUrl:
      'https://github.com/octo-dev/infra-tools',
    languages: [{ name: 'Go', bytes: 900 }],
    activity: EMPTY_ACTIVITY,
  });

  /*
   * Model A: the unit of evidence is the repository. Commits, pull
   * requests, issues and languages are counts inside metadata, never
   * rows of their own.
   */
  it('emits exactly one row per repository', () => {
    const rows = projectSyncEvidence(
      sync([repo(), other]),
    );

    expect(rows).toHaveLength(2);
    expect(
      rows.map((row) => row.externalId),
    ).toEqual([
      'github:repo:99',
      'github:repo:515187740',
    ]);
  });

  it('emits no row per commit, pull request or language', () => {
    const rows = projectSyncEvidence(
      sync([repo()]),
    );

    /* 214 commits, 31 pull requests, 3 languages, 1 row. */
    expect(rows).toHaveLength(1);
  });

  /*
   * GitHub's paginated listings repeat entries when the underlying set
   * changes mid-walk, and two rows sharing an externalId would collide
   * on the upsert key.
   */
  it('collapses a repeated repository, keeping the first occurrence', () => {
    const rows = projectSyncEvidence(
      sync([
        repo(),
        repo({ fullName: 'stale/name' }),
      ]),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe(
      'acme-corp/payments-service',
    );
  });

  it('is byte-identical across two runs over the same observation', () => {
    const observation = sync([repo(), other]);

    expect(
      comparable(
        projectSyncEvidence(observation),
      ),
    ).toBe(
      comparable(
        projectSyncEvidence(observation),
      ),
    );
  });

  /*
   * A caller who hands the repositories in a different order must get
   * the same result, rather than one that happens to be right because
   * an upstream step ordered them first.
   */
  it('is byte-identical when the input repositories are reordered', () => {
    expect(
      comparable(
        projectSyncEvidence(
          sync([repo(), other]),
        ),
      ),
    ).toBe(
      comparable(
        projectSyncEvidence(
          sync([other, repo()]),
        ),
      ),
    );
  });

  it('gives every row the same capture instant', () => {
    const rows = projectSyncEvidence(
      sync([repo(), other]),
    );

    expect(
      rows.map((row) =>
        row.capturedAt.toISOString(),
      ),
    ).toEqual([SCANNED_AT, SCANNED_AT]);
  });

  it('gives every row the run-level completeness counts', () => {
    const rows = projectSyncEvidence(
      sync([repo(), other], {
        reposScanned: 1,
        reposTotal: 2,
      }),
    );

    for (const row of rows) {
      const completeness = row.metadata
        .completeness as Record<
        string,
        unknown
      >;

      expect(completeness.reposScanned).toBe(1);
      expect(completeness.reposTotal).toBe(2);
    }
  });
});
