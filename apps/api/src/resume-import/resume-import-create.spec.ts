import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { ResumeImportService } from './resume-import.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SupabaseClientService } from '../auth/supabase.client.js';
import type { CareerGraphIngestionService } from '../career-graph/career-graph-ingestion.service.js';
import { MAX_ACTIVE_IMPORTS, MAX_IMPORTS_PER_WINDOW } from './upload-policy.js';

/*
 * Starting an import.
 *
 * What is under test is the gate in front of `create`: what the server
 * refuses, in what order it refuses it, and what it does when storage
 * fails after a row already exists.
 *
 * The ORDERING of the transaction is asserted here, not the isolation. A
 * double cannot reproduce `FOR UPDATE` - it has no rows and no locks - so
 * what this file proves is that the lock is taken before anything is
 * counted, which is the part that is ours to get right. That the lock then
 * actually serialises two concurrent callers is Postgres's behaviour, and
 * it is proved against a real database in
 * `test/resume-import/import-limits.db.spec.ts`.
 */

const NOW = new Date('2026-03-01T12:00:00.000Z');

function makeService(
  options: {
    active?: number;
    recent?: number;
    storageError?: { message: string } | null;
  } = {},
) {
  const calls: string[] = [];
  const created: Record<string, unknown>[] = [];
  const updates: { where: unknown; data: Record<string, unknown> }[] = [];

  const counts = [options.active ?? 0, options.recent ?? 0];
  let countCall = 0;

  const tx = {
    $queryRaw: vi.fn(async () => {
      calls.push('lock');
      return [{ id: 'user-1' }];
    }),
    resumeImport: {
      count: vi.fn(async () => {
        calls.push(countCall === 0 ? 'count:active' : 'count:recent');
        return counts[countCall++] ?? 0;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        calls.push('create');
        created.push(data);
        return { ...data, status: 'PENDING' };
      }),
    },
  };

  const prisma = {
    $transaction: vi.fn(
      async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    ),
    resumeImport: {
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        updates.push(args);
        return {};
      }),
    },
  } as unknown as PrismaService;

  const createSignedUploadUrl = vi.fn(async () =>
    options.storageError
      ? { data: null, error: options.storageError }
      : { data: { token: 'upload-token', path: 'p' }, error: null },
  );

  const supabase = {
    client: { storage: { from: () => ({ createSignedUploadUrl }) } },
  } as unknown as SupabaseClientService;

  const service = new ResumeImportService(
    prisma,
    supabase,
    {} as CareerGraphIngestionService,
  );

  return { service, calls, created, updates, createSignedUploadUrl, prisma };
}

describe('refusing a file the server will not accept', () => {
  /*
   * The mobile app checks for a .pdf before uploading. That check is a
   * courtesy to the user and not a control: anything holding a bearer
   * token calls this directly and the app's check never runs.
   */
  it.each([
    ['resume.docx', 'Only PDF resumes are supported'],
    ['resume', 'Only PDF resumes are supported'],
    ['   ', 'A file name is required'],
  ])('refuses %s', async (fileName, message) => {
    const { service, prisma } = makeService();

    await expect(service.create('user-1', fileName, NOW)).rejects.toThrow(
      message,
    );

    /* Refused before anything was written or reserved. */
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses before touching storage', async () => {
    const { service, createSignedUploadUrl } = makeService();

    await expect(
      service.create('user-1', 'resume.docx', NOW),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });
});

describe('the per-user limits', () => {
  it('creates an import when the user is under both limits', async () => {
    const { service, created } = makeService({ active: 1, recent: 3 });

    const result = await service.create('user-1', 'Jane Resume.pdf', NOW);

    expect(created).toHaveLength(1);
    expect(result.uploadToken).toBe('upload-token');
  });

  it('refuses once the active cap is reached', async () => {
    const { service, created } = makeService({ active: MAX_ACTIVE_IMPORTS });

    await expect(
      service.create('user-1', 'resume.pdf', NOW),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(created).toHaveLength(0);
  });

  it('refuses once the rolling window is full, even with nothing active', async () => {
    const { service, created } = makeService({
      active: 0,
      recent: MAX_IMPORTS_PER_WINDOW,
    });

    await expect(
      service.create('user-1', 'resume.pdf', NOW),
    ).rejects.toBeInstanceOf(ConflictException);

    /*
     * The case the active cap alone does not cover: a caller that creates
     * an import and abandons it accumulates no active rows, but does
     * accumulate rows and storage objects.
     */
    expect(created).toHaveLength(0);
  });

  /*
   * The ordering that makes the check-then-act race impossible. If the
   * count ran before the lock, two callers could both read the same value
   * and both decide there was room.
   */
  it('takes the user lock before it counts anything', async () => {
    const { service, calls } = makeService();

    await service.create('user-1', 'resume.pdf', NOW);

    expect(calls).toEqual(['lock', 'count:active', 'count:recent', 'create']);
    expect(calls.indexOf('lock')).toBeLessThan(calls.indexOf('count:active'));
  });

  it('does all of it inside one transaction', async () => {
    const { service, prisma } = makeService();

    await service.create('user-1', 'resume.pdf', NOW);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('when storage will not mint an upload URL', () => {
  /*
   * A raw storage error names buckets, internal endpoints and sometimes
   * request ids. None of that helps the person holding the phone, and all
   * of it describes our infrastructure to whoever asked.
   */
  it('returns a stable sentence rather than the provider text', async () => {
    const { service } = makeService({
      storageError: { message: 'Bucket "resumes" not found on tenant abc-123' },
    });

    const error = await service
      .create('user-1', 'resume.pdf', NOW)
      .catch((caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toBe(
      'Unable to start the resume upload. Please try again.',
    );
    expect(error.message).not.toContain('Bucket');
    expect(error.message).not.toContain('abc-123');
  });

  /* The real cause is still kept, on the row, where its owner can see it. */
  it('records the provider cause internally on the import', async () => {
    const { service, updates } = makeService({
      storageError: { message: 'Bucket "resumes" not found on tenant abc-123' },
    });

    await service.create('user-1', 'resume.pdf', NOW).catch(() => undefined);

    expect(updates).toHaveLength(1);
    expect(updates[0]?.data).toMatchObject({
      status: 'FAILED',
      errorMessage: 'Bucket "resumes" not found on tenant abc-123',
    });
  });

  it('marks the import FAILED rather than leaving it PENDING forever', async () => {
    const { service, updates } = makeService({
      storageError: { message: 'nope' },
    });

    await service.create('user-1', 'resume.pdf', NOW).catch(() => undefined);

    expect(updates[0]?.data.status).toBe('FAILED');
  });
});

describe('the storage path it builds', () => {
  it('scopes the object under the user and the import', async () => {
    const { service, created } = makeService();

    await service.create('user-1', 'Jane Doe Resume.pdf', NOW);

    const path = created[0]?.storagePath as string;

    expect(path.startsWith('user-1/')).toBe(true);
    expect(path.endsWith('/Jane_Doe_Resume.pdf')).toBe(true);
  });

  /*
   * Path traversal, end to end through create(). Separators are outside
   * the sanitiser's allowlist, so the name cannot climb out of its prefix.
   */
  it('cannot be walked out of the user prefix', async () => {
    const { service, created } = makeService();

    await service.create('user-1', '../../other-user/steal.pdf', NOW);

    const path = created[0]?.storagePath as string;

    expect(path.startsWith('user-1/')).toBe(true);
    expect(path.split('/')).toHaveLength(3);
    expect(path).not.toContain('..' + '/');
  });

  /* The name the user sees is the one they gave, unsanitised. */
  it('keeps the original name for display', async () => {
    const { service, created } = makeService();

    await service.create('user-1', 'Jane Doe Resume.pdf', NOW);

    expect(created[0]?.fileName).toBe('Jane Doe Resume.pdf');
  });
});
