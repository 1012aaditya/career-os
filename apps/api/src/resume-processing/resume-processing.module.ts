import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ResumeProcessingController } from './resume-processing.controller.js';
import { ResumeProcessingService } from './resume-processing.service.js';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ResumeProcessingController],
  providers: [ResumeProcessingService],
})
export class ResumeProcessingModule {}