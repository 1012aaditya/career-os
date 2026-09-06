import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { Prisma } from '@prisma/client';

import { randomUUID } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service.js';
import { SupabaseClientService } from '../auth/supabase.client.js';


@Injectable()
export class ResumeImportService {
  private readonly bucket = 'resumes';

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseClientService,
  ) {}

  async create(
    userId: string,
    fileName: string,
  ) {
    const normalizedFileName =
      fileName.trim();

    if (!normalizedFileName) {
      throw new BadRequestException(
        'fileName is required',
      );
    }

    const safeFileName =
      normalizedFileName
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .slice(0, 200);

    const id = randomUUID();

    const storagePath =
      `${userId}/${id}/${safeFileName}`;

    const resumeImport =
      await this.prisma.resumeImport.create({
        data: {
          id,
          userId,
          fileName: normalizedFileName,
          storagePath,
        },
      });

    const {
      data,
      error,
    } =
      await this.supabase.client.storage
        .from(this.bucket)
        .createSignedUploadUrl(
          storagePath,
        );

    if (error) {
      await this.prisma.resumeImport.update({
        where: {
          id: resumeImport.id,
        },
        data: {
          status: 'FAILED',
          errorMessage: error.message,
        },
      });

      throw new BadRequestException(
        `Unable to create upload URL: ${error.message}`,
      );
    }

    return {
      id: resumeImport.id,
      fileName: resumeImport.fileName,
      storagePath: resumeImport.storagePath,
      status: resumeImport.status,
      uploadToken: data.token,
      uploadPath: data.path,
    };
  }

  async findAll(userId: string) {
    return this.prisma.resumeImport.findMany({
      where: {
        userId,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findOne(
    userId: string,
    id: string,
  ) {
    const resumeImport =
      await this.prisma.resumeImport.findFirst({
        where: {
          id,
          userId,
        },
      });

    if (!resumeImport) {
      throw new NotFoundException(
        'Resume import not found',
      );
    }

    return resumeImport;
  }

  async updateExtraction(
    userId: string,
    id: string,
    extractionResult: unknown,
  ) {
    const resumeImport =
      await this.prisma.resumeImport.findFirst({
        where: {
          id,
          userId,
        },
      });

    if (!resumeImport) {
      throw new NotFoundException(
        'Resume import not found',
      );
    }

    if (
      resumeImport.status !== 'NEEDS_REVIEW'
    ) {
      throw new ConflictException(
        `Resume import cannot be edited in status ${resumeImport.status}`,
      );
    }

    if (
      typeof extractionResult !== 'object' ||
      extractionResult === null ||
      Array.isArray(extractionResult)
    ) {
      throw new BadRequestException(
        'extractionResult must be a JSON object',
      );
    }

    return this.prisma.resumeImport.update({
      where: {
        id: resumeImport.id,
      },
      data: {
        extractionResult:
          extractionResult as Prisma.InputJsonValue,
      },
    });
  }

  async confirm(
    userId: string,
    id: string,
  ) {
    const resumeImport =
      await this.prisma.resumeImport.findFirst({
        where: {
          id,
          userId,
        },
      });

    if (!resumeImport) {
      throw new NotFoundException(
        'Resume import not found',
      );
    }

    if (
      resumeImport.status !== 'NEEDS_REVIEW'
    ) {
      throw new ConflictException(
        `Resume import cannot be confirmed in status ${resumeImport.status}`,
      );
    }

    if (!resumeImport.extractionResult) {
      throw new ConflictException(
        'Resume import has no extraction result',
      );
    }

    return this.prisma.resumeImport.update({
      where: {
        id: resumeImport.id,
      },
      data: {
        status: 'CONFIRMED',
        errorMessage: null,
      },
    });
  }
}
