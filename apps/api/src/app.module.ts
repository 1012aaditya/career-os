import { Module } from '@nestjs/common';
import { CareerGraphModule } from './career-graph/career-graph.module.js';
import { ConfigModule } from '@nestjs/config';
import { ResumeProcessingModule } from './resume-processing/resume-processing.module.js';
import { AuthModule } from './auth/auth.module.js';
import { HealthController } from './health.controller.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ResumeImportModule } from './resume-import/resume-import.module.js';
import { IntegrationsModule } from './integrations/integrations.module.js';
import { MarketGraphModule } from './market-graph/market-graph.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    AuthModule,
    PrismaModule,
    ResumeImportModule,
    ResumeProcessingModule,
    CareerGraphModule,
    IntegrationsModule,
    MarketGraphModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
