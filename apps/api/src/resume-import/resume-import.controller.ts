import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { Throttle } from '@nestjs/throttler';

import { AuthGuard } from '../auth/auth.guard.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';

import { ResumeImportService } from './resume-import.service.js';
import { IMPORT_THROTTLE } from '../throttling.js';


@Controller('resume-imports')
@UseGuards(AuthGuard)
export class ResumeImportController {
  constructor(
    private readonly resumeImportService: ResumeImportService,
  ) {}

  /*
   * The tightest tier in the API. Every call mints a storage upload URL
   * and writes a row, so this is the one authenticated route where an
   * unbounded caller costs real money. See throttling.ts.
   */
  @Post()
  @Throttle(IMPORT_THROTTLE)
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
  /**
   * Deletes one import, its stored file, and the evidence derived from it.
   *
   * Scoped to the authenticated user by the service, which answers 404 for
   * an id belonging to somebody else - the same answer as for an id that
   * never existed, so the route cannot be used to discover which ids are
   * real.
   */
  @Delete(':id')
  async remove(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.resumeImportService.remove(
      req.user.id,
      id,
    );
  }

}
