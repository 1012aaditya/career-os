import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CareerGraphIngestionService } from '../../src/career-graph/career-graph-ingestion.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { classify } from '../../src/evidence/trust.js';
import { marketTestDatabaseUrl } from '../market-graph/market-db.js';

/*
 * What a resume declares about itself, against a real Postgres.
 *
 * The database tier rather than a double, for the reason this tier exists:
 * the claim is about the ROW the producer writes - its column values, its
 * defaults, and the joins created alongside it in the same transaction. A
 * double would be asserting the fixture.
 *
 * It also happens to be the first test of this producer at all. The
 * ingestion service had none, which is how a resume could be the only
 * evidence the Career Graph consumes while saying nothing about what kind
 * of evidence it is.
 */

let prisma: PrismaService;
let ingestion: CareerGraphIngestionService;

const EXTRACTION = {
  extraction: {
    basics: {
      name: 'A Person',
      email: 'person@example.com',
    },
    skills: ['TypeScript', 'PostgreSQL', 'Kubernetes'],
    experience: [
      {
        company: 'Acme',
        role: 'Engineer',
        start_date: '2023-01',
        end_date: '2024-06',
      },
    ],
    projects: [{ name: 'Ledger', description: 'A ledger' }],
    education: [
      {
        institution: 'A University',
        degree: 'BSc',
        field_of_study: 'Computer Science',
      },
    ],
    achievements: [{ title: 'Shipped something' }],
  },
};

async function seedConfirmedImport(userId: string): Promise<string> {
  await prisma.user.create({ data: { id: userId } });

  const created = await prisma.resumeImport.create({
    data: {
      userId,
      fileName: 'cv.pdf',
      storagePath: `${userId}/${randomUUID()}/cv.pdf`,
      status: 'CONFIRMED',
      extractionResult: EXTRACTION,
    },
  });

  return created.id;
}

async function evidenceFor(userId: string) {
  return await prisma.evidence.findFirstOrThrow({
    where: { userId, sourceType: 'RESUME' },
  });
}

beforeAll(() => {
  process.env.DATABASE_URL = marketTestDatabaseUrl();

  prisma = new PrismaService();
  ingestion = new CareerGraphIngestionService(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const users: string[] = [];

beforeEach(async () => {
  if (users.length > 0) {
    await prisma.user.deleteMany({
      where: { id: { in: users.filter(Boolean) } },
    });
    users.length = 0;
  }
});

describe('what a resume declares about itself', () => {
  it('declares a user claim, asserted by the user, of unknown coverage', async () => {
    const userId = randomUUID();
    users.push(userId);

    const importId = await seedConfirmedImport(userId);
    await ingestion.ingestConfirmedResume(userId, importId);

    const evidence = await evidenceFor(userId);

    expect(evidence.authenticity).toBe('USER_CLAIM');
    expect(evidence.attribution).toBe('USER_ASSERTED');
    expect(evidence.completeness).toBe('UNKNOWN');
    expect(evidence.transformVersion).toBe(1);
  });

  it('keys independence on the import, not on anything the resume says', async () => {
    const userId = randomUUID();
    users.push(userId);

    const importId = await seedConfirmedImport(userId);
    await ingestion.ingestConfirmedResume(userId, importId);

    const evidence = await evidenceFor(userId);

    expect(evidence.independenceKey).toBe(`resume:${importId}`);

    /*
     * Nothing the document CONTAINS may appear in the key. A name, an
     * address or an employer deciding independence would let two people
     * who worked at the same company silently share a source.
     */
    for (const leaked of [
      'A Person',
      'person@example.com',
      'Acme',
      'Engineer',
      'cv.pdf',
    ]) {
      expect(evidence.independenceKey).not.toContain(leaked);
    }
  });

  /*
   * THE property this key exists for. One resume produced skill,
   * experience, project, education and achievement joins; every one of
   * them points at a single Evidence row carrying a single key, so no
   * amount of extraction can manufacture a second independent source.
   */
  it('stays one source however many joins the import produced', async () => {
    const userId = randomUUID();
    users.push(userId);

    const importId = await seedConfirmedImport(userId);
    await ingestion.ingestConfirmedResume(userId, importId);

    const evidence = await evidenceFor(userId);

    const joins = await Promise.all([
      prisma.evidenceSkill.count({ where: { evidenceId: evidence.id } }),
      prisma.evidenceExperience.count({
        where: { evidenceId: evidence.id },
      }),
      prisma.evidenceProject.count({ where: { evidenceId: evidence.id } }),
      prisma.evidenceEducation.count({
        where: { evidenceId: evidence.id },
      }),
      prisma.evidenceAchievement.count({
        where: { evidenceId: evidence.id },
      }),
    ]);

    /* The joins really were created - otherwise this proves nothing. */
    expect(joins.reduce((a, b) => a + b, 0)).toBeGreaterThan(3);

    const keys = await prisma.evidence.findMany({
      where: { userId, sourceType: 'RESUME' },
      select: { independenceKey: true },
    });

    expect(new Set(keys.map((row) => row.independenceKey)).size).toBe(1);
  });

  it('gives two imports by one user two different keys', async () => {
    const userId = randomUUID();
    users.push(userId);

    const first = await seedConfirmedImport(userId);
    await ingestion.ingestConfirmedResume(userId, first);

    const second = await prisma.resumeImport.create({
      data: {
        userId,
        fileName: 'cv-2.pdf',
        storagePath: `${userId}/${randomUUID()}/cv-2.pdf`,
        status: 'CONFIRMED',
        extractionResult: EXTRACTION,
      },
    });

    await ingestion.ingestConfirmedResume(userId, second.id);

    const rows = await prisma.evidence.findMany({
      where: { userId, sourceType: 'RESUME' },
      select: { independenceKey: true },
    });

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.independenceKey)).size).toBe(2);
  });

  it('cannot collide across users, because an import belongs to one', async () => {
    const mine = randomUUID();
    const theirs = randomUUID();
    users.push(mine, theirs);

    const myImport = await seedConfirmedImport(mine);
    const theirImport = await seedConfirmedImport(theirs);

    await ingestion.ingestConfirmedResume(mine, myImport);
    await ingestion.ingestConfirmedResume(theirs, theirImport);

    const a = await evidenceFor(mine);
    const b = await evidenceFor(theirs);

    expect(a.independenceKey).not.toBe(b.independenceKey);
  });
});

describe('when a resume was observed', () => {
  it('records lastObservedAt equal to capturedAt, exactly', async () => {
    const userId = randomUUID();
    users.push(userId);

    const importId = await seedConfirmedImport(userId);
    await ingestion.ingestConfirmedResume(userId, importId);

    const evidence = await evidenceFor(userId);

    expect(evidence.lastObservedAt).not.toBeNull();
    expect(evidence.lastObservedAt!.getTime()).toBe(
      evidence.capturedAt.getTime(),
    );
  });

  /*
   * A resume is read once and never re-consulted, so there is no later
   * moment at which it could be re-verified. A timestamp ahead of capture
   * would assert a verification that never happened.
   */
  it('invents no verification later than the capture', async () => {
    const before = Date.now();

    const userId = randomUUID();
    users.push(userId);

    const importId = await seedConfirmedImport(userId);
    await ingestion.ingestConfirmedResume(userId, importId);

    const evidence = await evidenceFor(userId);
    const after = Date.now();

    expect(evidence.lastObservedAt!.getTime()).toBeGreaterThanOrEqual(
      before,
    );
    expect(evidence.lastObservedAt!.getTime()).toBeLessThanOrEqual(after);
  });
});

describe('how a resume classifies', () => {
  /*
   * End to end through the approved precedence, with no fixture in the
   * middle: the row the producer actually wrote is handed to the real
   * classifier.
   *
   * WEAK rather than UNVERIFIED is the deliberate product decision from
   * the Commit 2 review. A resume is a known claim, not an unexamined
   * gap, and UNKNOWN completeness on it means "not applicable" rather
   * than "we tried to look and failed".
   */
  it('is WEAK - a known claim, not an unexamined gap', async () => {
    const userId = randomUUID();
    users.push(userId);

    const importId = await seedConfirmedImport(userId);
    await ingestion.ingestConfirmedResume(userId, importId);

    const evidence = await evidenceFor(userId);

    expect(
      classify(
        [
          {
            sourceType: evidence.sourceType,
            title: evidence.title,
            description: evidence.description,
            sourceUrl: evidence.sourceUrl,
            externalId: evidence.externalId,
            occurredAt: evidence.occurredAt,
            capturedAt: evidence.capturedAt,
            lastObservedAt: evidence.lastObservedAt,
            authenticity: evidence.authenticity,
            attribution: evidence.attribution,
            completeness: evidence.completeness,
            transformVersion: evidence.transformVersion,
            independenceKey: evidence.independenceKey,
            metadata: evidence.metadata,
          },
        ],
        new Date(),
      ),
    ).toBe('WEAK');
  });
});

describe('everything else the producer did before', () => {
  /*
   * The regression guard for the freeze. The contract declaration must be
   * the ONLY change: the same graph rows, the same joins, the same
   * ingestion ledger entry.
   */
  it('still builds the career graph it always built', async () => {
    const userId = randomUUID();
    users.push(userId);

    const importId = await seedConfirmedImport(userId);
    await ingestion.ingestConfirmedResume(userId, importId);

    const [skills, experiences, projects, educations, achievements, ledger] =
      await Promise.all([
        prisma.userSkill.count({ where: { userId } }),
        prisma.experience.count({ where: { userId } }),
        prisma.project.count({ where: { userId } }),
        prisma.education.count({ where: { userId } }),
        prisma.achievement.count({ where: { userId } }),
        prisma.careerGraphIngestion.count({ where: { userId } }),
      ]);

    expect(skills).toBe(3);
    expect(experiences).toBe(1);
    expect(projects).toBe(1);
    expect(educations).toBe(1);
    expect(achievements).toBe(1);
    expect(ledger).toBe(1);
  });

  it('leaves the import confirmed and writes exactly one evidence row', async () => {
    const userId = randomUUID();
    users.push(userId);

    const importId = await seedConfirmedImport(userId);
    await ingestion.ingestConfirmedResume(userId, importId);

    const updated = await prisma.resumeImport.findUniqueOrThrow({
      where: { id: importId },
    });

    /* Ingestion is only reachable for a confirmed import, and it leaves
     * it that way - one resume yields one evidence row, not one per run. */
    expect(updated.status).toBe('CONFIRMED');
    expect(
      await prisma.evidence.count({
        where: { userId, sourceType: 'RESUME' },
      }),
    ).toBe(1);
  });
});
