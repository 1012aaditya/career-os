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
    extractionResult: Prisma.InputJsonValue,
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

    return this.prisma.resumeImport.update({
      where: { id },
      data: {
        status: 'NEEDS_REVIEW',
        extractionResult,
        errorMessage: null,
      },
    });
  }

  async fail(id: string, errorMessage: string) {
    const resumeImport = await this.prisma.resumeImport.findUnique({
      where: { id },
    });

    if (!resumeImport) {
      throw new NotFoundException('Resume import not found');
    }

    return this.prisma.resumeImport.update({
      where: { id },
      data: {
        status: 'FAILED',
        errorMessage,
      },
    });
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
