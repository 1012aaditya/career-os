import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ResumeProcessingModule } from './resume-processing/resume-processing.module.js';
import { AuthModule } from './auth/auth.module.js';
import { HealthController } from './health.controller.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ResumeImportModule } from './resume-import/resume-import.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    AuthModule,
    PrismaModule,
    ResumeImportModule,
    ResumeProcessingModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
