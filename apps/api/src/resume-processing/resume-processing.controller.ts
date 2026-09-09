import {
  BadRequestException,
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
import { timingSafeEqual } from 'node:crypto';

import { Throttle } from '@nestjs/throttler';

import { ResumeProcessingService } from './resume-processing.service.js';
import { WORKER_THROTTLE } from '../throttling.js';

/*
 * Throttled at the controller, so every worker route is covered including
 * any added later. These endpoints are guarded by a single shared secret
 * and nothing bounded how many guesses a caller could make; the tier is
 * sized from real worker polling behaviour, not from a feeling.
 */
@Controller('resume-processing')
@Throttle(WORKER_THROTTLE)
export class ResumeProcessingController {
  constructor(
    private readonly processingService: ResumeProcessingService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The worker's shared secret, compared in constant time.
   *
   * `!==` leaks the length of the matching prefix through timing. Over the
   * public internet that channel is noisy - but this is a single
   * long-lived credential that grants access to every resume in the
   * system, nothing rate-limits the endpoint yet, and the fix costs one
   * function call. The only argument for leaving it was that exploiting it
   * would be inconvenient.
   *
   * timingSafeEqual throws on unequal lengths, so lengths are compared
   * first. That comparison does reveal whether the lengths match, and that
   * is not worth defending: the length of a configured secret is not the
   * secret, and hashing both sides to a fixed width buys nothing real.
   *
   * Still fails closed when RESUME_WORKER_SECRET is unset - always the
   * behaviour, and the right one. A worker endpoint with no configured
   * credential must reject everything rather than accept anything.
   */
  private verifyWorkerSecret(secret: string | undefined) {
    const expected = this.config.get<string>('RESUME_WORKER_SECRET');

    if (!expected || !secret) {
      throw new UnauthorizedException('Invalid worker credentials');
    }

    const provided = Buffer.from(secret);
    const configured = Buffer.from(expected);

    if (
      provided.length !== configured.length ||
      !timingSafeEqual(provided, configured)
    ) {
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
      /*
       * 400, not 401. This is a malformed request from a caller that has
       * already authenticated - reporting it as an auth failure would send
       * an operator to check the worker's credentials over a missing field.
       */
      throw new BadRequestException('id is required');
    }

    /*
     * Passed through as-is, including undefined. The service still defaults
     * the reviewable column to {}, but must not record "the AI extracted an
     * empty object" as provenance when the worker in fact sent nothing.
     */
    return this.processingService.complete(
      body.id,
      body.extractionResult,
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
      /*
       * 400, not 401. This is a malformed request from a caller that has
       * already authenticated - reporting it as an auth failure would send
       * an operator to check the worker's credentials over a missing field.
       */
      throw new BadRequestException('id is required');
    }

    return this.processingService.fail(
      body.id,
      body.errorMessage ?? 'Resume processing failed',
    );
  }
}