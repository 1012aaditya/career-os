import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

/*
 * Envelope for credentials held at rest: provider access tokens, and the
 * PKCE verifiers that briefly stand in for them.
 *
 * AES-256-GCM, because the mode must be authenticated. An unauthenticated
 * mode would let anyone with UPDATE on the table flip bits in a ciphertext
 * and have the result decrypt to something attacker-influenced instead of
 * failing. GCM also authenticates Additional Authenticated Data, which is
 * what binds a ciphertext to the row that owns it - see aad.ts.
 *
 * Keys are supplied per version rather than as a single value, so rotation
 * can be lazy: new writes take the active key, reads accept any key still
 * configured, and rows migrate as they are touched. Note that rotating the
 * key does NOT re-encrypt existing rows; that is a separate backfill, and
 * the old key must stay configured until it completes.
 *
 * Nothing here logs. A thrown decryption error carries no plaintext, no
 * ciphertext, no key material and no cause chain, because the most common
 * way a token reaches a log is an error object that helpfully captured the
 * context it failed in.
 */

const ALGORITHM = 'aes-256-gcm';

const KEY_BYTES = 32;

/*
 * 96 bits, the size GCM is specified for. A fresh one is generated for
 * every encryption: reusing an IV under the same key is catastrophic for
 * GCM - it leaks the authentication subkey and the XOR of the plaintexts -
 * so the IV is never derived from a counter or from the record.
 */
const IV_BYTES = 12;

const TAG_BYTES = 16;

const KEYS_CONFIG_KEY = 'TOKEN_ENCRYPTION_KEYS';

const ACTIVE_VERSION_CONFIG_KEY =
  'TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION';

/*
 * Deliberately uninformative, and identical for every failure mode. A
 * decryption failure can mean a wrong key, a tampered ciphertext, a
 * tampered tag or a mismatched AAD, and telling a caller which would turn
 * this into an oracle.
 */
const DECRYPT_FAILURE_MESSAGE =
  'Unable to decrypt stored credential';

export type EncryptedRecord = {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
  alg: string;
};

@Injectable()
export class EncryptionService {
  private readonly keys: ReadonlyMap<number, Buffer>;

  private readonly activeKeyVersion: number;

  /*
   * Configuration is validated here, at construction, so a misconfigured
   * deployment fails to boot rather than failing on the first user who
   * connects an account. This mirrors SupabaseClientService.
   */
  constructor(config: ConfigService) {
    const raw = config.get<string>(
      KEYS_CONFIG_KEY,
    );

    if (!raw) {
      throw new Error(
        `${KEYS_CONFIG_KEY} must be configured`,
      );
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `${KEYS_CONFIG_KEY} must be valid JSON`,
      );
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        `${KEYS_CONFIG_KEY} must be a JSON object of version to base64 key`,
      );
    }

    const keys = new Map<number, Buffer>();

    for (const [version, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (!/^[1-9][0-9]*$/.test(version)) {
        throw new Error(
          `${KEYS_CONFIG_KEY} versions must be positive integers`,
        );
      }

      if (typeof value !== 'string') {
        throw new Error(
          `${KEYS_CONFIG_KEY} values must be base64 strings`,
        );
      }

      const key = Buffer.from(value, 'base64');

      /*
       * Length is checked rather than assumed. Buffer.from with base64
       * silently ignores characters it cannot decode, so a truncated or
       * corrupted key would otherwise arrive as a short buffer and be
       * rejected later by createCipheriv with a less obvious error.
       */
      if (key.length !== KEY_BYTES) {
        throw new Error(
          `${KEYS_CONFIG_KEY} key ${version} must decode to ${KEY_BYTES} bytes`,
        );
      }

      keys.set(Number(version), key);
    }

    if (keys.size === 0) {
      throw new Error(
        `${KEYS_CONFIG_KEY} must contain at least one key`,
      );
    }

    const activeRaw = config.get<string>(
      ACTIVE_VERSION_CONFIG_KEY,
    );

    if (
      !activeRaw ||
      !/^[1-9][0-9]*$/.test(activeRaw)
    ) {
      throw new Error(
        `${ACTIVE_VERSION_CONFIG_KEY} must be a positive integer`,
      );
    }

    const active = Number(activeRaw);

    if (!keys.has(active)) {
      throw new Error(
        `${ACTIVE_VERSION_CONFIG_KEY} ${active} is not present in ${KEYS_CONFIG_KEY}`,
      );
    }

    this.keys = keys;
    this.activeKeyVersion = active;
  }

  /**
   * Encrypts under the active key. The returned record carries everything
   * needed to decrypt it except the key itself and the AAD, both of which
   * the caller reconstructs.
   */
  encrypt(
    plaintext: string,
    aad: Buffer,
  ): EncryptedRecord {
    const key = this.keys.get(
      this.activeKeyVersion,
    );

    /*
     * Unreachable: the constructor proved the active version is present.
     * Asserted anyway, because the alternative to throwing here is
     * passing undefined to createCipheriv.
     */
    if (!key) {
      throw new Error(
        'Active encryption key is not configured',
      );
    }

    const iv = randomBytes(IV_BYTES);

    const cipher = createCipheriv(
      ALGORITHM,
      key,
      iv,
      { authTagLength: TAG_BYTES },
    );

    cipher.setAAD(aad);

    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    return {
      ciphertext,
      iv,
      tag: cipher.getAuthTag(),
      keyVersion: this.activeKeyVersion,
      alg: ALGORITHM,
    };
  }

  /**
   * Decrypts a record written by encrypt(). Throws a single opaque error
   * for every failure mode - wrong key, wrong AAD, tampered ciphertext,
   * tampered tag.
   */
  decrypt(
    record: EncryptedRecord,
    aad: Buffer,
  ): string {
    /*
     * An unknown key version is reported as a decryption failure rather
     * than as a configuration error: which key versions a deployment holds
     * is not something a caller should be able to probe for.
     */
    const key = this.keys.get(
      record.keyVersion,
    );

    if (!key) {
      throw new Error(
        DECRYPT_FAILURE_MESSAGE,
      );
    }

    if (record.alg !== ALGORITHM) {
      throw new Error(
        DECRYPT_FAILURE_MESSAGE,
      );
    }

    try {
      const decipher = createDecipheriv(
        ALGORITHM,
        key,
        record.iv,
        { authTagLength: TAG_BYTES },
      );

      decipher.setAAD(aad);
      decipher.setAuthTag(record.tag);

      return Buffer.concat([
        decipher.update(record.ciphertext),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      /*
       * The caught error is discarded rather than wrapped. Node's GCM
       * failure is not itself sensitive, but attaching it as a cause
       * builds a chain that serializers walk - and the frames in that
       * chain are the ones holding the credential.
       */
      throw new Error(
        DECRYPT_FAILURE_MESSAGE,
      );
    }
  }
}
