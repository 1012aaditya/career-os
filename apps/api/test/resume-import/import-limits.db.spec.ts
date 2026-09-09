import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ResumeImportService } from '../../src/resume-import/resume-import.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import type { SupabaseClientService } from '../../src/auth/supabase.client.js';
import type { CareerGraphIngestionService } from '../../src/career-graph/career-graph-ingestion.service.js';
import {
  MAX_ACTIVE_IMPORTS,
  MAX_IMPORTS_PER_WINDOW,
} from '../../src/resume-import/upload-policy.js';
import { marketTestDatabaseUrl } from '../market-graph/market-db.js';

/*
 * The per-user import cap, against a real Postgres.
 *
 * This is in the database tier for the reason the tier exists: what is
 * being tested IS the database's behaviour. The unit spec can prove the
 * service asks for a row lock before it counts; it cannot prove that the
 * lock then serialises two callers, because a double has no rows and no
 * locks. Only Postgres can answer that, and the check-then-act race is
 * precisely the kind of bug that passes every test against a double and
 * then happens in production the first week.
 *
 * The failure this guards against, stated plainly:
 *
 *   request A counts 2 active imports, decides there is room for a third
 *   request B counts 2 active imports, decides there is room for a third
 *   both create one, and the user now has four
 */

let prisma: PrismaService;
let service: ResumeImportService;
let userId: string;

/*
 * Storage is stubbed. `create` reaches it only AFTER the transaction has
 * committed, so it is irrelevant to what this file tests - and reaching a
 * real storage service from a database test would make the test about the
 * network.
 */
const supabase = {
  client: {
    storage: {
      from: () => ({
        createSignedUploadUrl: async () => ({
          data: { token: 'stub-token', path: 'stub-path' },
          error: null,
        }),
      }),
    },
  },
} as unknown as SupabaseClientService;

beforeAll(() => {
  process.env.DATABASE_URL = marketTestDatabaseUrl();

  prisma = new PrismaService();
  service = new ResumeImportService(
    prisma,
    supabase,
    {} as CareerGraphIngestionService,
  );
});

afterAll(async () => {
  if (prisma !== undefined) {
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }
});

beforeEach(async () => {
  /*
   * A fresh user per test, and the imports cascade away with them. This
   * tier shares one database with the market-graph specs, which truncate
   * only Market tables - so cleaning up after ourselves is not optional.
   */
  if (userId !== undefined) {
    await prisma.user.deleteMany({ where: { id: userId } });
  }

  userId = randomUUID();
  await prisma.user.create({ data: { id: userId } });
});

describe('the active-import cap', () => {
  it('lets a user start imports up to the cap', async () => {
    for (let index = 0; index < MAX_ACTIVE_IMPORTS; index += 1) {
      await expect(
        service.create(userId, `resume-${index}.pdf`),
      ).resolves.toMatchObject({ status: 'PENDING' });
    }

    expect(await prisma.resumeImport.count({ where: { userId } })).toBe(
      MAX_ACTIVE_IMPORTS,
    );
  });

  it('refuses the one after the cap', async () => {
    for (let index = 0; index < MAX_ACTIVE_IMPORTS; index += 1) {
      await service.create(userId, `resume-${index}.pdf`);
    }

    await expect(service.create(userId, 'one-too-many.pdf')).rejects.toThrow(
      /already have/i,
    );
  });

  /*
   * The bug that would look like a policy: counting terminal statuses
   * would mean a user hits the cap permanently after three uploads and can
   * never import again.
   */
  it('does not count imports that have finished', async () => {
    for (let index = 0; index < MAX_ACTIVE_IMPORTS; index += 1) {
      await service.create(userId, `resume-${index}.pdf`);
    }

    await prisma.resumeImport.updateMany({
      where: { userId },
      data: { status: 'CONFIRMED' },
    });

    await expect(service.create(userId, 'next.pdf')).resolves.toMatchObject({
      status: 'PENDING',
    });
  });

  it('counts each user separately', async () => {
    const other = randomUUID();
    await prisma.user.create({ data: { id: other } });

    try {
      for (let index = 0; index < MAX_ACTIVE_IMPORTS; index += 1) {
        await service.create(userId, `resume-${index}.pdf`);
      }

      /* The other user is unaffected by the first user's cap. */
      await expect(service.create(other, 'theirs.pdf')).resolves.toMatchObject({
        status: 'PENDING',
      });
    } finally {
      await prisma.user.deleteMany({ where: { id: other } });
    }
  });
});

describe('concurrent requests', () => {
  /*
   * THE test in this file. Ten creations fired at once against an empty
   * quota: without the row lock several of them read "0 active" before any
   * of them wrote, and the user ends up over the cap. With it, Postgres
   * serialises them and exactly MAX_ACTIVE_IMPORTS get through.
   */
  it('cannot be raced past the cap', async () => {
    const attempts = 10;

    const results = await Promise.allSettled(
      Array.from({ length: attempts }, (_, index) =>
        service.create(userId, `race-${index}.pdf`),
      ),
    );

    const created = results.filter(
      (result) => result.status === 'fulfilled',
    ).length;

    expect(created).toBe(MAX_ACTIVE_IMPORTS);

    /* And the database agrees, which is the claim that actually matters. */
    expect(await prisma.resumeImport.count({ where: { userId } })).toBe(
      MAX_ACTIVE_IMPORTS,
    );
  });

  it('rejects the losers with a conflict rather than a crash', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        service.create(userId, `race-${index}.pdf`),
      ),
    );

    const rejections = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(rejections.length).toBeGreaterThan(0);

    for (const rejection of rejections) {
      /*
       * A refusal, not a constraint violation or a deadlock leaking
       * through. The user is told they have too many in progress.
       */
      expect((rejection.reason as Error).message).toMatch(/already have/i);
    }
  });

  /*
   * Two different users creating at the same time must not block each
   * other: the lock is on the user row, so contention is per-user by
   * construction. If this ever fails, the lock has been widened to
   * something shared and every upload in the system is now serialised.
   */
  it('does not serialise unrelated users', async () => {
    const others = [randomUUID(), randomUUID(), randomUUID()];

    await prisma.user.createMany({ data: others.map((id) => ({ id })) });

    try {
      const results = await Promise.allSettled(
        others.map((id) => service.create(id, 'resume.pdf')),
      );

      expect(
        results.every((result) => result.status === 'fulfilled'),
      ).toBe(true);
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: others } } });
    }
  });
});

describe('the rolling window', () => {
  /*
   * The case the active cap alone does not cover: a caller that creates an
   * import and abandons it accumulates no ACTIVE rows, but does accumulate
   * database rows and storage objects indefinitely.
   */
  it('bounds abandoned imports that never stay active', async () => {
    for (let index = 0; index < MAX_IMPORTS_PER_WINDOW; index += 1) {
      await service.create(userId, `abandoned-${index}.pdf`);

      /* Immediately terminal, so the active cap never sees them. */
      await prisma.resumeImport.updateMany({
        where: { userId, status: 'PENDING' },
        data: { status: 'FAILED' },
      });
    }

    await expect(service.create(userId, 'one-more.pdf')).rejects.toThrow(
      /too many/i,
    );
  });

  /*
   * The window rolls. An hour later the same user is free again, which is
   * what makes this a rate limit rather than a lifetime quota.
   */
  it('lets the user back in once the window has passed', async () => {
    for (let index = 0; index < MAX_IMPORTS_PER_WINDOW; index += 1) {
      await service.create(userId, `filled-${index}.pdf`);
      await prisma.resumeImport.updateMany({
        where: { userId, status: 'PENDING' },
        data: { status: 'FAILED' },
      });
    }

    const laterStill = new Date(Date.now() + 61 * 60 * 1000);

    await expect(
      service.create(userId, 'after-the-window.pdf', laterStill),
    ).resolves.toMatchObject({ status: 'PENDING' });
  });
});
