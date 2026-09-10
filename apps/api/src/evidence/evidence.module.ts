import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';

import { EvidenceController } from './evidence.controller.js';
import { EvidenceService } from './evidence.service.js';

/*
 * The Evidence read path.
 *
 * Deliberately has no producer in it. Writing evidence belongs to the
 * source adapters - the GitHub integration and the resume ingestion - and
 * keeping this module read-only means a route added here cannot start
 * writing career history.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [EvidenceController],
  providers: [EvidenceService],
  exports: [EvidenceService],
})
export class EvidenceModule {}
