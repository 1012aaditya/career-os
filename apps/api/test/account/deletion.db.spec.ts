import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountService } from '../../src/account/account.service.js';
import { UserStorageService } from '../../src/account/user-storage.service.js';
import { ResumeImportService } from '../../src/resume-import/resume-import.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import type { AuthService } from '../../src/auth/auth.service.js';
import type { SupabaseClientService } from '../../src/auth/supabase.client.js';
import type { GithubConnectionService } from '../../src/integrations/github/github-connection.service.js';
import type { CareerGraphIngestionService } from '../../src/career-graph/career-graph-ingestion.service.js';
import { marketTestDatabaseUrl } from '../market-graph/market-db.js';

/*
 * Deletion, against a real Postgres.
 *
 * Two claims cannot be tested against a double, and they are the two that
 * matter most:
 *
 *   THE CASCADE IS COMPLETE. Account deletion is one `DELETE FROM "User"`,
 *   and everything else goes because Postgres makes it go. Whether that is
 *   actually true of all thirteen owned tables and every join table
 *   between them is a fact about the schema's foreign keys, and only the
 *   database can answer it. A double would be asserting the fixture.
 *
 *   ISOLATION HOLDS. That one user's deletion leaves another user's rows
 *   untouched is again the database's behaviour, and the failure mode -
 *   deleting somebody else's career history - has no undo.
 *
 * Storage is stubbed, because reaching a real bucket from a database test
 * would make the test about the network. What storage does with a path is
 * covered exhaustively in user-storage.service.spec.ts; what is under test
 * here is what happens in Postgres.
 */

let prisma: PrismaService;
let accounts: AccountService;
let imports: ResumeImportService;
let userId: string;
let otherId: string;

const removed: string[] = [];
let storageShouldFail = false;

const storage = {
  deleteAllForUser: async (id: string, paths: readonly string[] = []) => {
    if (storageShouldFail) {
      return { deleted: 0, failed: [...paths], orphansSwept: 0 };
    }
    removed.push(...paths);
    return { deleted: paths.length, failed: [], orphansSwept: 0 };
  },
  deleteObject: async (id: string, path: string) => {
    if (!UserStorageService.belongsTo(id, path)) {
      throw new Error('Refusing to delete a path outside the user prefix');
    }
    if (storageShouldFail) {
      return false;
    }
    removed.push(path);
    return true;
  },
} as unknown as UserStorageService;

const supabase = {
  client: {
    auth: { admin: { deleteUser: async () => ({ data: null, error: null }) } },
    storage: {
      from: () => ({
        createSignedUploadUrl: async () => ({
          data: { token: 't', path: 'p' },
          error: null,
        }),
      }),
    },
  },
} as unknown as SupabaseClientService;

const github = {
  disconnect: async () => ({ disconnected: false, revokedAtProvider: false }),
} as unknown as GithubConnectionService;

const forgetProvisioning = vi.fn();
const auth = { forgetProvisioning } as unknown as AuthService;

/** Builds a user with data in every table account deletion must clear. */
async function seedUser(id: string) {
  await prisma.user.create({ data: { id } });

  const company = await prisma.company.upsert({
    where: { normalizedName: 'shared reference company' },
    update: {},
    create: {
      name: 'Shared Reference Company',
      normalizedName: 'shared reference company',
    },
  });

  const skill = await prisma.skill.upsert({
    where: { normalizedName: 'shared reference skill' },
    update: {},
    create: {
      name: 'Shared Reference Skill',
      normalizedName: 'shared reference skill',
    },
  });

  await prisma.profile.create({ data: { userId: id } });

  const experience = await prisma.experience.create({
    data: { userId: id, companyId: company.id, type: 'EMPLOYMENT', title: 'Engineer' },
  });

  const project = await prisma.project.create({
    data: { userId: id, name: 'A project' },
  });

  const achievement = await prisma.achievement.create({
    data: { userId: id, title: 'Did a thing' },
  });

  const education = await prisma.education.create({
    data: { userId: id, institution: 'A university' },
  });

  await prisma.userSkill.create({ data: { userId: id, skillId: skill.id } });
  await prisma.goal.create({ data: { userId: id, title: 'A goal' } });

  const resumeImport = await prisma.resumeImport.create({
    data: {
      userId: id,
      fileName: 'resume.pdf',
      storagePath: `${id}/import/resume.pdf`,
      status: 'CONFIRMED',
    },
  });

  await prisma.careerGraphIngestion.create({
    data: { userId: id, resumeImportId: resumeImport.id },
  });

  const evidence = await prisma.evidence.create({
    data: {
      userId: id,
      resumeImportId: resumeImport.id,
      sourceType: 'RESUME',
      title: 'Resume: resume.pdf',
    },
  });

  /* The join tables, which cascade transitively rather than from User. */
  await prisma.evidenceExperience.create({
    data: { evidenceId: evidence.id, experienceId: experience.id },
  });
  await prisma.evidenceProject.create({
    data: { evidenceId: evidence.id, projectId: project.id },
  });
  await prisma.evidenceSkill.create({
    data: { evidenceId: evidence.id, skillId: skill.id },
  });
  await prisma.evidenceAchievement.create({
    data: { evidenceId: evidence.id, achievementId: achievement.id },
  });
  await prisma.evidenceEducation.create({
    data: { evidenceId: evidence.id, educationId: education.id },
  });
  await prisma.experienceSkill.create({
    data: { experienceId: experience.id, skillId: skill.id },
  });
  await prisma.experienceProject.create({
    data: { experienceId: experience.id, projectId: project.id },
  });
  await prisma.experienceAchievement.create({
    data: { experienceId: experience.id, achievementId: achievement.id },
  });
  await prisma.projectSkill.create({
    data: { projectId: project.id, skillId: skill.id },
  });
  await prisma.projectAchievement.create({
    data: { projectId: project.id, achievementId: achievement.id },
  });

  return { resumeImportId: resumeImport.id, evidenceId: evidence.id };
}

/** Every row anywhere that belongs to this user, counted. */
async function countUserRows(id: string): Promise<Record<string, number>> {
  return {
    user: await prisma.user.count({ where: { id } }),
    profile: await prisma.profile.count({ where: { userId: id } }),
    experience: await prisma.experience.count({ where: { userId: id } }),
    project: await prisma.project.count({ where: { userId: id } }),
    achievement: await prisma.achievement.count({ where: { userId: id } }),
    education: await prisma.education.count({ where: { userId: id } }),
    userSkill: await prisma.userSkill.count({ where: { userId: id } }),
    goal: await prisma.goal.count({ where: { userId: id } }),
    resumeImport: await prisma.resumeImport.count({ where: { userId: id } }),
    ingestion: await prisma.careerGraphIngestion.count({ where: { userId: id } }),
    evidence: await prisma.evidence.count({ where: { userId: id } }),
    evidenceExperience: await prisma.evidenceExperience.count({
      where: { evidence: { userId: id } },
    }),
    evidenceProject: await prisma.evidenceProject.count({
      where: { evidence: { userId: id } },
    }),
    evidenceSkill: await prisma.evidenceSkill.count({
      where: { evidence: { userId: id } },
    }),
    evidenceAchievement: await prisma.evidenceAchievement.count({
      where: { evidence: { userId: id } },
    }),
    evidenceEducation: await prisma.evidenceEducation.count({
      where: { evidence: { userId: id } },
    }),
    experienceSkill: await prisma.experienceSkill.count({
      where: { experience: { userId: id } },
    }),
    experienceProject: await prisma.experienceProject.count({
      where: { experience: { userId: id } },
    }),
    experienceAchievement: await prisma.experienceAchievement.count({
      where: { experience: { userId: id } },
    }),
    projectSkill: await prisma.projectSkill.count({
      where: { project: { userId: id } },
    }),
    projectAchievement: await prisma.projectAchievement.count({
      where: { project: { userId: id } },
    }),
  };
}

beforeAll(() => {
  process.env.DATABASE_URL = marketTestDatabaseUrl();

  prisma = new PrismaService();
  accounts = new AccountService(prisma, supabase, storage, github, auth);
  imports = new ResumeImportService(
    prisma,
    supabase,
    {} as CareerGraphIngestionService,
    storage,
  );
});

afterAll(async () => {
  if (prisma !== undefined) {
    const ids = [userId, otherId].filter(
      (id): id is string => typeof id === 'string',
    );

    if (ids.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }

    await prisma.$disconnect();
  }
});

beforeEach(async () => {
  removed.length = 0;
  storageShouldFail = false;
  forgetProvisioning.mockClear();

  /* Guarded: on the first run these are undefined, and Prisma refuses an
   * `in` array containing undefined. */
  const previous = [userId, otherId].filter(
    (id): id is string => typeof id === 'string',
  );

  if (previous.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: previous } } });
  }

  userId = randomUUID();
  otherId = randomUUID();
});

describe('deleting an account', () => {
  it('leaves no row anywhere that belonged to the user', async () => {
    await seedUser(userId);

    const before = await countUserRows(userId);

    /* The fixture is not vacuous: every table actually had a row. */
    for (const [table, count] of Object.entries(before)) {
      expect(`${table}=${count}`).toBe(`${table}=1`);
    }

    await accounts.deleteAccount(userId);

    const after = await countUserRows(userId);

    for (const [table, count] of Object.entries(after)) {
      expect(`${table}=${count}`).toBe(`${table}=0`);
    }
  });

  /*
   * The other half of "complete deletion": not deleting too much. Company
   * and Skill are shared vocabulary referenced by every user's graph, and
   * cascading through them would corrupt everybody else's data.
   */
  it('keeps shared vocabulary that other users depend on', async () => {
    await seedUser(userId);

    const companies = await prisma.company.count();
    const skills = await prisma.skill.count();

    await accounts.deleteAccount(userId);

    expect(await prisma.company.count()).toBe(companies);
    expect(await prisma.skill.count()).toBe(skills);
  });

  /*
   * THE isolation test. If this ever fails, one person deleting their
   * account has deleted somebody else's career history.
   */
  it('does not touch another user', async () => {
    await seedUser(userId);
    await seedUser(otherId);

    await accounts.deleteAccount(userId);

    const survivor = await countUserRows(otherId);

    for (const [table, count] of Object.entries(survivor)) {
      expect(`${table}=${count}`).toBe(`${table}=1`);
    }
  });

  it('hands storage only the paths that belong to the user', async () => {
    await seedUser(userId);
    await seedUser(otherId);

    await accounts.deleteAccount(userId);

    expect(removed).toEqual([`${userId}/import/resume.pdf`]);
    expect(removed.join(' ')).not.toContain(otherId);
  });

  it('clears the provisioning cache for the deleted user', async () => {
    await seedUser(userId);

    await accounts.deleteAccount(userId);

    expect(forgetProvisioning).toHaveBeenCalledWith(userId);
  });

  it('is safe to repeat', async () => {
    await seedUser(userId);

    await accounts.deleteAccount(userId);
    const second = await accounts.deleteAccount(userId);

    expect(second.databaseRecordDeleted).toBe(false);
    expect(await prisma.user.count({ where: { id: userId } })).toBe(0);
  });

  /*
   * The abort path, against the real database: a storage failure must
   * leave every row intact so the user can retry.
   */
  it('deletes nothing when storage fails', async () => {
    await seedUser(userId);

    storageShouldFail = true;

    await expect(accounts.deleteAccount(userId)).rejects.toThrow(
      /Nothing was deleted/,
    );

    const after = await countUserRows(userId);

    for (const [table, count] of Object.entries(after)) {
      expect(`${table}=${count}`).toBe(`${table}=1`);
    }
  });
});

describe('deleting one resume import', () => {
  it('removes the import, its evidence and its file', async () => {
    const seeded = await seedUser(userId);

    const result = await imports.remove(userId, seeded.resumeImportId);

    expect(result.deleted).toBe(true);
    expect(result.evidenceDeleted).toBe(1);
    expect(removed).toEqual([`${userId}/import/resume.pdf`]);

    expect(
      await prisma.resumeImport.count({ where: { id: seeded.resumeImportId } }),
    ).toBe(0);
    expect(await prisma.evidence.count({ where: { userId } })).toBe(0);
    /* The ingestion record cascades from the import. */
    expect(await prisma.careerGraphIngestion.count({ where: { userId } })).toBe(
      0,
    );
  });

  /*
   * The documented boundary. Experience, Project, Education, Achievement
   * and UserSkill carry no reference to the import that produced them, so
   * "the career data from this resume" is not something the schema can
   * express. They are kept, and the response says so.
   */
  it('keeps career graph rows it cannot attribute to this resume', async () => {
    const seeded = await seedUser(userId);

    const result = await imports.remove(userId, seeded.resumeImportId);

    expect(result.careerGraphRetained).toBe(true);
    expect(await prisma.experience.count({ where: { userId } })).toBe(1);
    expect(await prisma.project.count({ where: { userId } })).toBe(1);
    expect(await prisma.education.count({ where: { userId } })).toBe(1);
    expect(await prisma.achievement.count({ where: { userId } })).toBe(1);
    expect(await prisma.userSkill.count({ where: { userId } })).toBe(1);
  });

  /*
   * IDOR, against the real database. A valid id belonging to somebody else
   * must be indistinguishable from one that never existed - the difference
   * is exactly what an id-guessing attack is looking for.
   */
  it('cannot delete another user import', async () => {
    const mine = await seedUser(userId);
    const theirs = await seedUser(otherId);

    await expect(imports.remove(userId, theirs.resumeImportId)).rejects.toThrow(
      /not found/i,
    );

    /* Theirs is intact, and no file of theirs was touched. */
    expect(
      await prisma.resumeImport.count({ where: { id: theirs.resumeImportId } }),
    ).toBe(1);
    expect(removed).toEqual([]);

    /* And mine still works, so the refusal was about ownership. */
    await expect(imports.remove(userId, mine.resumeImportId)).resolves.toMatchObject(
      { deleted: true },
    );
  });

  it('answers a non-existent id the same way as another user id', async () => {
    await seedUser(userId);

    await expect(imports.remove(userId, randomUUID())).rejects.toThrow(
      /not found/i,
    );
  });

  it('deletes no rows when the file could not be removed', async () => {
    const seeded = await seedUser(userId);

    storageShouldFail = true;

    await expect(imports.remove(userId, seeded.resumeImportId)).rejects.toThrow(
      /Nothing was deleted/,
    );

    expect(
      await prisma.resumeImport.count({ where: { id: seeded.resumeImportId } }),
    ).toBe(1);
    expect(await prisma.evidence.count({ where: { userId } })).toBe(1);
  });
});
