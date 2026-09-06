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
}
