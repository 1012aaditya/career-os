import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import {
  ThrottlerGuard,
  ThrottlerModule,
  ThrottlerStorage,
  ThrottlerStorageService,
} from '@nestjs/throttler';
import { Redis } from 'ioredis';
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
import { RedisThrottlerStorage } from './throttling/redis-throttler.storage.js';
import { redisUrl } from './environment.js';
import { StructuredLogger } from './observability/structured-logger.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    /*
     * Request throttling. See throttling.ts for what each tier protects
     * and why the numbers are what they are.
     *
     * The COUNTER now lives in Redis when REDIS_URL is set, so the limit
     * holds across instances instead of being multiplied by the instance
     * count. See throttling/redis-throttler.storage.ts, including what
     * happens when Redis is unreachable - which is to fall back to the
     * per-process counter rather than to no limit at all.
     *
     * With REDIS_URL unset the behaviour is exactly PR-2's, which is
     * correct for one process: local development and the test tier.
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
     * The shared counter, substituted for the module's in-memory default.
     *
     * Built by a factory rather than declared as a class, because whether
     * there IS a shared store is a deployment fact read at startup. The
     * in-memory service is constructed either way and handed to the Redis
     * store as its fallback, so the degraded path is the same object the
     * healthy path would have used.
     *
     * lazyConnect keeps a missing Redis from failing the boot: the first
     * increment connects, and if it cannot, the fallback answers and the
     * failure is logged once per degraded window rather than per request.
     */
    {
      provide: ThrottlerStorage,
      useFactory: (logger: StructuredLogger) => {
        const url = redisUrl();
        const memory = new ThrottlerStorageService();

        if (url === null) {
          return memory;
        }

        return new RedisThrottlerStorage(
          new Redis(url, {
            /*
             * Connect on first use, so a Redis that is down at boot does
             * not stop the API starting. Rate limiting is not worth
             * refusing to serve over.
             */
            lazyConnect: true,
            /*
             * enableOfflineQueue TRUE, and this was found by measurement
             * rather than by reasoning.
             *
             * With it false, the very first increment after boot is issued
             * before the connection is up and fails immediately - which
             * dropped the instance into its degraded window and left the
             * first seconds of every instance's life counting per-process,
             * with nothing in Redis and no sign of it but one log line.
             * Verified against a live Redis: three requests after boot
             * created zero keys.
             *
             * True lets that first command wait for the connection instead
             * of failing. It does not reintroduce unbounded queueing: a
             * genuinely unreachable Redis exhausts maxRetriesPerRequest
             * and rejects, which is the path the degraded fallback exists
             * for and which a test against a dead port covers.
             */
            enableOfflineQueue: true,
            maxRetriesPerRequest: 1,
            connectTimeout: 2_000,
          }),
          memory,
          logger,
        );
      },
      inject: [StructuredLogger],
    },
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
