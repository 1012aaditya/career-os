import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CareerGraphModule } from './career-graph/career-graph.module.js';
import { ConfigModule } from '@nestjs/config';
import { ResumeProcessingModule } from './resume-processing/resume-processing.module.js';
import { AccountModule } from './account/account.module.js';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { AllExceptionsFilter } from './observability/all-exceptions.filter.js';
import { HttpLoggingInterceptor } from './observability/http-logging.interceptor.js';
import { RequestIdMiddleware } from './observability/request-id.middleware.js';
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
    /*
     * First, and global, so every module below can log without declaring
     * a dependency on diagnostics.
     */
    ObservabilityModule,
    HealthModule,
    AuthModule,
    AccountModule,
    PrismaModule,
    ResumeImportModule,
    ResumeProcessingModule,
    CareerGraphModule,
    IntegrationsModule,
    MarketGraphModule,
  ],
  providers: [
    /*
     * Global, so a route added later is protected by default rather than
     * by whoever remembers to decorate it. Routes that need a tighter
     * limit opt in with @Throttle; nothing opts out.
     */
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    /*
     * One access line per request, and one diagnostic line per failure.
     * Registered globally rather than per-controller so a route added
     * later is observable by default rather than by somebody remembering.
     */
    { provide: APP_INTERCEPTOR, useClass: HttpLoggingInterceptor },
    /*
     * The last thing between an exception and a client. It preserves
     * deliberate 4xx responses untouched and replaces everything else
     * with a fixed sentence plus a request id - so a Prisma message,
     * which carries a connection string, can never be the body of a 500.
     */
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  /*
   * Middleware rather than an interceptor, because the request id has to
   * exist before anything else runs - including the throttler guard, whose
   * 429 should be correlated like any other response.
   */
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
