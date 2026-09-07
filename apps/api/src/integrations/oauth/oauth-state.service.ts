import { Injectable } from '@nestjs/common';
import type { ExternalProvider } from '@prisma/client';

import {
  createHash,
  randomBytes,
} from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service.js';
import { oauthCodeVerifierAad } from '../crypto/aad.js';
import {
  fromStorageBytes,
  toStorageBytes,
} from '../crypto/bytes.js';
import { EncryptionService } from '../crypto/encryption.service.js';

/*
 * The lifecycle of a pending OAuth authorization.
 *
 * This service is the only thing that answers "which of our users does
 * this callback belong to", and that is its entire reason for existing.
 *
 * The attack it defends against is account-linking CSRF, which is not the
 * same as ordinary login CSRF and is easy to build a system that is wide
 * open to. An attacker starts the flow and authorizes as themselves, but
 * does not let their own browser complete the redirect - they capture the
 * callback URL, which now carries a live authorization code for THEIR
 * provider account. They then induce a victim who is logged into our app
 * to issue that same GET. If the callback works out the owning user from
 * anything the victim's request carries - a cookie, a bearer token, "the
 * most recent pending request" - we exchange the attacker's code and
 * write connection(user = victim, github = attacker). The attacker now
 * feeds the victim's career graph, and on the day a "Sign in with GitHub"
 * feature ships, that record becomes account takeover.
 *
 * So the owning user is read from the consumed state row and from nowhere
 * else. Our API is bearer-token authenticated and the callback arrives in
 * a system browser, so there is no ambient session to read even by
 * accident - but that is a property of today's transport, not a guarantee,
 * and a web dashboard with cookie auth would quietly remove it. The rule
 * is enforced here, at the only place that can enforce it, and asserted
 * by test.
 */

/*
 * 256 bits. RFC 8252 asks for "a high-entropy secure random number"; this
 * is far above any plausible floor and costs nothing.
 */
const STATE_BYTES = 32;

/*
 * 32 bytes base64url-encodes to 43 characters, which is exactly the
 * minimum length RFC 7636 permits for a code verifier (43-128).
 */
const CODE_VERIFIER_BYTES = 32;

/*
 * Matched to the authorization code's own lifetime, which GitHub
 * documents as 10 minutes. A longer window buys nothing because the code
 * is dead anyway; a shorter one fails users who get interrupted by a
 * two-factor prompt.
 */
const TTL_MS = 10 * 60 * 1000;

export type CreatedAuthorizationRequest = {
  /*
   * The plaintext state, returned so it can be put in the authorization
   * URL. It is never persisted - only its digest is - so this value
   * exists in memory and in the URL and nowhere else.
   */
  state: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  expiresAt: Date;
};

export type ConsumedAuthorizationRequest = {
  id: string;
  /** The authoritative owner. The callback must use this and nothing else. */
  userId: string;
  provider: ExternalProvider;
  codeVerifier: string;
  redirectUri: string;
  scope: string;
};

function base64Url(input: Buffer): string {
  return input.toString('base64url');
}

/*
 * Exported so tests can assert that what is stored is the digest of the
 * state rather than the state, without reimplementing the hash and
 * therefore proving nothing.
 */
export function hashState(state: string): string {
  return createHash('sha256')
    .update(state, 'utf8')
    .digest('hex');
}

@Injectable()
export class OAuthStateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  async create(
    userId: string,
    provider: ExternalProvider,
    redirectUri: string,
    scope: string,
  ): Promise<CreatedAuthorizationRequest> {
    const state = base64Url(
      randomBytes(STATE_BYTES),
    );

    const codeVerifier = base64Url(
      randomBytes(CODE_VERIFIER_BYTES),
    );

    const codeChallenge = base64Url(
      createHash('sha256')
        .update(codeVerifier, 'utf8')
        .digest(),
    );

    /*
     * The verifier is encrypted even though it lives for ten minutes. It
     * is what turns a leaked authorization code back into a redeemable
     * one, so at rest it is a credential like any other - and the AAD
     * binds it to the user, so a row copied between users is unusable.
     */
    const encryptedVerifier =
      this.encryption.encrypt(
        codeVerifier,
        oauthCodeVerifierAad(userId, provider),
      );

    const expiresAt = new Date(
      Date.now() + TTL_MS,
    );

    /*
     * Opportunistic sweep of this user's dead rows. Cheap, keeps the
     * table from growing without bound, and avoids needing a scheduled
     * job for something a user's own traffic can clear.
     */
    await this.prisma.oAuthAuthorizationRequest.deleteMany(
      {
        where: {
          userId,
          provider,
          expiresAt: { lt: new Date() },
        },
      },
    );

    await this.prisma.oAuthAuthorizationRequest.create(
      {
        data: {
          userId,
          provider,
          stateHash: hashState(state),
          codeVerifierCiphertext: toStorageBytes(
            encryptedVerifier.ciphertext,
          ),
          codeVerifierIv: toStorageBytes(
            encryptedVerifier.iv,
          ),
          codeVerifierTag: toStorageBytes(
            encryptedVerifier.tag,
          ),
          codeVerifierKeyVersion:
            encryptedVerifier.keyVersion,
          redirectUri,
          scope,
          expiresAt,
        },
      },
    );

    return {
      state,
      codeChallenge,
      codeChallengeMethod: 'S256',
      expiresAt,
    };
  }

  /**
   * Consumes a pending request, or returns null.
   *
   * Null is returned for every failure - unknown state, expired state,
   * already-consumed state, a verifier that will not decrypt - and the
   * caller cannot tell which. Distinguishing them would let an attacker
   * probe for valid states.
   */
  async consume(
    provider: ExternalProvider,
    state: string,
  ): Promise<ConsumedAuthorizationRequest | null> {
    if (!state) {
      return null;
    }

    const stateHash = hashState(state);
    const now = new Date();

    /*
     * Single-use is enforced by this UPDATE and not by a read followed by
     * a write. Under READ COMMITTED, two concurrent callbacks carrying
     * the same state would both pass a read-then-write check; here
     * exactly one of them matches `consumedAt: null` and the other
     * updates zero rows.
     *
     * Expiry is part of the same predicate rather than a separate check,
     * so there is no window between deciding a row is live and claiming
     * it.
     */
    const claimed =
      await this.prisma.oAuthAuthorizationRequest.updateMany(
        {
          where: {
            stateHash,
            provider,
            consumedAt: null,
            expiresAt: { gt: now },
          },
          data: { consumedAt: now },
        },
      );

    if (claimed.count !== 1) {
      return null;
    }

    const request =
      await this.prisma.oAuthAuthorizationRequest.findUnique(
        {
          where: { stateHash },
        },
      );

    /*
     * Unreachable: the update above proved the row exists and we are the
     * only claimant. Handled rather than asserted because returning null
     * here is safe and throwing would not be.
     */
    if (!request) {
      return null;
    }

    let codeVerifier: string;

    try {
      /*
       * The AAD is rebuilt from the STORED userId. That is the whole
       * point: the verifier only decrypts under the identity the row
       * carries, so it cannot be lifted into another user's flow.
       */
      codeVerifier = this.encryption.decrypt(
        {
          ciphertext: fromStorageBytes(
            request.codeVerifierCiphertext,
          ),
          iv: fromStorageBytes(
            request.codeVerifierIv,
          ),
          tag: fromStorageBytes(
            request.codeVerifierTag,
          ),
          keyVersion:
            request.codeVerifierKeyVersion,
          alg: 'aes-256-gcm',
        },
        oauthCodeVerifierAad(
          request.userId,
          request.provider,
        ),
      );
    } catch {
      /*
       * Swallowed deliberately. The row is already consumed, so this
       * cannot be retried, and the caller learns only that the state was
       * unusable.
       */
      return null;
    }

    return {
      id: request.id,
      userId: request.userId,
      provider: request.provider,
      codeVerifier,
      redirectUri: request.redirectUri,
      scope: request.scope,
    };
  }
}
