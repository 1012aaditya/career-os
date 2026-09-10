import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';

/*
 * In-memory stand-ins for the two tables Phase 7.2 touches.
 *
 * These substitute the database, not the code under test. The services in
 * every spec are the real ones, and the behaviour that carries the
 * security argument - the compare-and-swap that makes a state single-use,
 * the unique constraint on (provider, externalAccountId) - is implemented
 * here faithfully rather than stubbed away. A double that accepted every
 * write would let all twenty security tests pass against an
 * implementation with no guards at all.
 */

type AuthRequestRow = {
  id: string;
  userId: string;
  provider: string;
  stateHash: string;
  codeVerifierCiphertext: Uint8Array;
  codeVerifierIv: Uint8Array;
  codeVerifierTag: Uint8Array;
  codeVerifierKeyVersion: number;
  redirectUri: string;
  scope: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
};

type SyncRunRow = {
  id: string;
  connectionId: string;
  userId: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  errorMessage: string | null;
  stats: unknown;
};

type EvidenceRow = {
  id: string;
  userId: string;
  resumeImportId: string | null;
  sourceType: string;
  title: string;
  description: string | null;
  sourceUrl: string | null;
  externalId: string | null;
  occurredAt: Date | null;
  capturedAt: Date;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
};

type ConnectionRow = {
  id: string;
  userId: string;
  provider: string;
  externalAccountId: string;
  externalAccountLogin: string;
  tokenCiphertext: Uint8Array | null;
  tokenIv: Uint8Array | null;
  tokenTag: Uint8Array | null;
  tokenKeyVersion: number | null;
  tokenAlg: string | null;
  grantedScopes: string[];
  status: string;
  lastVerifiedAt: Date | null;
  lastSyncedAt: Date | null;
};

function uniqueViolation(target: string[]) {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed',
    {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target },
    },
  );
}

export function createInMemoryPrisma() {
  const authRequests: AuthRequestRow[] = [];
  const connections: ConnectionRow[] = [];
  const syncRuns: SyncRunRow[] = [];
  const evidence: EvidenceRow[] = [];

  /* Every evidence.updateMany the run issued, so a test can count them. */
  const evidenceUpdateManyCalls: {
    ids: string[];
    data: Record<string, unknown>;
  }[] = [];

  const oAuthAuthorizationRequest = {
    create: async ({ data }: { data: Omit<AuthRequestRow, 'id' | 'consumedAt' | 'createdAt'> }) => {
      if (
        authRequests.some(
          (row) => row.stateHash === data.stateHash,
        )
      ) {
        throw uniqueViolation(['stateHash']);
      }

      const row: AuthRequestRow = {
        id: randomUUID(),
        consumedAt: null,
        createdAt: new Date(),
        ...data,
      };

      authRequests.push(row);

      return row;
    },

    findUnique: async ({
      where,
    }: {
      where: { stateHash: string };
    }) =>
      authRequests.find(
        (row) => row.stateHash === where.stateHash,
      ) ?? null,

    /*
     * The compare-and-swap the whole single-use guarantee rests on. Every
     * clause in the caller's `where` is applied, so a caller that dropped
     * `consumedAt: null` would let a state be replayed and the
     * corresponding test would fail.
     */
    updateMany: async ({
      where,
      data,
    }: {
      where: {
        stateHash: string;
        provider?: string;
        consumedAt?: null;
        expiresAt?: { gt: Date };
      };
      data: { consumedAt: Date };
    }) => {
      const matches = authRequests.filter((row) => {
        if (row.stateHash !== where.stateHash) return false;
        if (where.provider && row.provider !== where.provider) return false;
        if (
          where.consumedAt === null &&
          row.consumedAt !== null
        ) {
          return false;
        }
        if (
          where.expiresAt &&
          !(row.expiresAt.getTime() > where.expiresAt.gt.getTime())
        ) {
          return false;
        }
        return true;
      });

      for (const row of matches) {
        row.consumedAt = data.consumedAt;
      }

      return { count: matches.length };
    },

    deleteMany: async ({
      where,
    }: {
      where: {
        userId: string;
        provider: string;
        expiresAt: { lt: Date };
      };
    }) => {
      let count = 0;

      for (let i = authRequests.length - 1; i >= 0; i -= 1) {
        const row = authRequests[i]!;

        if (
          row.userId === where.userId &&
          row.provider === where.provider &&
          row.expiresAt.getTime() < where.expiresAt.lt.getTime()
        ) {
          authRequests.splice(i, 1);
          count += 1;
        }
      }

      return { count };
    },
  };

  const findConnection = (where: {
    userId_provider?: { userId: string; provider: string };
    provider_externalAccountId?: {
      provider: string;
      externalAccountId: string;
    };
  }) => {
    if (where.userId_provider) {
      const key = where.userId_provider;
      return (
        connections.find(
          (row) =>
            row.userId === key.userId &&
            row.provider === key.provider,
        ) ?? null
      );
    }

    if (where.provider_externalAccountId) {
      const key = where.provider_externalAccountId;
      return (
        connections.find(
          (row) =>
            row.provider === key.provider &&
            row.externalAccountId ===
              key.externalAccountId,
        ) ?? null
      );
    }

    return null;
  };

  const externalConnection = {
    findUnique: async ({
      where,
    }: {
      where: Parameters<typeof findConnection>[0];
    }) => findConnection(where),

    upsert: async ({
      where,
      create,
      update,
    }: {
      where: {
        userId_provider: {
          userId: string;
          provider: string;
        };
      };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const existing = findConnection(where);

      /*
       * The (provider, externalAccountId) unique index, enforced for real.
       * Without it, two of our users could share one GitHub account and
       * the duplicate-connection tests would pass vacuously.
       */
      const accountId = (existing
        ? update
        : create)['externalAccountId'] as string;

      const provider =
        where.userId_provider.provider;

      const clash = connections.find(
        (row) =>
          row.provider === provider &&
          row.externalAccountId === accountId &&
          row.userId !== where.userId_provider.userId,
      );

      if (clash) {
        throw uniqueViolation([
          'provider',
          'externalAccountId',
        ]);
      }

      if (existing) {
        Object.assign(existing, update);
        return existing;
      }

      const row = {
        id: randomUUID(),
        lastSyncedAt: null,
        ...create,
      } as ConnectionRow;

      connections.push(row);

      return row;
    },

    /*
     * updateMany rather than update, mirroring how the sync service must
     * write lastSyncedAt: disconnect DELETES the connection row, so a
     * disconnect racing a long sync would make update() throw P2025 after
     * the sync had already succeeded. updateMany no-ops on zero rows.
     */
    updateMany: async ({
      where,
      data,
    }: {
      where: {
        userId?: string;
        provider?: string;
        id?: string;
      };
      data: Record<string, unknown>;
    }) => {
      const matches = connections.filter(
        (row) => {
          if (where.id) {
            return row.id === where.id;
          }

          return (
            (!where.userId ||
              row.userId === where.userId) &&
            (!where.provider ||
              row.provider === where.provider)
          );
        },
      );

      for (const row of matches) {
        Object.assign(row, data);
      }

      return { count: matches.length };
    },

    delete: async ({
      where,
    }: {
      where: { id: string };
    }) => {
      const index = connections.findIndex(
        (row) => row.id === where.id,
      );

      if (index === -1) {
        throw new Error('Record not found');
      }

      return connections.splice(index, 1)[0]!;
    },
  };

  /*
   * The ledger. updateMany applies every clause the caller supplies,
   * including the compare-and-swap on RUNNING and the staleness cutoff -
   * a double that ignored them would let a closed run be reopened and
   * would make the "no false SUCCEEDED" tests pass vacuously.
   */
  const externalSyncRun = {
    create: async ({
      data,
      select,
    }: {
      data: Omit<
        SyncRunRow,
        'id' | 'startedAt' | 'finishedAt' | 'errorMessage' | 'stats'
      >;
      select?: Record<string, boolean>;
    }) => {
      const row: SyncRunRow = {
        id: randomUUID(),
        startedAt: new Date(),
        finishedAt: null,
        errorMessage: null,
        stats: null,
        ...data,
      };

      syncRuns.push(row);

      return select ? { id: row.id } : row;
    },

    findFirst: async ({
      where,
    }: {
      where: {
        connectionId: string;
        status: string;
      };
    }) =>
      syncRuns.find(
        (row) =>
          row.connectionId ===
            where.connectionId &&
          row.status === where.status,
      ) ?? null,

    updateMany: async ({
      where,
      data,
    }: {
      where: {
        id?: string;
        connectionId?: string;
        status?: string;
        startedAt?: { lt: Date };
      };
      data: Partial<SyncRunRow>;
    }) => {
      const matches = syncRuns.filter((row) => {
        if (where.id && row.id !== where.id) return false;
        if (
          where.connectionId &&
          row.connectionId !== where.connectionId
        ) {
          return false;
        }
        if (
          where.status &&
          row.status !== where.status
        ) {
          return false;
        }
        if (
          where.startedAt &&
          !(
            row.startedAt.getTime() <
            where.startedAt.lt.getTime()
          )
        ) {
          return false;
        }
        return true;
      });

      for (const row of matches) {
        Object.assign(row, data);
      }

      return { count: matches.length };
    },
  };

  /*
   * Evidence, with the (userId, sourceType, externalId) unique index
   * enforced for real.
   *
   * That index is the actual idempotency boundary - a pre-check cannot be
   * atomic - so a double that let duplicates through would make every
   * re-sync test pass against an implementation with no guarantee at all.
   * NULL externalId rows are treated as DISTINCT, matching Postgres, which
   * is what lets resume evidence coexist without colliding.
   */
  const evidenceModel = {
    findUnique: async ({
      where,
    }: {
      where: {
        userId_sourceType_externalId: {
          userId: string;
          sourceType: string;
          externalId: string;
        };
      };
    }) => {
      const key = where.userId_sourceType_externalId;

      return (
        evidence.find(
          (row) =>
            row.userId === key.userId &&
            row.sourceType === key.sourceType &&
            row.externalId !== null &&
            row.externalId === key.externalId,
        ) ?? null
      );
    },

    /*
     * Honours select and orderBy for real.
     *
     * A double that ignored orderBy would make a prior-state map that
     * silently depends on row order look deterministic, which is the one
     * property those tests exist to prove. Rows are returned in reverse
     * insertion order by default so an implementation that forgets
     * orderBy is caught rather than accidentally passing.
     */
    findMany: async (args?: {
      where?: {
        userId?: string;
        sourceType?: string;
      };
      select?: Record<string, boolean>;
      orderBy?: Record<string, 'asc' | 'desc'>;
    }) => {
      const matched = evidence.filter((row) => {
        const w = args?.where;
        if (!w) return true;
        if (w.userId && row.userId !== w.userId) return false;
        if (
          w.sourceType &&
          row.sourceType !== w.sourceType
        ) {
          return false;
        }
        return true;
      });

      const ordered = args?.orderBy
        ? [...matched].sort((a, b) => {
            const [field, dir] = Object.entries(
              args.orderBy!,
            )[0]!;

            const av = String(
              (a as unknown as Record<string, unknown>)[field] ?? '',
            );
            const bv = String(
              (b as unknown as Record<string, unknown>)[field] ?? '',
            );

            const cmp =
              av < bv ? -1 : av > bv ? 1 : 0;

            return dir === 'desc' ? -cmp : cmp;
          })
        : [...matched].reverse();

      if (!args?.select) {
        return ordered;
      }

      const fields = Object.keys(
        args.select,
      ).filter((key) => args.select![key]);

      return ordered.map((row) =>
        Object.fromEntries(
          fields.map((field) => [
            field,
            (row as unknown as Record<string, unknown>)[field],
          ]),
        ),
      ) as unknown as EvidenceRow[];
    },

    create: async ({
      data,
    }: {
      data: Record<string, unknown>;
    }) => {
      const externalId =
        (data['externalId'] as string | null) ?? null;

      if (
        externalId !== null &&
        evidence.some(
          (row) =>
            row.userId === data['userId'] &&
            row.sourceType === data['sourceType'] &&
            row.externalId === externalId,
        )
      ) {
        throw uniqueViolation([
          'userId',
          'sourceType',
          'externalId',
        ]);
      }

      const now = new Date();

      const row = {
        id: randomUUID(),
        resumeImportId: null,
        description: null,
        sourceUrl: null,
        externalId: null,
        occurredAt: null,
        capturedAt: now,
        metadata: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      } as EvidenceRow;

      evidence.push(row);

      return row;
    },

    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const row = evidence.find(
        (candidate) => candidate.id === where.id,
      );

      if (!row) {
        throw new Error('Record not found');
      }

      Object.assign(row, data, {
        updatedAt: new Date(),
      });

      return row;
    },

    /*
     * The freshness heartbeat, applied for real.
     *
     * It writes only the columns the caller names, exactly as Postgres
     * would - which is the whole point of modelling it rather than
     * stubbing it. A double that ignored `data`, or that assigned the
     * whole row, could not tell the difference between advancing
     * lastObservedAt and re-stamping capturedAt, and the tests asserting
     * that the heartbeat touches nothing else would pass over an
     * implementation that touched everything.
     *
     * `updates` is counted so a test can prove the run issued ONE
     * statement rather than one per repository.
     */
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: { in: string[] } };
      data: Record<string, unknown>;
    }) => {
      evidenceUpdateManyCalls.push({
        ids: [...where.id.in],
        data: { ...data },
      });

      let count = 0;

      for (const row of evidence) {
        if (!where.id.in.includes(row.id)) {
          continue;
        }

        Object.assign(row, data, {
          updatedAt: new Date(),
        });

        count += 1;
      }

      return { count };
    },

    upsert: async ({
      where,
      create,
      update,
    }: {
      where: {
        userId_sourceType_externalId: {
          userId: string;
          sourceType: string;
          externalId: string;
        };
      };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const key = where.userId_sourceType_externalId;

      const existing = evidence.find(
        (row) =>
          row.userId === key.userId &&
          row.sourceType === key.sourceType &&
          row.externalId === key.externalId,
      );

      if (existing) {
        Object.assign(existing, update, {
          updatedAt: new Date(),
        });

        return existing;
      }

      return evidenceModel.create({
        data: {
          userId: key.userId,
          sourceType: key.sourceType,
          externalId: key.externalId,
          ...create,
        },
      });
    },

    deleteMany: async (args?: {
      where?: { userId?: string; sourceType?: string };
    }) => {
      let count = 0;

      for (let i = evidence.length - 1; i >= 0; i -= 1) {
        const row = evidence[i]!;
        const w = args?.where;

        if (
          (!w?.userId || row.userId === w.userId) &&
          (!w?.sourceType ||
            row.sourceType === w.sourceType)
        ) {
          evidence.splice(i, 1);
          count += 1;
        }
      }

      return { count };
    },

    count: async (args?: {
      where?: { userId?: string; sourceType?: string };
    }) => (await evidenceModel.findMany(args)).length,
  };

  /*
   * The interactive-transaction form, handing the callback the same
   * client. There is no rollback here: an in-memory store cannot provide
   * one, and pretending otherwise would let a test assert atomicity that
   * the double is not actually delivering. Tests that care about a
   * rollback must say so explicitly rather than trusting this.
   */
  const prisma = {
    oAuthAuthorizationRequest,
    externalConnection,
    externalSyncRun,
    evidence: evidenceModel,
    $transaction: async (fn: unknown) =>
      typeof fn === 'function'
        ? await (fn as (tx: unknown) => unknown)(
            prisma,
          )
        : fn,
  };

  return {
    prisma,
    /** Direct access so tests can inspect what was actually persisted. */
    rows: {
      authRequests,
      connections,
      syncRuns,
      evidence,
    },
    /*
     * What the run actually issued, as distinct from what it stored.
     *
     * Needed because "one statement per sync rather than one per
     * repository" is a property of the CALLS, not of the resulting rows -
     * fourteen individual updates and one batched update leave the
     * database in exactly the same state.
     */
    calls: {
      evidenceUpdateMany: evidenceUpdateManyCalls,
    },
  };
}

/** A ConfigService backed by a plain object. */
export function stubConfig(
  values: Record<string, string>,
): ConfigService {
  return {
    get: (name: string) => values[name],
  } as unknown as ConfigService;
}

export const TEST_ENCRYPTION_CONFIG = {
  TOKEN_ENCRYPTION_KEYS: JSON.stringify({
    '1': Buffer.alloc(32, 7).toString('base64'),
  }),
  TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION: '1',
};

export const TEST_GITHUB_CONFIG = {
  GITHUB_CLIENT_ID: 'Iv1.testclientid',
  GITHUB_CLIENT_SECRET: 'test-client-secret-value',
  GITHUB_OAUTH_CALLBACK_URL:
    'https://api.example.com/v1/github/callback',
  GITHUB_OAUTH_MOBILE_REDIRECT_URI:
    'com.careeros.mobile://github/callback',
};
