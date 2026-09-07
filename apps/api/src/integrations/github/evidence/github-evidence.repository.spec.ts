import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service.js';
import { createInMemoryPrisma } from '../../test-doubles.js';

import type { EvidenceInput } from './evidence-input.js';
import { GithubEvidenceRepository } from './github-evidence.repository.js';

/*
 * These specs run the real repository against the in-memory Prisma double,
 * which enforces @@unique([userId, sourceType, externalId]) for real and
 * raises a genuine P2002 on violation. That matters: the whole claim being
 * tested is "the database is the idempotency authority", and a double that
 * accepted duplicate inserts would let every one of these pass against an
 * implementation with no guarantee at all.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

const CAPTURED = new Date(
  '2026-09-07T12:00:00.000Z',
);
const OCCURRED = new Date(
  '2026-08-01T09:30:00.000Z',
);

function build() {
  const store = createInMemoryPrisma();

  const repository = new GithubEvidenceRepository(
    store.prisma as unknown as PrismaService,
  );

  return { repository, store };
}

/**
 * One projected repository. Defaults describe a plausible repo; each test
 * overrides only the field whose movement it is actually about.
 */
function input(
  overrides: Partial<EvidenceInput> = {},
): EvidenceInput {
  return {
    sourceType: 'GITHUB',
    externalId: 'github:repo:583231',
    title: 'octocat/hello-world',
    description: 'A first repository',
    sourceUrl:
      'https://github.com/octocat/hello-world',
    occurredAt: OCCURRED,
    capturedAt: CAPTURED,
    metadata: {
      completeness: {
        commits: 'DEFAULT_BRANCH_ONLY',
        truncated: false,
      },
      languages: { TypeScript: 1200 },
    },
    ...overrides,
  };
}

describe('GithubEvidenceRepository', () => {
  describe('persist', () => {
    it('creates a row the first time a repository is seen', async () => {
      const { repository, store } = build();

      const result = await repository.persist(
        USER_A,
        input(),
      );

      expect(result).toEqual({ created: true });
      expect(store.rows.evidence).toHaveLength(1);

      const row = store.rows.evidence[0]!;

      expect(row.userId).toBe(USER_A);
      expect(row.sourceType).toBe('GITHUB');
      expect(row.externalId).toBe(
        'github:repo:583231',
      );
      expect(row.title).toBe(
        'octocat/hello-world',
      );
      expect(row.sourceUrl).toBe(
        'https://github.com/octocat/hello-world',
      );
      expect(row.occurredAt).toEqual(OCCURRED);
      expect(row.capturedAt).toEqual(CAPTURED);
    });

    it('leaves resumeImportId null on GitHub evidence', async () => {
      const { repository, store } = build();

      await repository.persist(USER_A, input());

      expect(
        store.rows.evidence[0]!.resumeImportId,
      ).toBeNull();
    });

    it('does not duplicate when the same observation is persisted twice', async () => {
      const { repository, store } = build();

      const first = await repository.persist(
        USER_A,
        input(),
      );
      const second = await repository.persist(
        USER_A,
        input(),
      );

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(store.rows.evidence).toHaveLength(1);
    });

    it('is deterministic: an unchanged re-sync does not rewrite the row', async () => {
      const { repository, store } = build();

      await repository.persist(USER_A, input());

      const row = store.rows.evidence[0]!;
      const id = row.id;
      const updatedAt = row.updatedAt;

      // A second run over byte-identical observations. Nothing about the
      // world changed, so nothing about the row may change either - a
      // moved updatedAt here would make every re-sync read as an edit.
      await repository.persist(USER_A, input());

      expect(store.rows.evidence).toHaveLength(1);
      expect(store.rows.evidence[0]!.id).toBe(id);
      expect(
        store.rows.evidence[0]!.updatedAt,
      ).toBe(updatedAt);
    });

    it('updates fields in place when the observation changes', async () => {
      const { repository, store } = build();

      await repository.persist(USER_A, input());

      const id = store.rows.evidence[0]!.id;

      const later = new Date(
        '2026-09-08T12:00:00.000Z',
      );

      const result = await repository.persist(
        USER_A,
        input({
          description: 'Now with a description',
          capturedAt: later,
          metadata: {
            completeness: {
              commits: 'DEFAULT_BRANCH_ONLY',
              truncated: false,
            },
            languages: {
              TypeScript: 1200,
              CSS: 40,
            },
          },
        }),
      );

      expect(result).toEqual({ created: false });
      expect(store.rows.evidence).toHaveLength(1);

      const row = store.rows.evidence[0]!;

      expect(row.id).toBe(id);
      expect(row.description).toBe(
        'Now with a description',
      );
      expect(row.capturedAt).toEqual(later);
      expect(row.metadata).toMatchObject({
        languages: { TypeScript: 1200, CSS: 40 },
      });
    });

    it('follows a rename onto the same row instead of creating a second one', async () => {
      const { repository, store } = build();

      await repository.persist(USER_A, input());

      const id = store.rows.evidence[0]!.id;

      /*
       * Same numeric repository id, new name and new URL - which is
       * exactly what a rename or a transfer looks like from the API.
       * Keying on full_name would produce a second row here and leave
       * the first as a permanent ghost.
       */
      const result = await repository.persist(
        USER_A,
        input({
          title: 'octocat/hello-universe',
          sourceUrl:
            'https://github.com/octocat/hello-universe',
        }),
      );

      expect(result).toEqual({ created: false });
      expect(store.rows.evidence).toHaveLength(1);

      const row = store.rows.evidence[0]!;

      expect(row.id).toBe(id);
      expect(row.title).toBe(
        'octocat/hello-universe',
      );
      expect(row.sourceUrl).toBe(
        'https://github.com/octocat/hello-universe',
      );
    });

    it('updates a changed URL in place', async () => {
      const { repository, store } = build();

      await repository.persist(USER_A, input());

      await repository.persist(
        USER_A,
        input({
          sourceUrl:
            'https://github.com/new-org/hello-world',
        }),
      );

      expect(store.rows.evidence).toHaveLength(1);
      expect(
        store.rows.evidence[0]!.sourceUrl,
      ).toBe(
        'https://github.com/new-org/hello-world',
      );
    });

    it('keeps two users independent for the same repository id', async () => {
      const { repository, store } = build();

      /*
       * A fork, an org repo two colleagues both contribute to - the same
       * numeric id legitimately appears for two accounts. The unique
       * index includes userId, so these are two rows and neither user's
       * sync may touch the other's.
       */
      const a = await repository.persist(
        USER_A,
        input(),
      );
      const b = await repository.persist(
        USER_B,
        input({ title: 'seen-by-user-b' }),
      );

      expect(a.created).toBe(true);
      expect(b.created).toBe(true);
      expect(store.rows.evidence).toHaveLength(2);

      const forA = store.rows.evidence.find(
        (row) => row.userId === USER_A,
      )!;
      const forB = store.rows.evidence.find(
        (row) => row.userId === USER_B,
      )!;

      expect(forA.id).not.toBe(forB.id);
      expect(forA.title).toBe(
        'octocat/hello-world',
      );
      expect(forB.title).toBe('seen-by-user-b');
    });

    it('creates separate rows for different repositories', async () => {
      const { repository, store } = build();

      await repository.persist(USER_A, input());
      await repository.persist(
        USER_A,
        input({
          externalId: 'github:repo:999',
          title: 'octocat/other',
        }),
      );

      expect(store.rows.evidence).toHaveLength(2);
      expect(
        store.rows.evidence.map(
          (row) => row.externalId,
        ),
      ).toEqual([
        'github:repo:583231',
        'github:repo:999',
      ]);
    });

    it('recovers from a P2002 raised by a racing insert', async () => {
      const { repository, store } = build();

      const evidence = store.prisma.evidence;
      const realUpsert = evidence.upsert;

      let raced = false;

      /*
       * Simulates the READ COMMITTED race the pre-check cannot close:
       * our transaction saw no row, and by the time it writes, a
       * concurrent sync has committed one. The constraint fires. This
       * must resolve to one correct row, not a 500 and not a duplicate.
       */
      evidence.upsert = async (args) => {
        if (!raced) {
          raced = true;

          store.rows.evidence.push({
            id: 'row-written-by-the-winner',
            userId: USER_A,
            resumeImportId: null,
            sourceType: 'GITHUB',
            title: 'stale-title-from-winner',
            description: null,
            sourceUrl: null,
            externalId:
              'github:repo:583231',
            occurredAt: null,
            capturedAt: new Date(
              '2026-01-01T00:00:00.000Z',
            ),
            metadata: null,
            createdAt: new Date(
              '2026-01-01T00:00:00.000Z',
            ),
            updatedAt: new Date(
              '2026-01-01T00:00:00.000Z',
            ),
          });

          throw new Prisma.PrismaClientKnownRequestError(
            'Unique constraint failed',
            {
              code: 'P2002',
              clientVersion: 'test',
              meta: {
                target: [
                  'userId',
                  'sourceType',
                  'externalId',
                ],
              },
            },
          );
        }

        return await realUpsert(args);
      };

      const result = await repository.persist(
        USER_A,
        input(),
      );

      expect(raced).toBe(true);
      expect(result).toEqual({ created: false });
      expect(store.rows.evidence).toHaveLength(1);

      const row = store.rows.evidence[0]!;

      expect(row.id).toBe(
        'row-written-by-the-winner',
      );
      expect(row.title).toBe(
        'octocat/hello-world',
      );
      expect(row.capturedAt).toEqual(CAPTURED);
    });

    it('rethrows a P2002 that is not the identity race', async () => {
      const { repository, store } = build();

      const evidence = store.prisma.evidence;

      // A constraint failure with no row behind it is some other
      // constraint - swallowing it would hide a real bug.
      evidence.upsert = async () => {
        throw new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed',
          {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: ['somethingElse'] },
          },
        );
      };

      await expect(
        repository.persist(USER_A, input()),
      ).rejects.toMatchObject({ code: 'P2002' });

      expect(store.rows.evidence).toHaveLength(0);
    });

    it('touches no table other than Evidence', async () => {
      const { store } = build();

      /*
       * A Prisma double exposing ONLY the evidence model. If this layer
       * ever reaches for Project, Skill, UserSkill, Experience,
       * Achievement, Education, Goal, CareerGraphIngestion or any of the
       * Evidence* join tables, the property access is undefined and the
       * call throws. 7.5 owns interpretation; this owns storage.
       */
      const evidenceOnly = {
        evidence: store.prisma.evidence,
      };

      const repository =
        new GithubEvidenceRepository(
          evidenceOnly as unknown as PrismaService,
        );

      await expect(
        repository.persist(USER_A, input()),
      ).resolves.toEqual({ created: true });
    });
  });

  describe('isolation from other evidence sources', () => {
    it('leaves resume evidence untouched', async () => {
      const { repository, store } = build();

      const resume =
        await store.prisma.evidence.create({
          data: {
            userId: USER_A,
            sourceType: 'RESUME',
            externalId: null,
            title: 'Confirmed from resume',
            description: 'Written by the user',
          },
        });

      await repository.persistMany(USER_A, [
        input(),
        input({
          externalId: 'github:repo:999',
        }),
      ]);
      await repository.persist(USER_A, input());

      const resumeRows =
        store.rows.evidence.filter(
          (row) => row.sourceType === 'RESUME',
        );

      expect(resumeRows).toHaveLength(1);
      expect(resumeRows[0]!.id).toBe(resume.id);
      expect(resumeRows[0]!.title).toBe(
        'Confirmed from resume',
      );
      expect(resumeRows[0]!.updatedAt).toEqual(
        resume.updatedAt,
      );
    });

    it('does not collide with another source that shares an externalId', async () => {
      const { repository, store } = build();

      const portfolio =
        await store.prisma.evidence.create({
          data: {
            userId: USER_A,
            sourceType: 'PORTFOLIO',
            externalId:
              'github:repo:583231',
            title: 'Portfolio entry',
          },
        });

      const result = await repository.persist(
        USER_A,
        input(),
      );

      expect(result).toEqual({ created: true });
      expect(store.rows.evidence).toHaveLength(2);

      const untouched =
        store.rows.evidence.find(
          (row) => row.id === portfolio.id,
        )!;

      expect(untouched.sourceType).toBe(
        'PORTFOLIO',
      );
      expect(untouched.title).toBe(
        'Portfolio entry',
      );
    });
  });

  describe('persistMany', () => {
    it('reports accurate created and updated counts', async () => {
      const { repository, store } = build();

      const first = await repository.persistMany(
        USER_A,
        [
          input(),
          input({
            externalId: 'github:repo:2',
            title: 'octocat/two',
          }),
          input({
            externalId: 'github:repo:3',
            title: 'octocat/three',
          }),
        ],
      );

      expect(first).toEqual({
        created: 3,
        updated: 0,
      });

      const second = await repository.persistMany(
        USER_A,
        [
          // Unchanged.
          input(),
          // Renamed - same id, new name.
          input({
            externalId: 'github:repo:2',
            title: 'octocat/two-renamed',
          }),
          // New this run.
          input({
            externalId: 'github:repo:4',
            title: 'octocat/four',
          }),
        ],
      );

      expect(second).toEqual({
        created: 1,
        updated: 2,
      });

      expect(store.rows.evidence).toHaveLength(4);
    });

    it('does not remove evidence for repositories absent from a later run', async () => {
      const { repository, store } = build();

      await repository.persistMany(USER_A, [
        input(),
        input({
          externalId: 'github:repo:2',
          title: 'octocat/two',
        }),
      ]);

      /*
       * The second run only sees one repository - a lost scope, a
       * truncated listing, a transfer we can no longer read. None of
       * those is proof the other repository stopped existing, so its
       * evidence must survive.
       */
      await repository.persistMany(USER_A, [
        input(),
      ]);

      expect(store.rows.evidence).toHaveLength(2);
      expect(
        store.rows.evidence.map(
          (row) => row.externalId,
        ),
      ).toContain('github:repo:2');
    });

    it('accepts an empty run without writing anything', async () => {
      const { repository, store } = build();

      await expect(
        repository.persistMany(USER_A, []),
      ).resolves.toEqual({
        created: 0,
        updated: 0,
      });

      expect(store.rows.evidence).toHaveLength(0);
    });
  });
});
