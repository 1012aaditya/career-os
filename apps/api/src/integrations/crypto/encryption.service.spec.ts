import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';

import type { ConfigService } from '@nestjs/config';

import {
  connectionTokenAad,
  oauthCodeVerifierAad,
} from './aad.js';
import {
  EncryptionService,
  type EncryptedRecord,
} from './encryption.service.js';

/*
 * These tests execute the real EncryptionService against real node:crypto.
 * Nothing about the cipher is mocked - a mocked cipher would pass every
 * assertion below while proving nothing, and the properties under test
 * (authentication, AAD binding, IV uniqueness) are exactly the ones a
 * stub would fake.
 */

const key = (seed: number) =>
  Buffer.alloc(32, seed).toString('base64');

function configWith(
  keys: Record<string, string>,
  activeVersion: string,
): ConfigService {
  const values: Record<string, string> = {
    TOKEN_ENCRYPTION_KEYS: JSON.stringify(keys),
    TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION:
      activeVersion,
  };

  return {
    get: (name: string) => values[name],
  } as unknown as ConfigService;
}

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

/*
 * Shaped like a real GitHub user-to-server token, because the
 * serialization tests assert that this exact prefix never survives into a
 * logged error.
 *
 * Assembled from parts rather than written as one literal: a string
 * matching GitHub's token pattern in a committed file trips secret
 * scanning, and on a public repository GitHub revokes what it finds. The
 * value is not a credential, but a scanner cannot know that.
 */
const TOKEN_PREFIX = 'gho';

const TOKEN = `${TOKEN_PREFIX}_16C7e42F292c6912E7710c838347Ae178B4a`;

function service(
  keys: Record<string, string> = { '1': key(1) },
  active = '1',
) {
  return new EncryptionService(
    configWith(keys, active),
  );
}

describe('EncryptionService', () => {
  describe('round trip', () => {
    it('decrypts what it encrypted', () => {
      const subject = service();
      const aad = connectionTokenAad(
        USER_A,
        'GITHUB',
      );

      const record = subject.encrypt(TOKEN, aad);

      expect(subject.decrypt(record, aad)).toBe(
        TOKEN,
      );
    });

    it('does not store the plaintext in the ciphertext', () => {
      const subject = service();

      const record = subject.encrypt(
        TOKEN,
        connectionTokenAad(USER_A, 'GITHUB'),
      );

      expect(
        record.ciphertext.toString('utf8'),
      ).not.toContain(TOKEN);

      expect(
        record.ciphertext.toString('utf8'),
      ).not.toContain('gho_');
    });

    it('records the algorithm and key version it used', () => {
      const record = service().encrypt(
        TOKEN,
        connectionTokenAad(USER_A, 'GITHUB'),
      );

      expect(record.alg).toBe('aes-256-gcm');
      expect(record.keyVersion).toBe(1);
      expect(record.iv).toHaveLength(12);
      expect(record.tag).toHaveLength(16);
    });
  });

  /*
   * D6 test 2. This is the control that stops a stolen ciphertext from
   * being portable between rows.
   */
  describe('AAD binding', () => {
    it('refuses to decrypt under another user', () => {
      const subject = service();

      const record = subject.encrypt(
        TOKEN,
        connectionTokenAad(USER_A, 'GITHUB'),
      );

      expect(() =>
        subject.decrypt(
          record,
          connectionTokenAad(USER_B, 'GITHUB'),
        ),
      ).toThrow(
        'Unable to decrypt stored credential',
      );
    });

    it('refuses to decrypt under another provider', () => {
      const subject = service();

      const record = subject.encrypt(
        TOKEN,
        connectionTokenAad(USER_A, 'GITHUB'),
      );

      expect(() =>
        subject.decrypt(
          record,
          connectionTokenAad(
            USER_A,
            'PORTFOLIO',
          ),
        ),
      ).toThrow(
        'Unable to decrypt stored credential',
      );
    });

    it('refuses to decrypt a token as a PKCE verifier', () => {
      const subject = service();

      const record = subject.encrypt(
        TOKEN,
        connectionTokenAad(USER_A, 'GITHUB'),
      );

      expect(() =>
        subject.decrypt(
          record,
          oauthCodeVerifierAad(
            USER_A,
            'GITHUB',
          ),
        ),
      ).toThrow(
        'Unable to decrypt stored credential',
      );
    });

    /*
     * The attack stated concretely: every encrypted column is copied from
     * one user's row into another's. The copy is internally consistent -
     * ciphertext, iv and tag all belong together - and it still fails,
     * because the AAD is reconstructed from the row that now holds it.
     */
    it('refuses a whole row copied into another user', () => {
      const subject = service();

      const victimRow = subject.encrypt(
        TOKEN,
        connectionTokenAad(USER_A, 'GITHUB'),
      );

      const attackerRow: EncryptedRecord = {
        ciphertext: victimRow.ciphertext,
        iv: victimRow.iv,
        tag: victimRow.tag,
        keyVersion: victimRow.keyVersion,
        alg: victimRow.alg,
      };

      expect(() =>
        subject.decrypt(
          attackerRow,
          connectionTokenAad(USER_B, 'GITHUB'),
        ),
      ).toThrow(
        'Unable to decrypt stored credential',
      );
    });
  });

  /* D6 test 3. */
  describe('IV uniqueness', () => {
    it('uses a fresh IV and produces distinct ciphertext for every encryption', () => {
      const subject = service();
      const aad = connectionTokenAad(
        USER_A,
        'GITHUB',
      );

      const ivs = new Set<string>();
      const ciphertexts = new Set<string>();

      for (let i = 0; i < 100; i += 1) {
        const record = subject.encrypt(
          TOKEN,
          aad,
        );

        ivs.add(record.iv.toString('hex'));
        ciphertexts.add(
          record.ciphertext.toString('hex'),
        );
      }

      expect(ivs.size).toBe(100);
      expect(ciphertexts.size).toBe(100);
    });
  });

  /* D6 test 4. */
  describe('key rotation', () => {
    it('decrypts a row written under an older key version', () => {
      const before = service(
        { '1': key(1) },
        '1',
      );

      const aad = connectionTokenAad(
        USER_A,
        'GITHUB',
      );

      const legacyRecord = before.encrypt(
        TOKEN,
        aad,
      );

      expect(legacyRecord.keyVersion).toBe(1);

      const after = service(
        { '1': key(1), '2': key(2) },
        '2',
      );

      expect(
        after.decrypt(legacyRecord, aad),
      ).toBe(TOKEN);
    });

    it('writes new records under the active key version', () => {
      const after = service(
        { '1': key(1), '2': key(2) },
        '2',
      );

      const aad = connectionTokenAad(
        USER_A,
        'GITHUB',
      );

      const record = after.encrypt(TOKEN, aad);

      expect(record.keyVersion).toBe(2);
      expect(after.decrypt(record, aad)).toBe(
        TOKEN,
      );
    });

    /*
     * The failure mode this guards: retiring a key while rows written
     * under it still exist. It must fail closed rather than return
     * anything.
     */
    it('fails closed when the key that wrote a row is gone', () => {
      const aad = connectionTokenAad(
        USER_A,
        'GITHUB',
      );

      const legacyRecord = service(
        { '1': key(1) },
        '1',
      ).encrypt(TOKEN, aad);

      const retired = service(
        { '2': key(2) },
        '2',
      );

      expect(() =>
        retired.decrypt(legacyRecord, aad),
      ).toThrow(
        'Unable to decrypt stored credential',
      );
    });
  });

  describe('integrity', () => {
    const aad = () =>
      connectionTokenAad(USER_A, 'GITHUB');

    it('rejects a tampered ciphertext', () => {
      const subject = service();
      const record = subject.encrypt(
        TOKEN,
        aad(),
      );

      const tampered = Buffer.from(
        record.ciphertext,
      );
      tampered[0] ^= 0xff;

      expect(() =>
        subject.decrypt(
          { ...record, ciphertext: tampered },
          aad(),
        ),
      ).toThrow(
        'Unable to decrypt stored credential',
      );
    });

    it('rejects a tampered auth tag', () => {
      const subject = service();
      const record = subject.encrypt(
        TOKEN,
        aad(),
      );

      const tampered = Buffer.from(record.tag);
      tampered[0] ^= 0xff;

      expect(() =>
        subject.decrypt(
          { ...record, tag: tampered },
          aad(),
        ),
      ).toThrow(
        'Unable to decrypt stored credential',
      );
    });

    it('rejects a tampered IV', () => {
      const subject = service();
      const record = subject.encrypt(
        TOKEN,
        aad(),
      );

      const tampered = Buffer.from(record.iv);
      tampered[0] ^= 0xff;

      expect(() =>
        subject.decrypt(
          { ...record, iv: tampered },
          aad(),
        ),
      ).toThrow(
        'Unable to decrypt stored credential',
      );
    });

    it('rejects an unexpected algorithm', () => {
      const subject = service();
      const record = subject.encrypt(
        TOKEN,
        aad(),
      );

      expect(() =>
        subject.decrypt(
          { ...record, alg: 'aes-256-cbc' },
          aad(),
        ),
      ).toThrow(
        'Unable to decrypt stored credential',
      );
    });
  });

  describe('configuration', () => {
    const cases: Array<
      [string, Record<string, string>, string]
    > = [
      [
        'a key that is too short',
        { '1': Buffer.alloc(16, 1).toString('base64') },
        '1',
      ],
      [
        'a key that is too long',
        { '1': Buffer.alloc(48, 1).toString('base64') },
        '1',
      ],
      [
        'an active version that is not configured',
        { '1': key(1) },
        '9',
      ],
      [
        'a non-integer version',
        { abc: key(1) },
        '1',
      ],
      ['no keys at all', {}, '1'],
    ];

    it.each(cases)(
      'refuses to construct with %s',
      (_label, keys, active) => {
        expect(() =>
          service(keys, active),
        ).toThrow();
      },
    );

    it('refuses to construct without the keys variable', () => {
      const config = {
        get: () => undefined,
      } as unknown as ConfigService;

      expect(
        () => new EncryptionService(config),
      ).toThrow(
        'TOKEN_ENCRYPTION_KEYS must be configured',
      );
    });

    it('refuses to construct with malformed JSON', () => {
      const config = {
        get: (name: string) =>
          name === 'TOKEN_ENCRYPTION_KEYS'
            ? 'not json'
            : '1',
      } as unknown as ConfigService;

      expect(
        () => new EncryptionService(config),
      ).toThrow(
        'TOKEN_ENCRYPTION_KEYS must be valid JSON',
      );
    });

    it('does not put key material in a configuration error', () => {
      const secret = randomBytes(16).toString(
        'base64',
      );

      let message = '';

      try {
        service({ '1': secret }, '1');
      } catch (error) {
        message = inspect(error, {
          depth: null,
        });
      }

      expect(message).not.toBe('');
      expect(message).not.toContain(secret);
    });
  });

  /*
   * D6 test 5.
   *
   * The realistic leak is not someone printing a token deliberately. It is
   * `logger.error(err)` on an error that captured the value it failed on -
   * so this drives a real failure and then serializes the thrown error
   * every way a logger plausibly would.
   */
  describe('error serialization', () => {
    const PREFIXES = [
      'gho_',
      'ghu_',
      'ghp_',
      'ghs_',
      'ghr_',
      'github_pat_',
    ];

    const serializations = (
      error: unknown,
    ): string[] => [
      String(error),
      JSON.stringify(error) ?? '',
      JSON.stringify(
        error,
        Object.getOwnPropertyNames(
          Object(error),
        ),
      ) ?? '',
      inspect(error, {
        depth: null,
        showHidden: true,
      }),
      (error as Error)?.stack ?? '',
    ];

    it('never leaks a token prefix from a failed decryption', () => {
      const subject = service();

      const record = subject.encrypt(
        TOKEN,
        connectionTokenAad(USER_A, 'GITHUB'),
      );

      let caught: unknown;

      try {
        subject.decrypt(
          record,
          connectionTokenAad(USER_B, 'GITHUB'),
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);

      for (const serialized of serializations(
        caught,
      )) {
        for (const prefix of PREFIXES) {
          expect(serialized).not.toContain(
            prefix,
          );
        }

        expect(serialized).not.toContain(TOKEN);
      }
    });

    it('attaches no cause chain that a serializer could walk', () => {
      const subject = service();

      const record = subject.encrypt(
        TOKEN,
        connectionTokenAad(USER_A, 'GITHUB'),
      );

      try {
        subject.decrypt(
          record,
          connectionTokenAad(USER_B, 'GITHUB'),
        );
        expect.unreachable(
          'decrypt should have thrown',
        );
      } catch (error) {
        expect(
          (error as { cause?: unknown }).cause,
        ).toBeUndefined();
      }
    });
  });
});
