import {
  BadRequestException,
  Controller,
  Get,
  HttpStatus,
  INestApplication,
  MiddlewareConsumer,
  Module,
  NestModule,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AllExceptionsFilter } from './all-exceptions.filter.js';
import { HttpLoggingInterceptor } from './http-logging.interceptor.js';
import {
  REQUEST_ID_HEADER,
  RequestIdMiddleware,
} from './request-id.middleware.js';
import { StructuredLogger } from './structured-logger.js';
import { HealthController } from '../health/health.controller.js';
import { HealthService } from '../health/health.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/*
 * The request pipeline, over real HTTP.
 *
 * These go through supertest against a real Nest application rather than
 * calling the filter's method directly, because what is under test is the
 * INTERACTION: middleware sets an id, an interceptor logs, a filter
 * rewrites a response, and the question is what a client actually receives
 * and what a log actually contains. A unit test of the filter would assert
 * the filter, and miss that the id never reached it.
 *
 * The logger is spied on rather than mocked out, so the assertions about
 * what is NOT logged are made against the real allowlist.
 */

/** Stands in for Prisma's error class, which we do not want to import. */
class PrismaClientKnownRequestError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'PrismaClientKnownRequestError';
    this.code = code;
  }
}

/** Throws the kinds of failure the API really produces. */
@Controller('probe')
class ProbeController {
  @Get('ok')
  ok() {
    return { ok: true };
  }

  /* A deliberate refusal, as PR-2 and PR-3 throw them. */
  @Get('client-error')
  clientError() {
    throw new BadRequestException('Only PDF resumes are supported');
  }

  /*
   * The shape of the failure PR-4 found against the Sydney pooler: a
   * Prisma known-request error carrying P2028 and a message that, in the
   * real thing, contains the connection string.
   *
   * A real subclass rather than a renamed Error. An earlier version of
   * this fixture reassigned `error.constructor.name` - which is the GLOBAL
   * Error constructor - and so renamed Error itself for the rest of the
   * process, making every later error in the file categorise as a database
   * failure. A test that quietly changes a global is worse than no test.
   */
  @Get('database-error')
  databaseError(): never {
    throw new PrismaClientKnownRequestError(
      'Transaction API error: Unable to start a transaction in the given time. postgresql://postgres:hunter2@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres',
      'P2028',
    );
  }

  @Get('crash')
  crash(): never {
    throw new TypeError(
      "Cannot read properties of undefined (reading 'accessToken')",
    );
  }
}

let app: INestApplication;
let logger: StructuredLogger;
let emitted: { level: string; event: string; fields: Record<string, unknown> }[];
let databaseUp = true;

@Module({
  controllers: [ProbeController, HealthController],
  providers: [
    StructuredLogger,
    HealthService,
    {
      provide: PrismaService,
      useValue: {
        $queryRaw: async () => {
          if (!databaseUp) {
            const error = Object.assign(new Error('connect ECONNREFUSED'), {
              code: 'ECONNREFUSED',
            });
            throw error;
          }
          return [{ '?column?': 1 }];
        },
      },
    },
    { provide: APP_INTERCEPTOR, useClass: HttpLoggingInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
class ProbeModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}

beforeEach(async () => {
  databaseUp = true;
  emitted = [];

  const moduleRef = await Test.createTestingModule({
    imports: [ProbeModule],
  }).compile();

  app = moduleRef.createNestApplication();
  logger = app.get(StructuredLogger);

  vi.spyOn(logger, 'event').mockImplementation(
    (level, event, fields = {}) => {
      emitted.push({ level, event, fields });
    },
  );

  await app.init();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
});

/** Everything the logger was asked to write, as one string. */
function loggedText(): string {
  return JSON.stringify(emitted);
}

describe('request ids', () => {
  it('gives every request one, and echoes it', async () => {
    const response = await request(app.getHttpServer()).get('/probe/ok');

    const id = response.headers[REQUEST_ID_HEADER];

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('gives two requests different ids', async () => {
    const a = await request(app.getHttpServer()).get('/probe/ok');
    const b = await request(app.getHttpServer()).get('/probe/ok');

    expect(a.headers[REQUEST_ID_HEADER]).not.toBe(b.headers[REQUEST_ID_HEADER]);
  });

  /* So a trace that started at a proxy or a client is not broken here. */
  it('honours a well-formed incoming id', async () => {
    const response = await request(app.getHttpServer())
      .get('/probe/ok')
      .set(REQUEST_ID_HEADER, 'client-trace-0001');

    expect(response.headers[REQUEST_ID_HEADER]).toBe('client-trace-0001');
  });

  /*
   * The id is written into every log line this request produces, so a
   * hostile one is a log-forging and log-flooding vector.
   *
   * A literal newline is not tested here and that is deliberate: Node's
   * HTTP client refuses to transmit a header containing one, so the
   * injection case cannot be exercised over real HTTP. It is covered
   * directly against `safeRequestId` in log-fields.spec.ts instead - which
   * is the honest place for it, since that is the layer that would face a
   * client not built on Node.
   */
  it.each([
    ['padding, to bloat every log line', 'x'.repeat(400)],
    ['spaces and punctuation', 'not a valid id; drop table'],
    ['something far too short to be a trace', 'ab'],
  ])('replaces a hostile incoming id: %s', async (_label, hostile) => {
    const response = await request(app.getHttpServer())
      .get('/probe/ok')
      .set(REQUEST_ID_HEADER, hostile);

    expect(response.headers[REQUEST_ID_HEADER]).not.toBe(hostile);
    expect(response.headers[REQUEST_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('correlates the response header with the log line', async () => {
    const response = await request(app.getHttpServer()).get('/probe/ok');

    const access = emitted.find((entry) => entry.event === 'http.request');

    expect(access?.fields.requestId).toBe(response.headers[REQUEST_ID_HEADER]);
  });
});

describe('what a client is told when something fails', () => {
  /*
   * A deliberate 4xx is a decision somebody made and PR-2/PR-3 already
   * made the message safe. Turning it into a 500 would destroy real
   * information the user needs.
   */
  it('preserves a deliberate 4xx and its message', async () => {
    const response = await request(app.getHttpServer()).get(
      '/probe/client-error',
    );

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    expect(response.body.message).toBe('Only PDF resumes are supported');
    expect(response.body.requestId).toBe(response.headers[REQUEST_ID_HEADER]);
  });

  /*
   * THE test. The real P2028 message contains the connection string,
   * including the password. None of it may reach the client.
   */
  it('never returns a database error message', async () => {
    const response = await request(app.getHttpServer()).get(
      '/probe/database-error',
    );

    expect(response.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(response.body).toEqual({
      statusCode: 500,
      message: 'Something went wrong.',
      requestId: response.headers[REQUEST_ID_HEADER],
    });

    const body = JSON.stringify(response.body);

    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('supabase.com');
    expect(body).not.toContain('P2028');
    expect(body).not.toContain('Prisma');
  });

  it('returns no stack trace and no error class', async () => {
    const response = await request(app.getHttpServer()).get('/probe/crash');

    const body = JSON.stringify(response.body);

    expect(body).not.toContain('TypeError');
    expect(body).not.toContain('accessToken');
    expect(body).not.toMatch(/\bat \w+/);
    expect(Object.keys(response.body).sort()).toEqual([
      'message',
      'requestId',
      'statusCode',
    ]);
  });
});

describe('what the server records instead', () => {
  /*
   * The other half: the client learns nothing, so the operator must learn
   * enough. Class, code and category - never the message.
   */
  it('records the class, code and category of a database failure', async () => {
    await request(app.getHttpServer()).get('/probe/database-error');

    const failure = emitted.find((entry) => entry.event === 'http.unhandled');

    expect(failure?.fields).toMatchObject({
      errorCode: 'P2028',
      errorCategory: 'database',
      statusCode: 500,
    });
  });

  it('records no message, connection string or credential', async () => {
    await request(app.getHttpServer()).get('/probe/database-error');

    expect(loggedText()).not.toContain('hunter2');
    expect(loggedText()).not.toContain('supabase.com');
    expect(loggedText()).not.toContain('Unable to start a transaction');
  });

  it('records the request, its status and how long it took', async () => {
    await request(app.getHttpServer()).get('/probe/ok');

    const access = emitted.find((entry) => entry.event === 'http.request');

    expect(access?.fields).toMatchObject({
      method: 'GET',
      route: '/probe/ok',
      statusCode: 200,
      outcome: 'ok',
    });
    expect(typeof access?.fields.durationMs).toBe('number');
  });

  /* A 4xx is the system working. Logging it at error level buries the rest. */
  it('does not record a client error as a server failure', async () => {
    await request(app.getHttpServer()).get('/probe/client-error');

    expect(emitted.some((entry) => entry.level === 'error')).toBe(false);
    expect(
      emitted.some((entry) => entry.event === 'http.client_error'),
    ).toBe(true);
  });
});

describe('liveness and readiness', () => {
  it('liveness is 200 when the process is answering', async () => {
    const response = await request(app.getHttpServer()).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('readiness is 200 when the database answers', async () => {
    const response = await request(app.getHttpServer()).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      checks: { database: 'ok' },
    });
  });

  /*
   * THE bug PR-1 found. It answered 200 with a body saying the database
   * was unreachable - and every load balancer reads the status code, so
   * the one endpoint meant to notice a dead database guaranteed traffic
   * kept arriving at it.
   */
  it('readiness is 503 when the database does not', async () => {
    databaseUp = false;

    const response = await request(app.getHttpServer()).get('/health/ready');

    expect(response.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(response.body).toMatchObject({
      status: 'not_ready',
      checks: { database: 'unavailable' },
    });
    expect(response.body.requestId).toBe(response.headers[REQUEST_ID_HEADER]);
  });

  /*
   * And liveness must NOT follow it down. A liveness probe that consults
   * the database restarts every healthy process during a database
   * incident, turning a degradation into an outage.
   */
  it('liveness stays 200 while the database is down', async () => {
    databaseUp = false;

    const response = await request(app.getHttpServer()).get('/health/live');

    expect(response.status).toBe(200);
  });

  it('the legacy /health/db route is honest too', async () => {
    databaseUp = false;

    const response = await request(app.getHttpServer()).get('/health/db');

    expect(response.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(response.body.database).toBe('unreachable');
  });

  it('records a diagnostic when readiness fails, without the message', async () => {
    databaseUp = false;

    await request(app.getHttpServer()).get('/health/ready');

    const failure = emitted.find(
      (entry) => entry.event === 'db.readiness.failed',
    );

    expect(failure?.fields).toMatchObject({
      dependency: 'database',
      dependencyStatus: 'unavailable',
      errorCode: 'ECONNREFUSED',
      errorCategory: 'dependency',
    });
    expect(loggedText()).not.toContain('ECONNREFUSED postgres');
  });

  it('exposes no connection detail in a readiness response', async () => {
    databaseUp = false;

    const response = await request(app.getHttpServer()).get('/health/ready');

    const body = JSON.stringify(response.body);

    expect(body).not.toContain('ECONNREFUSED');
    expect(body).not.toContain('postgres');
    expect(body).not.toContain('SELECT');
  });
});
