import { randomBytes } from 'node:crypto';

import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { AuthGuard } from '../auth/auth.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { EncryptionService } from './crypto/encryption.service.js';
import { ExternalSyncRunService } from './github/external-sync-run.service.js';
import { GithubConnectionService } from './github/github-connection.service.js';
import { GithubIngestionService } from './github/github-ingestion.service.js';
import { GithubRestClient } from './github/github-rest.client.js';
import { GithubSyncService } from './github/github-sync.service.js';
import { GithubController } from './github/github.controller.js';
import { GithubEvidenceRepository } from './github/evidence/github-evidence.repository.js';
import { IntegrationsModule } from './integrations.module.js';
import { TEST_GITHUB_CONFIG } from './test-doubles.js';

/*
 * Does the application actually start?
 *
 * Every other spec in this module constructs its subject directly - `new
 * GithubIngestionService(...)` with hand-made doubles - which is the right
 * way to test behaviour but never once exercises Nest's injector. That
 * left an entire class of defect invisible: 410 passing tests while the
 * API could not boot at all.
 *
 * The specific failure this exists to catch: GithubRestClient takes a
 * `sleep: Sleep` parameter, and Sleep is a type alias for a function
 * rather than an injectable class. Nest reads the emitted paramtype,
 * sees `Function`, looks for a provider registered under that token,
 * finds none, and throws UnknownDependenciesException during bootstrap.
 * A default parameter value does not save it - Nest always attempts
 * injection and never falls through to the JS default.
 *
 * So this compiles the REAL module. Only the two edges that would reach
 * outside the process are replaced: PrismaService opens a database
 * connection in its constructor, and configuration is supplied in memory
 * rather than read from a developer's .env. Every provider under test is
 * the genuine one, wired by the genuine module definition.
 */

const testConfig = () => ({
  ...TEST_GITHUB_CONFIG,
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  TOKEN_ENCRYPTION_KEYS: JSON.stringify({
    '1': randomBytes(32).toString('base64'),
  }),
  TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION: '1',
});

const compileModule = () =>
  Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [testConfig],
      }),
      IntegrationsModule,
    ],
  })
    /*
     * The only override. PrismaService builds a pg adapter from
     * process.env.DATABASE_URL the moment it is constructed, so leaving it
     * real would make this test require a database to answer a question
     * that has nothing to do with one.
     */
    .overrideProvider(PrismaService)
    .useValue({})
    .compile();

describe('IntegrationsModule', () => {
  it('bootstraps', async () => {
    /*
     * The regression itself. Before @Optional was added to
     * GithubRestClient this rejected with UnknownDependenciesException,
     * and the API exited on startup.
     */
    await expect(compileModule()).resolves.toBeDefined();
  });

  it('resolves GithubRestClient with its real default sleep', async () => {
    const moduleRef = await compileModule();

    const client = moduleRef.get(GithubRestClient);

    expect(client).toBeInstanceOf(GithubRestClient);

    /*
     * @Optional makes Nest pass undefined rather than fail, which is
     * precisely what lets the declared default take effect. If a future
     * change swapped the default for an injected token, production would
     * lose its backoff and this would catch it.
     */
    expect(
      typeof (client as unknown as { sleep: unknown })
        .sleep,
    ).toBe('function');
  });

  /*
   * Broader than the one bug. Any provider the module declares must be
   * constructible, so a future parameter typed as an interface, a type
   * alias or a primitive fails here rather than at somebody's first
   * `pnpm start`.
   */
  it('resolves every provider it exports', async () => {
    const moduleRef = await compileModule();

    for (const token of [
      EncryptionService,
      GithubConnectionService,
      GithubIngestionService,
      ExternalSyncRunService,
      GithubEvidenceRepository,
      GithubSyncService,
    ]) {
      expect(moduleRef.get(token)).toBeInstanceOf(
        token,
      );
    }

    /*
     * The controller is the real entry point, and it is where the guard
     * and every service meet. If it constructs, the request path is wired.
     */
    expect(
      moduleRef.get(GithubController),
    ).toBeInstanceOf(GithubController);

    expect(moduleRef.get(AuthGuard)).toBeInstanceOf(
      AuthGuard,
    );
  });
});
