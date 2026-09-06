import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';

import { ResumeProcessingService } from './resume-processing.service.js';

@Controller('resume-processing')
export class ResumeProcessingController {
  constructor(
    private readonly processingService: ResumeProcessingService,
    private readonly config: ConfigService,
  ) {}

  private verifyWorkerSecret(secret: string | undefined) {
    const expected = this.config.get<string>('RESUME_WORKER_SECRET');

    if (!expected || !secret || secret !== expected) {
      throw new UnauthorizedException('Invalid worker credentials');
    }
  }

  @Post('claim')
  async claim(
    @Headers('x-worker-secret') secret: string | undefined,
  ) {
    this.verifyWorkerSecret(secret);

    return this.processingService.claimNext();
  }

  @Get(':id/file')
  async getFile(
    @Headers('x-worker-secret') secret: string | undefined,
    @Param('id') id: string,
  ) {
    this.verifyWorkerSecret(secret);

    return this.processingService.getFileUrl(id);
  }

  @Post('complete')
  async complete(
    @Headers('x-worker-secret') secret: string | undefined,
    @Body()
    body: {
      id?: string;
      extractionResult?: Prisma.InputJsonValue;
    },
  ) {
    this.verifyWorkerSecret(secret);

    if (!body.id) {
      throw new UnauthorizedException('id is required');
    }

    return this.processingService.complete(
      body.id,
      body.extractionResult ?? {},
    );
  }

  @Post('fail')
  async fail(
    @Headers('x-worker-secret') secret: string | undefined,
    @Body()
    body: {
      id?: string;
      errorMessage?: string;
    },
  ) {
    this.verifyWorkerSecret(secret);

    if (!body.id) {
      throw new UnauthorizedException('id is required');
    }

    return this.processingService.fail(
      body.id,
      body.errorMessage ?? 'Resume processing failed',
    );
  }
}