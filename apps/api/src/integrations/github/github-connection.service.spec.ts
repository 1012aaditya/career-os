import { inspect } from 'node:util';

import type { PrismaService } from '../../prisma/prisma.service.js';
import { connectionTokenAad } from '../crypto/aad.js';
import { fromStorageBytes } from '../crypto/bytes.js';
import { EncryptionService } from '../crypto/encryption.service.js';
import {
  createInMemoryPrisma,
  stubConfig,
  TEST_ENCRYPTION_CONFIG,
} from '../test-doubles.js';

import {
  GithubApiClient,
  GithubApiError,
} from './github-api.client.js';
import {
  GithubAccountAlreadyLinkedError,
  GithubConnectionService,
} from './github-connection.service.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

const TOKEN_PREFIX = 'gho';

const TOKEN = `${TOKEN_PREFIX}_16C7e42F292c6912E7710c838347Ae178B4a`;

function build(
  revokeGrant: (
    token: string,
  ) => Promise<void> = async () => {},
) {
  const store = createInMemoryPrisma();

  const encryption = new EncryptionService(
    stubConfig(TEST_ENCRYPTION_CONFIG),
  );

  const revoked: string[] = [];

  const api = {
    revokeGrant: async (token: string) => {
      revoked.push(token);
      await revokeGrant(token);
    },
  } as unknown as GithubApiClient;

  const service = new GithubConnectionService(
    store.prisma as unknown as PrismaService,
    encryption,
    api,
  );

  return { service, store, encryption, revoked };
}

const CONNECT = {
  userId: USER_A,
  accountId: '583231',
  login: 'octocat',
  accessToken: TOKEN,
  grantedScopes: ['user:email'],
};

describe('GithubConnectionService', () => {
  /* Security tests 9, 12, 13. */
  describe('persisting a connection', () => {
    it('encrypts the token before it reaches the database', async () => {
      const { service, store } = build();

      await service.upsertConnection(CONNECT);

      const row = store.rows.connections[0]!;

      /*
       * The whole row is serialized and searched, not just the token
       * column. A future field that cached the plaintext anywhere on the
       * record would fail here.
       */
      expect(
        JSON.stringify(row),
      ).not.toContain(TOKEN);

      expect(
        Buffer.from(
          row.tokenCiphertext!,
        ).toString('utf8'),
      ).not.toContain(TOKEN_PREFIX);

      expect(row.tokenAlg).toBe('aes-256-gcm');
      expect(row.tokenKeyVersion).toBe(1);
    });

    it('stores a token that decrypts only under the owning user', async () => {
      const { service, store, encryption } =
        build();

      await service.upsertConnection(CONNECT);

      const row = store.rows.connections[0]!;

      const record = {
        ciphertext: fromStorageBytes(
          row.tokenCiphertext!,
        ),
        iv: fromStorageBytes(row.tokenIv!),
        tag: fromStorageBytes(row.tokenTag!),
        keyVersion: row.tokenKeyVersion!,
        alg: 'aes-256-gcm',
      };

      expect(
        encryption.decrypt(
          record,
          connectionTokenAad(USER_A, 'GITHUB'),
        ),
      ).toBe(TOKEN);

      expect(() =>
        encryption.decrypt(
          record,
          connectionTokenAad(USER_B, 'GITHUB'),
        ),
      ).toThrow(
        'Unable to decrypt stored credential',
      );
    });

    it('stores the granted scopes and the account identity', async () => {
      const { service, store } = build();

      await service.upsertConnection({
        ...CONNECT,
        /* GitHub may grant something other than what was asked for. */
        grantedScopes: ['user:email', 'gist'],
      });

      const row = store.rows.connections[0]!;

      expect(row.grantedScopes).toEqual([
        'user:email',
        'gist',
      ]);
      expect(row.externalAccountId).toBe('583231');
      expect(row.externalAccountLogin).toBe(
        'octocat',
      );
      expect(row.status).toBe('ACTIVE');
      expect(row.lastVerifiedAt).toBeInstanceOf(
        Date,
      );
    });
  });

  /* Security test 14. */
  describe('duplicate connections', () => {
    it('replaces the credential instead of creating a second row', async () => {
      const { service, store } = build();

      await service.upsertConnection(CONNECT);
      await service.upsertConnection(CONNECT);
      await service.upsertConnection(CONNECT);

      expect(
        store.rows.connections,
      ).toHaveLength(1);
    });

    it('lets one user switch to a different GitHub account', async () => {
      const { service, store } = build();

      await service.upsertConnection(CONNECT);

      await service.upsertConnection({
        ...CONNECT,
        accountId: '999999',
        login: 'someone-else',
      });

      expect(
        store.rows.connections,
      ).toHaveLength(1);
      expect(
        store.rows.connections[0]!
          .externalAccountId,
      ).toBe('999999');
    });

    /*
     * The constraint that caps an account-linking CSRF: one GitHub
     * account cannot be attached to two of our users.
     */
    it('refuses a GitHub account already linked to another user', async () => {
      const { service, store } = build();

      await service.upsertConnection(CONNECT);

      await expect(
        service.upsertConnection({
          ...CONNECT,
          userId: USER_B,
        }),
      ).rejects.toBeInstanceOf(
        GithubAccountAlreadyLinkedError,
      );

      expect(
        store.rows.connections,
      ).toHaveLength(1);
      expect(
        store.rows.connections[0]!.userId,
      ).toBe(USER_A);
    });

    it('does not name the other account when refusing', async () => {
      const { service } = build();

      await service.upsertConnection(CONNECT);

      await expect(
        service.upsertConnection({
          ...CONNECT,
          userId: USER_B,
        }),
      ).rejects.toThrow(
        /already connected to another Career OS account/,
      );

      /*
       * An existence oracle would let anyone test whether a given GitHub
       * account belongs to a user of the product.
       */
      await expect(
        service.upsertConnection({
          ...CONNECT,
          userId: USER_B,
        }),
      ).rejects.not.toThrow(/octocat|583231/);
    });
  });

  /* Security test 10. */
  describe('status', () => {
    it('never returns token material', async () => {
      const { service } = build();

      await service.upsertConnection(CONNECT);

      const status = await service.getStatus(
        USER_A,
      );

      const serialized = JSON.stringify(status);

      expect(serialized).not.toContain(TOKEN);
      expect(serialized).not.toContain(
        TOKEN_PREFIX,
      );

      for (const key of [
        'tokenCiphertext',
        'tokenIv',
        'tokenTag',
        'tokenKeyVersion',
        'tokenAlg',
        'accessToken',
      ]) {
        expect(status).not.toHaveProperty(key);
      }

      expect(status.connected).toBe(true);
      expect(status.login).toBe('octocat');
      expect(status.grantedScopes).toEqual([
        'user:email',
      ]);
    });

    it('reports a user with no connection as disconnected', async () => {
      const { service } = build();

      expect(
        await service.getStatus(USER_B),
      ).toMatchObject({
        connected: false,
        accountId: null,
        login: null,
      });
    });

    it('does not leak another user connection', async () => {
      const { service } = build();

      await service.upsertConnection(CONNECT);

      expect(
        (await service.getStatus(USER_B))
          .connected,
      ).toBe(false);
    });
  });

  /* Security tests 15 and 16. */
  describe('disconnect', () => {
    it('revokes at the provider and removes the local credential', async () => {
      const { service, store, revoked } =
        build();

      await service.upsertConnection(CONNECT);

      const result = await service.disconnect(
        USER_A,
      );

      expect(result).toEqual({
        disconnected: true,
        revokedAtProvider: true,
      });

      /* The plaintext token was sent to the revoke call... */
      expect(revoked).toEqual([TOKEN]);

      /* ...and nothing remains locally. */
      expect(store.rows.connections).toHaveLength(
        0,
      );
    });

    /*
     * The important half. A user must never be stuck connected because
     * GitHub is down, and the local credential must not survive the
     * attempt.
     */
    it('destroys local credentials even when revocation fails', async () => {
      const { service, store } = build(
        async () => {
          throw new GithubApiError(
            'revoke_grant',
            500,
            null,
          );
        },
      );

      await service.upsertConnection(CONNECT);

      const result = await service.disconnect(
        USER_A,
      );

      expect(result).toEqual({
        disconnected: true,
        /* Reported honestly rather than claimed. */
        revokedAtProvider: false,
      });

      expect(store.rows.connections).toHaveLength(
        0,
      );
    });

    it('destroys local credentials even when the ciphertext will not decrypt', async () => {
      const { service, store } = build();

      await service.upsertConnection(CONNECT);

      /* Simulate a key retired while a row still referenced it. */
      store.rows.connections[0]!.tokenKeyVersion = 99;

      const result = await service.disconnect(
        USER_A,
      );

      expect(result.disconnected).toBe(true);
      expect(result.revokedAtProvider).toBe(false);
      expect(store.rows.connections).toHaveLength(
        0,
      );
    });

    it('is idempotent for a user with no connection', async () => {
      const { service } = build();

      expect(
        await service.disconnect(USER_B),
      ).toEqual({
        disconnected: false,
        revokedAtProvider: false,
      });
    });

    it('only disconnects the caller', async () => {
      const { service, store } = build();

      await service.upsertConnection(CONNECT);
      await service.upsertConnection({
        ...CONNECT,
        userId: USER_B,
        accountId: '777',
        login: 'other',
      });

      await service.disconnect(USER_A);

      expect(store.rows.connections).toHaveLength(
        1,
      );
      expect(
        store.rows.connections[0]!.userId,
      ).toBe(USER_B);
    });

    /* Security test 17, at the disconnect path. */
    it('does not leak the token when revocation throws', async () => {
      const leaked: string[] = [];

      const warn = vi
        .spyOn(
          (await import('@nestjs/common')).Logger
            .prototype,
          'warn',
        )
        .mockImplementation((...args) => {
          leaked.push(
            args
              .map((a) =>
                inspect(a, { depth: null }),
              )
              .join(' '),
          );
        });

      const { service } = build(async () => {
        /*
         * Modelled on a real HTTP client failure: the error carries the
         * request that produced it, Authorization header and all. This is
         * the shape that leaks tokens in production.
         */
        const error = new Error(
          'Request failed',
        ) as Error & {
          config?: unknown;
        };

        error.config = {
          headers: {
            Authorization: `Bearer ${TOKEN}`,
          },
        };

        throw error;
      });

      await service.upsertConnection(CONNECT);
      await service.disconnect(USER_A);

      warn.mockRestore();

      expect(leaked.length).toBeGreaterThan(0);

      for (const line of leaked) {
        expect(line).not.toContain(TOKEN);
        expect(line).not.toContain(TOKEN_PREFIX);
      }
    });
  });
});
