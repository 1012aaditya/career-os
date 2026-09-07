import type { PrismaService } from '../../prisma/prisma.service.js';
import { oauthCodeVerifierAad } from '../crypto/aad.js';
import { EncryptionService } from '../crypto/encryption.service.js';
import { fromStorageBytes } from '../crypto/bytes.js';
import {
  createInMemoryPrisma,
  stubConfig,
  TEST_ENCRYPTION_CONFIG,
} from '../test-doubles.js';

import {
  hashState,
  OAuthStateService,
} from './oauth-state.service.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

const REDIRECT =
  'https://api.example.com/v1/github/callback';

function build() {
  const store = createInMemoryPrisma();

  const encryption = new EncryptionService(
    stubConfig(TEST_ENCRYPTION_CONFIG),
  );

  const service = new OAuthStateService(
    store.prisma as unknown as PrismaService,
    encryption,
  );

  return { service, store, encryption };
}

describe('OAuthStateService', () => {
  /* Security test 2. */
  describe('state unpredictability', () => {
    it('produces a distinct high-entropy state every time', async () => {
      const { service } = build();

      const states = new Set<string>();

      for (let i = 0; i < 200; i += 1) {
        const created = await service.create(
          USER_A,
          'GITHUB',
          REDIRECT,
          'user:email',
        );

        states.add(created.state);
      }

      expect(states.size).toBe(200);

      /*
       * 32 random bytes base64url-encode to 43 characters. Asserting the
       * length catches a regression to something short or structured -
       * a counter, a uuid, a timestamp - which would still be "distinct"
       * on the check above while being guessable.
       */
      for (const state of states) {
        expect(state).toHaveLength(43);
        expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
      }
    });

    it('produces a distinct PKCE challenge every time', async () => {
      const { service } = build();

      const challenges = new Set<string>();

      for (let i = 0; i < 50; i += 1) {
        const created = await service.create(
          USER_A,
          'GITHUB',
          REDIRECT,
          'user:email',
        );

        challenges.add(created.codeChallenge);
        expect(created.codeChallengeMethod).toBe(
          'S256',
        );
      }

      expect(challenges.size).toBe(50);
    });
  });

  /* Security tests 3 and 18. */
  describe('what is persisted', () => {
    it('stores only the hash of the state, never the state', async () => {
      const { service, store } = build();

      const created = await service.create(
        USER_A,
        'GITHUB',
        REDIRECT,
        'user:email',
      );

      const row = store.rows.authRequests[0]!;

      expect(row.stateHash).toBe(
        hashState(created.state),
      );

      /*
       * The whole persisted row is searched, not just the column we
       * expect. A future change that added a convenience copy of the
       * plaintext elsewhere on the record would fail here.
       */
      const serialized = JSON.stringify(row);

      expect(serialized).not.toContain(
        created.state,
      );
    });

    it('encrypts the PKCE verifier at rest', async () => {
      const { service, store, encryption } =
        build();

      await service.create(
        USER_A,
        'GITHUB',
        REDIRECT,
        'user:email',
      );

      const row = store.rows.authRequests[0]!;

      const verifier = encryption.decrypt(
        {
          ciphertext: fromStorageBytes(
            row.codeVerifierCiphertext,
          ),
          iv: fromStorageBytes(
            row.codeVerifierIv,
          ),
          tag: fromStorageBytes(
            row.codeVerifierTag,
          ),
          keyVersion:
            row.codeVerifierKeyVersion,
          alg: 'aes-256-gcm',
        },
        oauthCodeVerifierAad(USER_A, 'GITHUB'),
      );

      /* It decrypts to a valid RFC 7636 verifier... */
      expect(verifier).toMatch(
        /^[A-Za-z0-9_-]{43,128}$/,
      );

      /* ...and the stored bytes are not that verifier. */
      expect(
        Buffer.from(
          row.codeVerifierCiphertext,
        ).toString('utf8'),
      ).not.toContain(verifier);
    });

    /*
     * Security test 6, at the storage layer: the verifier is bound to the
     * user by AAD, so a row lifted into another user's flow is unusable
     * even with full database access.
     */
    it('binds the stored verifier to the owning user', async () => {
      const { service, store, encryption } =
        build();

      await service.create(
        USER_A,
        'GITHUB',
        REDIRECT,
        'user:email',
      );

      const row = store.rows.authRequests[0]!;

      expect(() =>
        encryption.decrypt(
          {
            ciphertext: fromStorageBytes(
              row.codeVerifierCiphertext,
            ),
            iv: fromStorageBytes(
              row.codeVerifierIv,
            ),
            tag: fromStorageBytes(
              row.codeVerifierTag,
            ),
            keyVersion:
              row.codeVerifierKeyVersion,
            alg: 'aes-256-gcm',
          },
          oauthCodeVerifierAad(
            USER_B,
            'GITHUB',
          ),
        ),
      ).toThrow(
        'Unable to decrypt stored credential',
      );
    });
  });

  describe('consumption', () => {
    /* The user-binding boundary, stated directly. */
    it('returns the owning user from the record itself', async () => {
      const { service } = build();

      const created = await service.create(
        USER_B,
        'GITHUB',
        REDIRECT,
        'user:email',
      );

      const consumed = await service.consume(
        'GITHUB',
        created.state,
      );

      expect(consumed?.userId).toBe(USER_B);
    });

    /* Security tests 5 and 20. */
    it('cannot be consumed twice', async () => {
      const { service } = build();

      const created = await service.create(
        USER_A,
        'GITHUB',
        REDIRECT,
        'user:email',
      );

      const first = await service.consume(
        'GITHUB',
        created.state,
      );

      const second = await service.consume(
        'GITHUB',
        created.state,
      );

      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });

    it('yields exactly one winner under concurrent consumption', async () => {
      const { service } = build();

      const created = await service.create(
        USER_A,
        'GITHUB',
        REDIRECT,
        'user:email',
      );

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          service.consume(
            'GITHUB',
            created.state,
          ),
        ),
      );

      expect(
        results.filter((r) => r !== null),
      ).toHaveLength(1);
    });

    /* Security test 4. */
    it('refuses an expired state', async () => {
      const { service, store } = build();

      const created = await service.create(
        USER_A,
        'GITHUB',
        REDIRECT,
        'user:email',
      );

      /* Move the expiry into the past, as the clock would. */
      store.rows.authRequests[0]!.expiresAt =
        new Date(Date.now() - 1000);

      expect(
        await service.consume(
          'GITHUB',
          created.state,
        ),
      ).toBeNull();
    });

    it('expires ten minutes after creation', async () => {
      const { service, store } = build();

      const before = Date.now();

      await service.create(
        USER_A,
        'GITHUB',
        REDIRECT,
        'user:email',
      );

      const expiresAt =
        store.rows.authRequests[0]!.expiresAt.getTime();

      expect(
        expiresAt - before,
      ).toBeGreaterThan(9 * 60 * 1000);
      expect(
        expiresAt - before,
      ).toBeLessThanOrEqual(10 * 60 * 1000 + 50);
    });

    /* Security test 7. */
    it('refuses an unknown state', async () => {
      const { service } = build();

      expect(
        await service.consume(
          'GITHUB',
          'not-a-real-state',
        ),
      ).toBeNull();
    });

    it('refuses an empty state', async () => {
      const { service } = build();

      expect(
        await service.consume('GITHUB', ''),
      ).toBeNull();
    });

    /*
     * A state issued for one provider must not be redeemable at another.
     * Trivial today with a single provider; it stops being trivial the
     * moment Portfolio or a second OAuth source is added, which is
     * exactly when nobody would think to add the test.
     */
    it('refuses a state issued for a different provider', async () => {
      const { service } = build();

      const created = await service.create(
        USER_A,
        'PORTFOLIO',
        REDIRECT,
        'user:email',
      );

      expect(
        await service.consume(
          'GITHUB',
          created.state,
        ),
      ).toBeNull();
    });

    it('does not consume the record when it refuses it', async () => {
      const { service, store } = build();

      const created = await service.create(
        USER_A,
        'GITHUB',
        REDIRECT,
        'user:email',
      );

      await service.consume(
        'GITHUB',
        'wrong-state',
      );

      expect(
        store.rows.authRequests[0]!.consumedAt,
      ).toBeNull();

      /* The real one still works. */
      expect(
        await service.consume(
          'GITHUB',
          created.state,
        ),
      ).not.toBeNull();
    });
  });
});
