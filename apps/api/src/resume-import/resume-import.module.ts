import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';

import { ResumeImportController } from './resume-import.controller.js';
import { ResumeImportService } from './resume-import.service.js';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [ResumeImportController],
  providers: [ResumeImportService],
})
export class ResumeImportModule {}
