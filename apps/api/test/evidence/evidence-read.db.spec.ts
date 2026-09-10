import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CareerGraphIngestionService } from '../../src/career-graph/career-graph-ingestion.service.js';
import { EvidenceService } from '../../src/evidence/evidence.service.js';
import { GithubEvidenceRepository } from '../../src/integrations/github/evidence/github-evidence.repository.js';
import { projectRepositoryEvidence } from '../../src/integrations/github/evidence/evidence-projection.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import type {
  RepositoryObservation,
  SyncObservation,
} from '../../src/integrations/github/observations/types.js';
import { marketTestDatabaseUrl } from '../market-graph/market-db.js';

/*
 * The read path, over rows the REAL producers wrote.
 *
 * Both halves matter and neither can be faked here. The rows come from
 * the actual resume ingestion and the actual GitHub evidence repository,
 * so this proves the contract survives the round trip through Postgres -
 * enum columns, nullable timestamps and all - rather than proving a
 * fixture.
 *
 * And user isolation is a claim about a WHERE clause meeting real data.
 * The failure mode is returning somebody else's career history, which has
 * no undo, so it is checked against a database rather than a double.
 */

let prisma: PrismaService;
let ingestion: CareerGraphIngestionService;
let githubEvidence: GithubEvidenceRepository;
let evidence: EvidenceService;

const SCANNED_AT = '2026-09-08T12:00:00.000Z';

const EXTRACTION = {
  extraction: {
    basics: { name: 'A Person' },
    skills: ['TypeScript'],
    experience: [{ company: 'Acme', role: 'Engineer' }],
  },
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
    htmlUrl: 'https://github.com/acme-corp/payments-service',
    owner: { id: '583231', login: 'acme-corp', type: 'Organization' },
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

function sync(repositories: RepositoryObservation[]): SyncObservation {
  return {
    account: { accountId: '4820193', login: 'octo-dev' },
    repositories,
    completeness: {
      reposScanned: repositories.length,
      reposTotal: repositories.length,
      scannedAt: SCANNED_AT,
      scannedSince: null,
      truncated: false,
      authoredActivityEstablished: true,
    },
  };
}

async function seedGithub(
  userId: string,
  overrides: Partial<RepositoryObservation> = {},
) {
  const repository = repo(overrides);

  await githubEvidence.persistMany(userId, [
    projectRepositoryEvidence(repository, sync([repository])),
  ]);
}

async function seedResume(userId: string) {
  const created = await prisma.resumeImport.create({
    data: {
      userId,
      fileName: 'cv.pdf',
      storagePath: `${userId}/${randomUUID()}/cv.pdf`,
      status: 'CONFIRMED',
      extractionResult: EXTRACTION,
    },
  });

  await ingestion.ingestConfirmedResume(userId, created.id);
}

beforeAll(() => {
  process.env.DATABASE_URL = marketTestDatabaseUrl();

  prisma = new PrismaService();
  ingestion = new CareerGraphIngestionService(prisma);
  githubEvidence = new GithubEvidenceRepository(prisma);
  evidence = new EvidenceService(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const users: string[] = [];

async function newUser(): Promise<string> {
  const id = randomUUID();
  users.push(id);
  await prisma.user.create({ data: { id } });
  return id;
}

beforeEach(async () => {
  if (users.length > 0) {
    await prisma.user.deleteMany({
      where: { id: { in: users.filter(Boolean) } },
    });
    users.length = 0;
  }
});

describe('a user reading their own evidence', () => {
  it('returns both sources, each declaring what it is', async () => {
    const userId = await newUser();
    await seedResume(userId);
    await seedGithub(userId);

    const result = await evidence.listForUser(userId);

    expect(result.evidence).toHaveLength(2);

    const github = result.evidence.find(
      (row) => row.sourceType === 'GITHUB',
    )!;
    const resume = result.evidence.find(
      (row) => row.sourceType === 'RESUME',
    )!;

    expect(github.reliability).toMatchObject({
      authenticity: 'DIRECT_API_OBSERVATION',
      attribution: 'AUTHENTICATED_ACCOUNT',
      completeness: 'PARTIAL',
      transformVersion: 1,
    });

    expect(resume.reliability).toMatchObject({
      authenticity: 'USER_CLAIM',
      attribution: 'USER_ASSERTED',
      completeness: 'UNKNOWN',
      transformVersion: 1,
    });
  });

  /*
   * The B2 finding, closed. GitHub evidence creates no Career Graph
   * joins, so /v1/career-graph could never show it; before this endpoint
   * it was written, deduplicated, kept fresh and read by nothing.
   */
  it('shows GitHub evidence, which the career graph cannot', async () => {
    const userId = await newUser();
    await seedGithub(userId);

    const result = await evidence.listForUser(userId);

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]!.sourceUrl).toBe(
      'https://github.com/acme-corp/payments-service',
    );
    expect(result.evidence[0]!.lastObservedAt).toBe(SCANNED_AT);
  });

  it('counts two sources as two, and many repositories as one', async () => {
    const userId = await newUser();
    await seedResume(userId);

    for (const id of ['1', '2', '3']) {
      await seedGithub(userId, {
        externalId: `github:repo:${id}`,
        repoId: id,
        name: `repo-${id}`,
        htmlUrl: `https://github.com/acme-corp/repo-${id}`,
      });
    }

    const result = await evidence.listForUser(userId);

    expect(result.evidence).toHaveLength(4);
    expect(result.independentSources).toBe(2);
  });

  it('returns an empty, well-formed result for a user with nothing', async () => {
    const userId = await newUser();

    expect(await evidence.listForUser(userId)).toEqual({
      evidence: [],
      independentSources: 0,
      truncated: false,
    });
  });

  it('filters to one source when asked', async () => {
    const userId = await newUser();
    await seedResume(userId);
    await seedGithub(userId);

    const onlyGithub = await evidence.listForUser(userId, {
      sourceType: 'GITHUB',
    });

    expect(onlyGithub.evidence).toHaveLength(1);
    expect(onlyGithub.evidence[0]!.sourceType).toBe('GITHUB');
  });
});

describe('isolation', () => {
  /*
   * The failure this guards has no undo: returning one person's career
   * history to another. Checked against real rows because it is a claim
   * about a WHERE clause, not about a mapping.
   */
  it('never returns another user’s evidence', async () => {
    const mine = await newUser();
    const theirs = await newUser();

    await seedResume(mine);
    await seedGithub(mine);
    await seedResume(theirs);

    const result = await evidence.listForUser(theirs);

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]!.sourceType).toBe('RESUME');

    const mineIds = new Set(
      (await evidence.listForUser(mine)).evidence.map((row) => row.id),
    );

    for (const row of result.evidence) {
      expect(mineIds.has(row.id)).toBe(false);
    }
  });

  it('returns nothing for a user id with no rows, rather than everything', async () => {
    const mine = await newUser();
    await seedResume(mine);
    await seedGithub(mine);

    expect(
      (await evidence.listForUser(randomUUID())).evidence,
    ).toHaveLength(0);
  });
});

describe('ordering', () => {
  /*
   * Newest capture first, ties broken by id. The tie is not hypothetical:
   * a resume writes its evidence inside one transaction, and rows written
   * in the same millisecond leave the database free to choose an order.
   */
  it('is total, and stable across repeated reads', async () => {
    const userId = await newUser();

    const sameInstant = new Date('2026-09-05T00:00:00.000Z');

    for (let i = 0; i < 5; i += 1) {
      await prisma.evidence.create({
        data: {
          userId,
          sourceType: 'MANUAL',
          title: `tied-${i}`,
          externalId: `tie-${i}`,
          capturedAt: sameInstant,
        },
      });
    }

    const first = await evidence.listForUser(userId);
    const second = await evidence.listForUser(userId);

    expect(first.evidence.map((row) => row.id)).toEqual(
      second.evidence.map((row) => row.id),
    );

    /* And the tiebreaker really is ascending id. */
    const ids = first.evidence.map((row) => row.id);
    expect([...ids].sort()).toEqual(ids);
  });

  it('puts the most recently captured evidence first', async () => {
    const userId = await newUser();

    for (const [title, capturedAt] of [
      ['older', '2026-01-01T00:00:00.000Z'],
      ['newest', '2026-09-01T00:00:00.000Z'],
      ['middle', '2026-05-01T00:00:00.000Z'],
    ] as const) {
      await prisma.evidence.create({
        data: {
          userId,
          sourceType: 'MANUAL',
          title,
          externalId: title,
          capturedAt: new Date(capturedAt),
        },
      });
    }

    expect(
      (await evidence.listForUser(userId)).evidence.map(
        (row) => row.title,
      ),
    ).toEqual(['newest', 'middle', 'older']);
  });
});

describe('what never reaches the client', () => {
  it('carries no metadata, no independence key and no credential', async () => {
    const userId = await newUser();
    await seedResume(userId);
    await seedGithub(userId);

    const serialised = JSON.stringify(
      await evidence.listForUser(userId),
    );

    /* Provider internals live in metadata, which is never selected. */
    expect(serialised).not.toContain('metadata');
    expect(serialised).not.toContain('languages');
    expect(serialised).not.toContain('commitsAttributed');
    expect(serialised).not.toContain('nodeId');

    /* The grouping key embeds the numeric GitHub account id. */
    expect(serialised).not.toContain('independenceKey');
    expect(serialised).not.toContain('github:4820193');
    expect(serialised).not.toContain('resume:');

    /* And nothing that could ever be a credential. */
    for (const secret of [
      'accessToken',
      'access_token',
      'tokenCiphertext',
      'refresh',
      'Bearer ',
      'client_secret',
    ]) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('exposes no column the view type does not declare', async () => {
    const userId = await newUser();
    await seedGithub(userId);

    const [row] = (await evidence.listForUser(userId)).evidence;

    expect(Object.keys(row!).sort()).toEqual([
      'capturedAt',
      'description',
      'externalId',
      'id',
      'lastObservedAt',
      'occurredAt',
      'reliability',
      'sourceType',
      'sourceUrl',
      'title',
    ]);
  });
});
