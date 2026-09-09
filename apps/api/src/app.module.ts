import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CareerGraphModule } from './career-graph/career-graph.module.js';
import { ConfigModule } from '@nestjs/config';
import { ResumeProcessingModule } from './resume-processing/resume-processing.module.js';
import { AuthModule } from './auth/auth.module.js';
import { HealthController } from './health.controller.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ResumeImportModule } from './resume-import/resume-import.module.js';
import { IntegrationsModule } from './integrations/integrations.module.js';
import { MarketGraphModule } from './market-graph/market-graph.module.js';
import { THROTTLE_TIERS } from './throttling.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    /*
     * Request throttling. See throttling.ts for what each tier protects
     * and why the numbers are what they are.
     *
     * The store is in-memory, which is a deliberate limitation rather than
     * an oversight: it counts per PROCESS, so with N instances the
     * effective ceiling is N times the configured limit. That is a real
     * weakening and it is still strictly better than the nothing that was
     * here before - it turns an unbounded credential-guessing loop into a
     * bounded one. A shared store needs infrastructure that does not exist
     * yet, so PR-6 owns replacing it once the instance count is a decision
     * somebody has made.
     */
    ThrottlerModule.forRoot(THROTTLE_TIERS),
    AuthModule,
    PrismaModule,
    ResumeImportModule,
    ResumeProcessingModule,
    CareerGraphModule,
    IntegrationsModule,
    MarketGraphModule,
  ],
  controllers: [HealthController],
  providers: [
    /*
     * Global, so a route added later is protected by default rather than
     * by whoever remembers to decorate it. Routes that need a tighter
     * limit opt in with @Throttle; nothing opts out.
     */
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
