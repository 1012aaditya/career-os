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

  return {
    prisma: {
      oAuthAuthorizationRequest,
      externalConnection,
    },
    /** Direct access so tests can inspect what was actually persisted. */
    rows: { authRequests, connections },
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
    'careeros://github-callback',
};
