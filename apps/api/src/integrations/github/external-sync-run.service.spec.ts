import { ConflictException } from '@nestjs/common';

import type { PrismaService } from '../../prisma/prisma.service.js';
import { createInMemoryPrisma } from '../test-doubles.js';

import { ExternalSyncRunService } from './external-sync-run.service.js';
import { buildSyncObservation, normalizeRepository } from './observations/normalize.js';
import type {
  RepositoryCompleteness,
  SyncObservation,
} from './observations/types.js';

const CONNECTION = 'conn-1';
const USER = '11111111-1111-4111-8111-111111111111';
const SCANNED_AT = '2026-09-07T12:00:00.000Z';

const scanned: RepositoryCompleteness = {
  commits: 'DEFAULT_BRANCH_ONLY',
  scannedSince: null,
  scannedAt: SCANNED_AT,
  truncated: false,
};

function build() {
  const store = createInMemoryPrisma();

  const service = new ExternalSyncRunService(
    store.prisma as unknown as PrismaService,
  );

  return { service, store };
}

function observation(
  repoStates: RepositoryCompleteness[],
  reposTotal = repoStates.length,
  truncated = false,
): SyncObservation {
  return buildSyncObservation({
    account: {
      accountId: '583231',
      login: 'octocat',
    },
    repositories: repoStates.map(
      (completeness, index) =>
        normalizeRepository({
          raw: {
            id: index + 1,
            name: `repo-${index + 1}`,
            full_name: `octocat/repo-${index + 1}`,
            html_url: `https://github.com/octocat/repo-${index + 1}`,
            owner: {
              id: 583231,
              login: 'octocat',
            },
            visibility: 'public',
          },
          completeness,
        })!,
    ),
    reposTotal,
    scannedAt: SCANNED_AT,
    scannedSince: null,
    truncated,
  });
}

describe('ExternalSyncRunService', () => {
  describe('start', () => {
    it('opens a run in RUNNING', async () => {
      const { service, store } = build();

      const run = await service.start({
        connectionId: CONNECTION,
        userId: USER,
      });

      expect(run.id).toBeTruthy();
      expect(store.rows.syncRuns).toHaveLength(
        1,
      );
      expect(
        store.rows.syncRuns[0]!.status,
      ).toBe('RUNNING');
    });

    it('refuses a second concurrent run for one connection', async () => {
      const { service } = build();

      await service.start({
        connectionId: CONNECTION,
        userId: USER,
      });

      await expect(
        service.start({
          connectionId: CONNECTION,
          userId: USER,
        }),
      ).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('allows a run for a different connection', async () => {
      const { service, store } = build();

      await service.start({
        connectionId: CONNECTION,
        userId: USER,
      });

      await service.start({
        connectionId: 'conn-2',
        userId: USER,
      });

      expect(store.rows.syncRuns).toHaveLength(
        2,
      );
    });

    /*
     * The failure this guards is real and has a precedent in this
     * codebase: a claim with no lease and no sweeper strands the row
     * forever when the process dies.
     */
    it('reclaims an abandoned run instead of blocking forever', async () => {
      const { service, store } = build();

      await service.start({
        connectionId: CONNECTION,
        userId: USER,
      });

      /* The process died an hour ago. */
      store.rows.syncRuns[0]!.startedAt =
        new Date(Date.now() - 60 * 60 * 1000);

      await expect(
        service.start({
          connectionId: CONNECTION,
          userId: USER,
        }),
      ).resolves.toBeTruthy();

      expect(
        store.rows.syncRuns[0]!.status,
      ).toBe('FAILED');
      expect(
        store.rows.syncRuns[0]!.errorMessage,
      ).toMatch(/Abandoned/);
      expect(
        store.rows.syncRuns[1]!.status,
      ).toBe('RUNNING');
    });

    it('does not reclaim a run that is merely slow', async () => {
      const { service, store } = build();

      await service.start({
        connectionId: CONNECTION,
        userId: USER,
      });

      store.rows.syncRuns[0]!.startedAt =
        new Date(Date.now() - 60 * 1000);

      await expect(
        service.start({
          connectionId: CONNECTION,
          userId: USER,
        }),
      ).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('finish', () => {
    it('records SUCCEEDED only when everything was scanned', async () => {
      const { service, store } = build();

      const run = await service.start({
        connectionId: CONNECTION,
        userId: USER,
      });

      const result = await service.finish(
        run.id,
        observation([scanned, scanned]),
      );

      expect(result.status).toBe('SUCCEEDED');
      expect(
        store.rows.syncRuns[0]!.status,
      ).toBe('SUCCEEDED');
      expect(
        store.rows.syncRuns[0]!.finishedAt,
      ).toBeInstanceOf(Date);
    });

    /* The rule the ledger exists to enforce. */
    it('records PARTIAL when a repository was not scanned', async () => {
      const { service } = build();

      const run = await service.start({
        connectionId: CONNECTION,
        userId: USER,
      });

      const result = await service.finish(
        run.id,
        observation([
          scanned,
          { ...scanned, commits: 'NOT_SCANNED' },
        ]),
      );

      expect(result.status).toBe('PARTIAL');
    });

    it('records PARTIAL for 30 of 40, never SUCCEEDED', async () => {
      const { service, store } = build();

      const run = await service.start({
        connectionId: CONNECTION,
        userId: USER,
      });

      const states = Array.from(
        { length: 40 },
        (_, i) =>
          i < 30
            ? scanned
            : {
                ...scanned,
                commits: 'NOT_SCANNED' as const,
              },
      );

      const result = await service.finish(
        run.id,
        observation(states, 40),
      );

      expect(result.status).toBe('PARTIAL');
      expect(result.status).not.toBe(
        'SUCCEEDED',
      );

      const stats = store.rows.syncRuns[0]!
        .stats as {
        completeness: {
          reposScanned: number;
          reposTotal: number;
        };
      };

      expect(stats.completeness).toMatchObject({
        reposScanned: 30,
        reposTotal: 40,
      });
    });

    it('records PARTIAL when the listing itself was truncated', async () => {
      const { service } = build();

      const run = await service.start({
        connectionId: CONNECTION,
        userId: USER,
      });

      expect(
        (
          await service.finish(
            run.id,
            observation([scanned], 1, true),
          )
        ).status,
      ).toBe('PARTIAL');
    });

    it('refuses to call a run complete when a repository could not be read', async () => {
      const { service, store } = build();

      const run = await service.start({
        connectionId: CONNECTION,
        userId: USER,
      });

      const result = await service.finish(
        run.id,
        observation([
          scanned,
          { ...scanned, commits: 'ACCESS_LOST' },
        ]),
      );

      /*
       * PARTIAL, not SUCCEEDED. This assertion was inverted until the
       * 7.4 integration review: a run that could not read a repository
       * did not gather complete data, and a run where EVERY repository
       * 404'd would otherwise have reported total success having read
       * nothing at all. ACCESS_LOST still retains the historical
       * observation - that is the persistence layer's job - but it is not
       * a successful scan.
       */
      expect(result.status).toBe('PARTIAL');

      const stats = store.rows.syncRuns[0]!
        .stats as {
        repositories: Array<{
          commits: string;
        }>;
      };

      expect(
        stats.repositories.map((r) => r.commits),
      ).toEqual([
        'DEFAULT_BRANCH_ONLY',
        'ACCESS_LOST',
      ]);
    });

    it('refuses to close a run that is not running', async () => {
      const { service } = build();

      const run = await service.start({
        connectionId: CONNECTION,
        userId: USER,
      });

      await service.finish(
        run.id,
        observation([scanned]),
      );

      await expect(
        service.finish(
          run.id,
          observation([scanned]),
        ),
      ).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('writes no credential material into stats', async () => {
      const { service, store } = build();

      const run = await service.start({
        connectionId: CONNECTION,
        userId: USER,
      });

      await service.finish(
        run.id,
        observation([scanned, scanned]),
      );

      const serialized = JSON.stringify(
        store.rows.syncRuns[0]!.stats,
      );

      for (const forbidden of [
        'gho_',
        'ghu_',
        'ghp_',
        'Authorization',
        'Bearer',
        'access_token',
        'client_secret',
      ]) {
        expect(serialized).not.toContain(
          forbidden,
        );
      }
    });
  });

  describe('fail', () => {
    it('records FAILED with a sanitized reason', async () => {
      const { service, store } = build();

      const run = await service.start({
        connectionId: CONNECTION,
        userId: USER,
      });

      await service.fail(
        run.id,
        'rate_limited',
      );

      expect(
        store.rows.syncRuns[0]!.status,
      ).toBe('FAILED');
      expect(
        store.rows.syncRuns[0]!.errorMessage,
      ).toBe('rate_limited');
    });

    it('does not reopen a run that already closed', async () => {
      const { service, store } = build();

      const run = await service.start({
        connectionId: CONNECTION,
        userId: USER,
      });

      await service.finish(
        run.id,
        observation([scanned]),
      );

      await service.fail(run.id, 'too_late');

      expect(
        store.rows.syncRuns[0]!.status,
      ).toBe('SUCCEEDED');
    });

    it('frees the connection for a later run', async () => {
      const { service } = build();

      const run = await service.start({
        connectionId: CONNECTION,
        userId: USER,
      });

      await service.fail(run.id, 'network');

      await expect(
        service.start({
          connectionId: CONNECTION,
          userId: USER,
        }),
      ).resolves.toBeTruthy();
    });
  });
});
