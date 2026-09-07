import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { AuthGuard } from '../auth/auth.guard.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';

import { ResumeImportService } from './resume-import.service.js';


@Controller('resume-imports')
@UseGuards(AuthGuard)
export class ResumeImportController {
  constructor(
    private readonly resumeImportService: ResumeImportService,
  ) {}

  @Post()
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() body: { fileName?: string },
  ) {
    if (!body.fileName) {
      throw new BadRequestException(
        'fileName is required',
      );
    }

    return this.resumeImportService.create(
      req.user.id,
      body.fileName,
    );
  }

  @Get()
  async findAll(
    @Req() req: AuthenticatedRequest,
  ) {
    return this.resumeImportService.findAll(
      req.user.id,
    );
  }

  @Get(':id')
  async findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.resumeImportService.findOne(
      req.user.id,
      id,
    );
  }

  @Patch(':id')
  async updateExtraction(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: {
      extractionResult?: unknown;
    },
  ) {
    if (
      body.extractionResult === undefined ||
      body.extractionResult === null
    ) {
      throw new BadRequestException(
        'extractionResult is required',
      );
    }

    return this.resumeImportService.updateExtraction(
      req.user.id,
      id,
      body.extractionResult,
    );
  }

  @Post(':id/confirm')
  async confirm(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.resumeImportService.confirm(
      req.user.id,
      id,
    );
  }

  /*
   * Recovery path for an import that is CONFIRMED but never reached the
   * graph — an ingestion that failed, or a process that died between the
   * confirmation and the ingestion. Idempotent, so calling it on an import
   * that is already ingested is a no-op that reports as much.
   *
   * confirm() ends in the same operation, so a user retrying from the
   * review screen recovers too; this exists because a crash can strand an
   * import without the user ever seeing an error to retry.
   */
  @Post(':id/ingest')
  async ingest(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.resumeImportService.ingest(
      req.user.id,
      id,
    );
  }
}
