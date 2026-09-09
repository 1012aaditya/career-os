import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import { SupabaseClientService } from '../auth/supabase.client.js';
import {
  checkStoredFile,
  storedRejectionMessage,
} from '../resume-import/upload-policy.js';
@Injectable()
export class ResumeProcessingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseClientService,
  ) {}

  async claimNext() {
    const pending = await this.prisma.resumeImport.findFirst({
      where: {
        status: 'PENDING',
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    if (!pending) {
      return null;
    }

    const claimed = await this.prisma.resumeImport.updateMany({
      where: {
        id: pending.id,
        status: 'PENDING',
      },
      data: {
        status: 'PROCESSING',
        errorMessage: null,
      },
    });

    if (claimed.count !== 1) {
      throw new ConflictException(
        'Resume import was claimed by another worker',
      );
    }

    return this.prisma.resumeImport.findUnique({
      where: {
        id: pending.id,
      },
    });
  }

  async complete(
    id: string,
    extractionResult?: Prisma.InputJsonValue,
  ) {
    const resumeImport = await this.prisma.resumeImport.findUnique({
      where: { id },
    });

    if (!resumeImport) {
      throw new NotFoundException('Resume import not found');
    }

    if (resumeImport.status !== 'PROCESSING') {
      throw new ConflictException(
        `Resume import is not PROCESSING: ${resumeImport.status}`,
      );
    }

    /*
     * rawExtractionResult is written here and nowhere else. The user's
     * review overwrites extractionResult in place, so without a pristine
     * copy taken at delivery there is no way to answer what the AI
     * originally produced. It is never updated on a later call.
     *
     * Compare-and-swap on the status so a concurrent fail() or a second
     * completion cannot overwrite a row that has already moved on.
     */
    const completed =
      await this.prisma.resumeImport.updateMany({
        where: { id, status: 'PROCESSING' },
        data: {
          status: 'NEEDS_REVIEW',
          extractionResult: extractionResult ?? {},
          /*
           * Left NULL when the worker sent nothing: absent provenance is
           * unknown, and unknown must not be recorded as an empty result.
           */
          rawExtractionResult: extractionResult,
          errorMessage: null,
        },
      });

    if (completed.count !== 1) {
      throw new ConflictException(
        'Resume import is no longer being processed',
      );
    }

    /*
     * OrThrow: the compare-and-swap above already proved the row exists,
     * so a null here would mean it vanished mid-request. Returning null to
     * the worker would look like success.
     */
    return this.prisma.resumeImport.findUniqueOrThrow(
      {
        where: { id },
      },
    );
  }

  async fail(id: string, errorMessage: string) {
    const resumeImport = await this.prisma.resumeImport.findUnique({
      where: { id },
    });

    if (!resumeImport) {
      throw new NotFoundException('Resume import not found');
    }

    /*
     * Only a row that is still being processed may be failed. Without this
     * guard a worker holding the shared secret could move an already
     * CONFIRMED import to FAILED, leaving an import marked failed whose
     * records are live in the user's career graph and which no endpoint
     * can move back.
     */
    const failed =
      await this.prisma.resumeImport.updateMany({
        where: { id, status: 'PROCESSING' },
        data: {
          status: 'FAILED',
          errorMessage,
        },
      });

    if (failed.count !== 1) {
      throw new ConflictException(
        'Resume import is no longer being processed',
      );
    }

    /*
     * OrThrow: the compare-and-swap above already proved the row exists,
     * so a null here would mean it vanished mid-request. Returning null to
     * the worker would look like success.
     */
    return this.prisma.resumeImport.findUniqueOrThrow(
      {
        where: { id },
      },
    );
  }
  /**
   * The worker's gate to the bytes, and the one place the real file is
   * judged.
   *
   * Everything the API knew at upload time was a filename the client chose.
   * This runs after the bytes have landed, so it can ask STORAGE what was
   * actually stored - a size and a content type that no client supplied -
   * and refuse before a worker is handed a link to something oversized,
   * empty, or not a resume at all.
   *
   * A refusal FAILS the import rather than merely erroring. A file that is
   * not going to parse is not going to parse on the next attempt either,
   * and leaving the row in PROCESSING would let it be claimed again
   * forever. The user gets a stable reason on their import instead.
   */
  async getFileUrl(id: string) {
    const resumeImport = await this.prisma.resumeImport.findUnique({
      where: { id },
    });

    if (!resumeImport) {
      throw new NotFoundException('Resume import not found');
    }

    if (resumeImport.status !== 'PROCESSING') {
      throw new ConflictException(
        `Resume import is not PROCESSING: ${resumeImport.status}`,
      );
    }

    const stored = await this.describeStoredFile(resumeImport.storagePath);
    const storedRejection = checkStoredFile(stored);

    if (storedRejection !== null) {
      const message = storedRejectionMessage(storedRejection);

      /*
       * Compare-and-swap on the status, matching every other transition in
       * this file: a concurrent complete() or fail() must not be
       * overwritten by a late verification.
       */
      await this.prisma.resumeImport.updateMany({
        where: { id, status: 'PROCESSING' },
        data: { status: 'FAILED', errorMessage: message },
      });

      throw new ConflictException(message);
    }

    const { data, error } = await this.supabase.client.storage
      .from('resumes')
      .createSignedUrl(resumeImport.storagePath, 300);

    if (error || !data?.signedUrl) {
      /*
       * The console.error that used to sit here logged the storage path -
       * which embeds the userId and the user's original filename, very
       * often their real name - together with the raw provider error. That
       * copied personal data out of the database and into whatever
       * collects stdout, for a failure the caller was already being told
       * about. Structured logging with a redaction allowlist is PR-5's
       * job; until it exists, the honest amount of logging here is none.
       */
      throw new ConflictException(
        'Unable to create the resume download link. Please try again.',
      );
    }

    return {
      id: resumeImport.id,
      fileName: resumeImport.fileName,
      signedUrl: data.signedUrl,
      expiresIn: 300,
    };
  }

  /**
   * What storage says it is holding at a path.
   *
   * A failure to read metadata is reported as `exists: false` rather than
   * thrown, so the policy above makes the decision in one place. That is
   * the fail-closed direction: an object we cannot describe is one we do
   * not hand to a worker.
   */
  private async describeStoredFile(storagePath: string): Promise<{
    exists: boolean;
    size?: number | null;
    contentType?: string | null;
  }> {
    const { data, error } = await this.supabase.client.storage
      .from('resumes')
      .info(storagePath);

    if (error || !data) {
      return { exists: false };
    }

    return {
      exists: true,
      size: data.size,
      contentType: data.contentType,
    };
  }
}
