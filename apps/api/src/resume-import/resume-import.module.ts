import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { CareerGraphModule } from '../career-graph/career-graph.module.js';
import { ResumeImportController } from './resume-import.controller.js';
import { ResumeImportService } from './resume-import.service.js';

@Module({
  imports: [
    AuthModule,
    PrismaModule,
    CareerGraphModule,
  ],
  controllers: [ResumeImportController],
  providers: [ResumeImportService],
})
export class ResumeImportModule {}
