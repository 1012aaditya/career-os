import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';

import { CareerGraphController } from './career-graph.controller.js';
import { CareerGraphIngestionService } from './career-graph-ingestion.service.js';
import { CareerGraphService } from './career-graph.service.js';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
  ],
  controllers: [
    CareerGraphController,
  ],
  providers: [
    CareerGraphService,
    CareerGraphIngestionService,
  ],
  exports: [
    CareerGraphService,
    CareerGraphIngestionService,
  ],
})
export class CareerGraphModule {}