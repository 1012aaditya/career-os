import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { ResumeProcessingService } from './resume-processing.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SupabaseClientService } from '../auth/supabase.client.js';
import { MAX_FILE_BYTES } from '../resume-import/upload-policy.js';

/*
 * The worker's gate to the bytes.
 *
 * This is the only place the real file is ever judged, and that is the
 * point of the tests below. At upload time the API knows a filename the
 * client chose and nothing else - it never sees the bytes, deliberately.
 * By the time the worker asks for a download link the object exists, so
 * storage can be asked what it is actually holding: a size and a content
 * type that no client supplied.
 *
 * The second property under test is that a refusal FAILS the import. A
 * file that will not parse now will not parse on the next attempt either,
 * and leaving the row in PROCESSING would let it be claimed forever.
 */

const IMPORT = {
  id: 'import-1',
  userId: 'user-1',
  fileName: 'Jane Doe Resume.pdf',
  storagePath: 'user-1/import-1/Jane_Doe_Resume.pdf',
  status: 'PROCESSING',
};

function makeService(options: {
  row?: Record<string, unknown> | null;
  info?: { data: unknown; error: unknown };
  signedUrl?: { data: unknown; error: unknown };
}) {
  const updates: { where: unknown; data: Record<string, unknown> }[] = [];

  const prisma = {
    resumeImport: {
      findUnique: vi.fn(async () =>
        options.row === undefined ? IMPORT : options.row,
      ),
      updateMany: vi.fn(
        async (args: { where: unknown; data: Record<string, unknown> }) => {
          updates.push(args);
          return { count: 1 };
        },
      ),
    },
  } as unknown as PrismaService;

  const info = vi.fn(async () =>
    options.info ?? {
      data: { size: 120_000, contentType: 'application/pdf' },
      error: null,
    },
  );

  const createSignedUrl = vi.fn(async () =>
    options.signedUrl ?? {
      data: { signedUrl: 'https://storage.invalid/signed' },
      error: null,
    },
  );

  const supabase = {
    client: { storage: { from: () => ({ info, createSignedUrl }) } },
  } as unknown as SupabaseClientService;

  return {
    service: new ResumeProcessingService(prisma, supabase),
    updates,
    info,
    createSignedUrl,
  };
}

describe('handing a worker the file', () => {
  it('returns a short-lived signed URL for a real PDF', async () => {
    const { service, createSignedUrl } = makeService({});

    const result = await service.getFileUrl('import-1');

    expect(result.signedUrl).toBe('https://storage.invalid/signed');
    expect(result.expiresIn).toBe(300);
    expect(createSignedUrl).toHaveBeenCalledWith(IMPORT.storagePath, 300);
  });

  it('refuses an import that does not exist', async () => {
    const { service } = makeService({ row: null });

    await expect(service.getFileUrl('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  /* Narrow window by design: the file is readable only while being worked. */
  it('refuses an import that is not being processed', async () => {
    const { service } = makeService({
      row: { ...IMPORT, status: 'CONFIRMED' },
    });

    await expect(service.getFileUrl('import-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('what storage actually turned out to hold', () => {
  /*
   * The case that happens in practice: the user created an import and
   * never finished uploading. Before this check the worker was handed a
   * signed URL to an object that was not there.
   */
  it('fails an import whose file was never uploaded', async () => {
    const { service, updates, createSignedUrl } = makeService({
      info: { data: null, error: { message: 'Object not found' } },
    });

    await expect(service.getFileUrl('import-1')).rejects.toThrow(
      'could not be found',
    );

    expect(updates[0]?.data).toMatchObject({ status: 'FAILED' });
    /* And no link was minted for a file that is not there. */
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it('fails an empty object, which is a failed upload not a resume', async () => {
    const { service, updates } = makeService({
      info: { data: { size: 0, contentType: 'application/pdf' }, error: null },
    });

    await expect(service.getFileUrl('import-1')).rejects.toThrow('empty');
    expect(updates[0]?.data).toMatchObject({ status: 'FAILED' });
  });

  /*
   * The size limit the API could not enforce at upload time, enforced
   * where the truth is available. A client can claim any size it likes;
   * this is storage reporting what landed.
   */
  it('fails a file larger than the ceiling', async () => {
    const { service, updates } = makeService({
      info: {
        data: { size: MAX_FILE_BYTES + 1, contentType: 'application/pdf' },
        error: null,
      },
    });

    await expect(service.getFileUrl('import-1')).rejects.toThrow('10 MB');
    expect(updates[0]?.data).toMatchObject({ status: 'FAILED' });
  });

  /*
   * The client-side `.pdf` check is a courtesy. A caller with a bearer
   * token can name a file `resume.pdf` and upload a PNG; this is where
   * that is caught.
   */
  it('fails a file whose real content type is not a PDF', async () => {
    const { service, updates } = makeService({
      info: { data: { size: 5_000, contentType: 'image/png' }, error: null },
    });

    await expect(service.getFileUrl('import-1')).rejects.toThrow(
      'Only PDF resumes are supported',
    );
    expect(updates[0]?.data).toMatchObject({ status: 'FAILED' });
  });

  /*
   * Compare-and-swap, matching every other transition in this service: a
   * concurrent complete() or fail() must not be overwritten by a late
   * verification.
   */
  it('only fails an import that is still PROCESSING', async () => {
    const { service, updates } = makeService({
      info: { data: null, error: { message: 'gone' } },
    });

    await service.getFileUrl('import-1').catch(() => undefined);

    expect(updates[0]?.where).toMatchObject({
      id: 'import-1',
      status: 'PROCESSING',
    });
  });
});

describe('when the storage provider itself fails', () => {
  /*
   * The console.error that used to sit on this path logged the storage
   * path - which embeds the userId and the user's original filename, very
   * often their real name - along with the raw provider error. It copied
   * personal data out of the database into whatever collects stdout, for a
   * failure the caller was already being told about.
   */
  it('writes no personal data to the console', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { service } = makeService({
      signedUrl: { data: null, error: { message: 'tenant abc-123 quota' } },
    });

    await service.getFileUrl('import-1').catch(() => undefined);

    expect(spy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();

    spy.mockRestore();
    logSpy.mockRestore();
  });

  it('returns a stable sentence rather than the provider text', async () => {
    const { service } = makeService({
      signedUrl: { data: null, error: { message: 'tenant abc-123 quota' } },
    });

    const error = await service
      .getFileUrl('import-1')
      .catch((caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).not.toContain('abc-123');
    expect(error.message).not.toContain(IMPORT.storagePath);
    expect(error.message).toBe(
      'Unable to create the resume download link. Please try again.',
    );
  });
});
