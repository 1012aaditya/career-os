import { canonicalJson } from './canonical-json.js';
import {
  buildSyncObservation,
  emptyActivity,
  isCompleteScan,
  normalizeLanguages,
  normalizeRepository,
  orderRepositories,
  repositoryExternalId,
} from './normalize.js';
import type { RepositoryCompleteness } from './types.js';

const SCANNED_AT = '2026-09-07T12:00:00.000Z';

const SCANNED: RepositoryCompleteness = {
  commits: 'DEFAULT_BRANCH_ONLY',
  scannedSince: null,
  scannedAt: SCANNED_AT,
  truncated: false,
};

const NOT_SCANNED: RepositoryCompleteness = {
  ...SCANNED,
  commits: 'NOT_SCANNED',
};

function rawRepo(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 515187740,
    node_id: 'R_kgDOHqK9xA',
    name: 'payments-service',
    full_name: 'acme-corp/payments-service',
    html_url:
      'https://github.com/acme-corp/payments-service',
    owner: {
      id: 583231,
      login: 'acme-corp',
      type: 'Organization',
    },
    private: false,
    visibility: 'public',
    fork: false,
    archived: false,
    disabled: false,
    default_branch: 'main',
    description: 'Handles settlement',
    size: 4821,
    created_at: '2024-03-15T10:23:45Z',
    updated_at: '2026-08-30T09:12:00Z',
    pushed_at: '2026-08-30T09:12:00Z',
    ...overrides,
  };
}

const norm = (
  overrides: Record<string, unknown> = {},
  languages?: unknown,
) =>
  normalizeRepository({
    raw: rawRepo(overrides),
    languages,
    completeness: SCANNED,
  });

describe('normalizeRepository', () => {
  describe('identity', () => {
    it('derives externalId from the numeric id alone', () => {
      expect(norm()!.externalId).toBe(
        'github:repo:515187740',
      );

      expect(
        repositoryExternalId('42'),
      ).toBe('github:repo:42');
    });

    /*
     * The identity must not move when the repository is renamed or
     * transferred, because every downstream record is keyed on it.
     */
    it('keeps the same identity across a rename or transfer', () => {
      const before = norm()!;

      const after = norm({
        name: 'billing-service',
        full_name: 'newco/billing-service',
        html_url:
          'https://github.com/newco/billing-service',
        owner: {
          id: 999,
          login: 'newco',
          type: 'Organization',
        },
      })!;

      expect(after.externalId).toBe(
        before.externalId,
      );

      /* ...while the display fields do follow the rename. */
      expect(after.fullName).toBe(
        'newco/billing-service',
      );
    });

    it('refuses a repository with no usable numeric id', () => {
      for (const id of [
        undefined,
        null,
        'abc',
        -1,
        1.5,
        Number.MAX_SAFE_INTEGER + 2,
      ]) {
        expect(norm({ id })).toBeNull();
      }
    });

    it('refuses a repository missing a name, full name or url', () => {
      expect(norm({ name: '' })).toBeNull();
      expect(norm({ full_name: null })).toBeNull();
      expect(norm({ html_url: '   ' })).toBeNull();
    });

    it('refuses a repository with no resolvable owner', () => {
      expect(norm({ owner: null })).toBeNull();
      expect(
        norm({ owner: { login: 'x' } }),
      ).toBeNull();
    });
  });

  describe('flags and metadata', () => {
    it('carries fork, archived and disabled through', () => {
      const repo = norm({
        fork: true,
        archived: true,
        disabled: true,
      })!;

      expect(repo.isFork).toBe(true);
      expect(repo.isArchived).toBe(true);
      expect(repo.isDisabled).toBe(true);
    });

    it('defaults missing flags to false rather than undefined', () => {
      const repo = norm({
        fork: undefined,
        archived: undefined,
        disabled: undefined,
      })!;

      expect(repo.isFork).toBe(false);
      expect(repo.isArchived).toBe(false);
      expect(repo.isDisabled).toBe(false);
    });

    /*
     * An unexpected payload must not be read as public. Getting this
     * backwards would publish a private repository's metadata.
     */
    it('treats an unclear visibility as not public', () => {
      expect(
        norm({
          visibility: undefined,
          private: undefined,
        })!.isPublic,
      ).toBe(false);

      expect(
        norm({ visibility: 'private' })!.isPublic,
      ).toBe(false);

      expect(
        norm({ visibility: 'internal' })!
          .isPublic,
      ).toBe(false);

      expect(
        norm({
          visibility: undefined,
          private: false,
        })!.isPublic,
      ).toBe(true);
    });

    it('keeps a null pushed_at as null rather than inventing a date', () => {
      expect(
        norm({ pushed_at: null })!.pushedAt,
      ).toBeNull();
    });
  });

  describe('timestamps', () => {
    it('normalizes equivalent spellings of one instant to one string', () => {
      expect(
        norm({
          created_at: '2024-03-15T10:23:45Z',
        })!.createdAt,
      ).toBe(
        norm({
          created_at:
            '2024-03-15T10:23:45.000Z',
        })!.createdAt,
      );
    });

    /*
     * A zone-less timestamp means a different instant on two devices, so
     * it is refused rather than guessed at.
     */
    it('rejects a timestamp with no zone, and other unparseable dates', () => {
      for (const value of [
        '2024-03-15T10:23:45',
        'Summer 2023',
        '',
        null,
        12345,
      ]) {
        expect(
          norm({ created_at: value })!.createdAt,
        ).toBeNull();
      }
    });
  });

  describe('activity defaults', () => {
    it('reports unestablished activity as null, never zero', () => {
      const activity = norm()!.activity;

      expect(activity).toEqual(emptyActivity());
      expect(
        activity.commitsAttributed,
      ).toBeNull();
      expect(
        activity.commitsAttributed,
      ).not.toBe(0);
    });
  });
});

describe('normalizeLanguages', () => {
  it('preserves GitHub spelling exactly', () => {
    const languages = normalizeLanguages({
      'Jupyter Notebook': 100,
      'C++': 200,
      'Objective-C++': 50,
      TypeScript: 300,
    });

    expect(
      languages.map((l) => l.name),
    ).toEqual([
      'TypeScript',
      'C++',
      'Jupyter Notebook',
      'Objective-C++',
    ]);
  });

  /*
   * Object key order is an artifact of whatever produced the payload, so
   * two orderings of one set must normalize identically.
   */
  it('is independent of object key order', () => {
    const a = normalizeLanguages({
      TypeScript: 300,
      CSS: 100,
      Go: 200,
    });

    const b = normalizeLanguages({
      Go: 200,
      TypeScript: 300,
      CSS: 100,
    });

    expect(canonicalJson(a)).toBe(
      canonicalJson(b),
    );
  });

  it('breaks byte ties by name so the order is total', () => {
    expect(
      normalizeLanguages({
        Zig: 100,
        Ada: 100,
        Nim: 100,
      }).map((l) => l.name),
    ).toEqual(['Ada', 'Nim', 'Zig']);
  });

  it('drops malformed entries instead of guessing', () => {
    expect(
      normalizeLanguages({
        Go: 'lots',
        Rust: -5,
        '': 10,
        Zig: 1,
      }),
    ).toEqual([{ name: 'Zig', bytes: 1 }]);
  });

  it('handles an empty or non-object payload', () => {
    expect(normalizeLanguages({})).toEqual([]);
    expect(normalizeLanguages(null)).toEqual([]);
    expect(normalizeLanguages([1, 2])).toEqual(
      [],
    );
  });
});

describe('orderRepositories', () => {
  const at = (id: number) =>
    normalizeRepository({
      raw: rawRepo({
        id,
        full_name: `acme/repo-${id}`,
      }),
      completeness: SCANNED,
    })!;

  it('orders by numeric id, not by string or payload order', () => {
    const ordered = orderRepositories([
      at(1000),
      at(9),
      at(999),
      at(30),
    ]);

    expect(
      ordered.map((r) => r.repoId),
    ).toEqual(['9', '30', '999', '1000']);
  });

  it('produces identical output for any input permutation', () => {
    const repos = [
      at(5),
      at(3),
      at(9),
      at(1),
      at(7),
    ];

    const forwards = canonicalJson(
      orderRepositories(repos),
    );

    const backwards = canonicalJson(
      orderRepositories([...repos].reverse()),
    );

    const shuffled = canonicalJson(
      orderRepositories([
        repos[2]!,
        repos[0]!,
        repos[4]!,
        repos[1]!,
        repos[3]!,
      ]),
    );

    expect(backwards).toBe(forwards);
    expect(shuffled).toBe(forwards);
  });

  /*
   * A paginated listing can repeat an entry when the underlying set
   * changes mid-walk, so duplicates are a real event rather than a
   * hypothetical.
   */
  it('deduplicates by id, keeping the first occurrence', () => {
    const first = at(42);

    const second = normalizeRepository({
      raw: rawRepo({
        id: 42,
        full_name: 'acme/renamed-mid-walk',
      }),
      completeness: SCANNED,
    })!;

    const ordered = orderRepositories([
      first,
      second,
    ]);

    expect(ordered).toHaveLength(1);
    expect(ordered[0]!.fullName).toBe(
      first.fullName,
    );
  });
});

describe('sync completeness', () => {
  const repo = (
    id: number,
    completeness: RepositoryCompleteness,
  ) =>
    normalizeRepository({
      raw: rawRepo({ id }),
      completeness,
    })!;

  const build = (
    repositories: ReturnType<typeof repo>[],
    reposTotal: number,
    truncated = false,
  ) =>
    buildSyncObservation({
      account: {
        accountId: '583231',
        login: 'octocat',
      },
      repositories,
      reposTotal,
      scannedAt: SCANNED_AT,
      scannedSince: null,
      truncated,
    });

  it('counts a fully scanned set as complete', () => {
    const sync = build(
      [
        repo(1, SCANNED),
        repo(2, SCANNED),
      ],
      2,
    );

    expect(sync.completeness.reposScanned).toBe(
      2,
    );
    expect(sync.completeness.reposTotal).toBe(2);
    expect(
      isCompleteScan(sync.completeness),
    ).toBe(true);
  });

  /* NOT_SCANNED is not zero activity, and not a scanned repository. */
  it('does not count an unscanned repository as scanned', () => {
    const sync = build(
      [
        repo(1, SCANNED),
        repo(2, NOT_SCANNED),
      ],
      2,
    );

    expect(sync.completeness.reposScanned).toBe(
      1,
    );
    expect(
      isCompleteScan(sync.completeness),
    ).toBe(false);
  });

  it('treats a lost repository as scanned but flagged', () => {
    const sync = build(
      [
        repo(1, {
          ...SCANNED,
          commits: 'ACCESS_LOST',
        }),
      ],
      1,
    );

    /* Its historical observation is retained... */
    expect(
      sync.repositories[0]!.completeness.commits,
    ).toBe('ACCESS_LOST');

    /* ...and it does not make the run look unscanned. */
    expect(sync.completeness.reposScanned).toBe(
      1,
    );
  });

  it('is incomplete when the listing itself was truncated', () => {
    const sync = build(
      [repo(1, SCANNED)],
      1,
      true,
    );

    expect(
      isCompleteScan(sync.completeness),
    ).toBe(false);
  });

  it('reports 30 of 40 as incomplete', () => {
    const repositories = Array.from(
      { length: 40 },
      (_, i) =>
        repo(
          i + 1,
          i < 30 ? SCANNED : NOT_SCANNED,
        ),
    );

    const sync = build(repositories, 40);

    expect(sync.completeness).toMatchObject({
      reposScanned: 30,
      reposTotal: 40,
    });

    expect(
      isCompleteScan(sync.completeness),
    ).toBe(false);
  });

  it('never reports a total lower than what it holds', () => {
    const sync = build(
      [repo(1, SCANNED), repo(2, SCANNED)],
      0,
    );

    expect(sync.completeness.reposTotal).toBe(2);
  });

  it('serializes identically for identical input', () => {
    const once = build(
      [repo(2, SCANNED), repo(1, SCANNED)],
      2,
    );

    const twice = build(
      [repo(1, SCANNED), repo(2, SCANNED)],
      2,
    );

    expect(canonicalJson(once)).toBe(
      canonicalJson(twice),
    );
  });
});
