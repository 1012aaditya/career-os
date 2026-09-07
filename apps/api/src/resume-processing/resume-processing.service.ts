import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import { SupabaseClientService } from '../auth/supabase.client.js';
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
  
    const { data, error } = await this.supabase.client.storage
      .from('resumes')
      .createSignedUrl(resumeImport.storagePath, 300);
  
    if (error || !data?.signedUrl) {
  console.error('Resume storage signed URL error:', {
    resumeId: resumeImport.id,
    storagePath: resumeImport.storagePath,
    error,
  });

  throw new ConflictException(
    `Unable to create resume download URL: ${
      error?.message ?? 'Unknown storage error'
    }`,
  );
}
  
    return {
      id: resumeImport.id,
      fileName: resumeImport.fileName,
      signedUrl: data.signedUrl,
      expiresIn: 300,
    };
  }
}
