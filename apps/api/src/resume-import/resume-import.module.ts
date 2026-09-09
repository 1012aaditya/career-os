import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { CareerGraphModule } from '../career-graph/career-graph.module.js';
import { AccountModule } from '../account/account.module.js';
import { ResumeImportController } from './resume-import.controller.js';
import { ResumeImportService } from './resume-import.service.js';

@Module({
  imports: [
    AuthModule,
    PrismaModule,
    CareerGraphModule,
    /* For UserStorageService: one implementation of "delete this user's
     * object, and refuse anything outside their prefix", shared with
     * account deletion rather than written twice. */
    AccountModule,
  ],
  controllers: [ResumeImportController],
  providers: [ResumeImportService],
})
export class ResumeImportModule {}
