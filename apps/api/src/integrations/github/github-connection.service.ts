import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';
import { StructuredLogger } from '../../observability/structured-logger.js';
import { connectionTokenAad } from '../crypto/aad.js';
import {
  fromStorageBytes,
  toStorageBytes,
} from '../crypto/bytes.js';
import { EncryptionService } from '../crypto/encryption.service.js';

import {
  GithubApiClient,
  GithubApiError,
} from './github-api.client.js';

const PROVIDER = 'GITHUB' as const;

/*
 * What GET /github/status returns.
 *
 * Written as an explicit type rather than by spreading the row, because
 * the row carries tokenCiphertext, tokenIv, tokenTag and tokenKeyVersion.
 * A `return connection` would ship encrypted credential material to the
 * client, and a later `select: undefined` or an added column would
 * silently reintroduce it. Listing the safe fields means the default is
 * to expose nothing.
 */
export type GithubConnectionStatus = {
  connected: boolean;
  accountId: string | null;
  login: string | null;
  grantedScopes: string[];
  status: string | null;
  lastVerifiedAt: Date | null;
  lastSyncedAt: Date | null;
};

export const DISCONNECTED_STATUS: GithubConnectionStatus =
  {
    connected: false,
    accountId: null,
    login: null,
    grantedScopes: [],
    status: null,
    lastVerifiedAt: null,
    lastSyncedAt: null,
  };

export type DisconnectResult = {
  disconnected: boolean;
  /*
   * Whether GitHub confirmed the revocation. Reported honestly: a failure
   * here does not stop the local credential being destroyed, and claiming
   * a revocation that did not happen would be worse than admitting it.
   */
  revokedAtProvider: boolean;
};

export class GithubAccountAlreadyLinkedError extends Error {
  constructor() {
    super(
      'This GitHub account is already connected to another Career OS account',
    );
    this.name =
      'GithubAccountAlreadyLinkedError';
  }
}

@Injectable()
export class GithubConnectionService {
  /*
   * Nest's logger, used only for facts: a status code, an operation name,
   * a user id. No token, no ciphertext, no error object from the HTTP
   * client.
   */

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly github: GithubApiClient,
    /*
     * Optional with a default, matching the pattern the source clients
     * already use for their injected sleep and credentials. The container
     * supplies the shared singleton; the default exists so the Phase 7
     * specs, which construct these services directly with a fixed
     * argument list, keep working without being rewritten for a
     * diagnostics change.
     */
    @Optional()
    private readonly structured: StructuredLogger = new StructuredLogger(),
  ) {}

  /**
   * Creates or updates the connection for a user.
   *
   * The userId comes from the consumed authorization request and from
   * nowhere else - see OAuthStateService for why that matters.
   */
  async upsertConnection(input: {
    userId: string;
    accountId: string;
    login: string;
    accessToken: string;
    grantedScopes: string[];
  }): Promise<void> {
    /*
     * One Career OS user per GitHub account. Checked before writing so
     * the common case gets a meaningful error, and caught below as well
     * because the check and the write are not atomic - the database
     * constraint is what actually enforces it.
     *
     * The message deliberately does not name the other account. Saying
     * who holds it would turn this into an existence oracle for other
     * users of the product.
     */
    const existingForAccount =
      await this.prisma.externalConnection.findUnique(
        {
          where: {
            provider_externalAccountId: {
              provider: PROVIDER,
              externalAccountId: input.accountId,
            },
          },
          select: { userId: true },
        },
      );

    if (
      existingForAccount &&
      existingForAccount.userId !== input.userId
    ) {
      throw new GithubAccountAlreadyLinkedError();
    }

    const encrypted = this.encryption.encrypt(
      input.accessToken,
      connectionTokenAad(
        input.userId,
        PROVIDER,
      ),
    );

    const now = new Date();

    const credentials = {
      externalAccountId: input.accountId,
      externalAccountLogin: input.login,
      tokenCiphertext: toStorageBytes(
        encrypted.ciphertext,
      ),
      tokenIv: toStorageBytes(encrypted.iv),
      tokenTag: toStorageBytes(encrypted.tag),
      tokenKeyVersion: encrypted.keyVersion,
      tokenAlg: encrypted.alg,
      grantedScopes: input.grantedScopes,
      status: 'ACTIVE' as const,
      /*
       * Set here and only here: it records that GitHub answered for this
       * token, which is the only thing that verifies the account
       * identity.
       */
      lastVerifiedAt: now,
    };

    try {
      await this.prisma.externalConnection.upsert(
        {
          where: {
            userId_provider: {
              userId: input.userId,
              provider: PROVIDER,
            },
          },
          create: {
            userId: input.userId,
            provider: PROVIDER,
            ...credentials,
          },
          /*
           * Reconnecting replaces the credential in place rather than
           * creating a second row, so a user who connects twice - or
           * switches to a different GitHub account - ends with exactly
           * one connection.
           */
          update: credentials,
        },
      );
    } catch (error) {
      if (
        error instanceof
          Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new GithubAccountAlreadyLinkedError();
      }

      throw error;
    }
  }

  async getStatus(
    userId: string,
  ): Promise<GithubConnectionStatus> {
    const connection =
      await this.prisma.externalConnection.findUnique(
        {
          where: {
            userId_provider: {
              userId,
              provider: PROVIDER,
            },
          },
          /*
           * Explicit select. The token columns are not merely unused
           * here, they are unreadable from this query - so no future edit
           * to the response shape can surface them by accident.
           */
          select: {
            externalAccountId: true,
            externalAccountLogin: true,
            grantedScopes: true,
            status: true,
            lastVerifiedAt: true,
            lastSyncedAt: true,
          },
        },
      );

    if (!connection) {
      return DISCONNECTED_STATUS;
    }

    return {
      connected: true,
      accountId: connection.externalAccountId,
      login: connection.externalAccountLogin,
      grantedScopes: connection.grantedScopes,
      status: connection.status,
      lastVerifiedAt: connection.lastVerifiedAt,
      lastSyncedAt: connection.lastSyncedAt,
    };
  }

  /**
   * Disconnects, revoking at GitHub first and destroying the local
   * credential regardless of what GitHub says.
   *
   * Order matters. Deleting first and then failing to revoke would leave
   * a live token we can no longer identify or revoke - an orphaned
   * credential with no owner. Revoking first means the worst case is a
   * token that is still live at GitHub but that we no longer hold, which
   * the user can also clear from their own GitHub settings.
   *
   * The row is deleted rather than kept with the token nulled. A row that
   * survives would hold the unique (provider, externalAccountId), so a
   * user who disconnects would permanently prevent anybody else - or
   * themselves, on a fresh account - from connecting that GitHub account
   * again.
   */
  async disconnect(
    userId: string,
  ): Promise<DisconnectResult> {
    const connection =
      await this.prisma.externalConnection.findUnique(
        {
          where: {
            userId_provider: {
              userId,
              provider: PROVIDER,
            },
          },
        },
      );

    if (!connection) {
      /*
       * Idempotent. Disconnecting something already disconnected is the
       * caller getting what they asked for, not an error.
       */
      return {
        disconnected: false,
        revokedAtProvider: false,
      };
    }

    let revokedAtProvider = false;

    if (
      connection.tokenCiphertext &&
      connection.tokenIv &&
      connection.tokenTag &&
      connection.tokenKeyVersion !== null
    ) {
      try {
        const accessToken =
          this.encryption.decrypt(
            {
              ciphertext: fromStorageBytes(
                connection.tokenCiphertext,
              ),
              iv: fromStorageBytes(
                connection.tokenIv,
              ),
              tag: fromStorageBytes(
                connection.tokenTag,
              ),
              keyVersion:
                connection.tokenKeyVersion,
              alg:
                connection.tokenAlg ??
                'aes-256-gcm',
            },
            connectionTokenAad(userId, PROVIDER),
          );

        await this.github.revokeGrant(
          accessToken,
        );

        revokedAtProvider = true;
      } catch (error) {
        /*
         * Swallowed on purpose, and the local delete below still runs.
         *
         * A user must never be blocked from disconnecting because GitHub
         * is unreachable, or because the stored ciphertext can no longer
         * be decrypted - the second case is precisely when holding onto
         * the row is least useful and most dangerous.
         *
         * Only the shape of the failure is logged. The caught error is
         * never passed to the logger: if it came from the HTTP client it
         * would carry the Authorization header that failed.
         */
        this.structured.event('warn', 'github.revocation.failed', {
          /*
           * A pseudonym, not the user id. PR-5: the id is the key that
           * indexes this person's career history and does not belong in a
           * log aggregator, while "the same person failed twice" still
           * needs to be answerable.
           */
          actor: this.structured.actor(userId),
          provider: 'github',
          operation:
            error instanceof GithubApiError ? error.operation : 'revoke_grant',
          statusCode:
            error instanceof GithubApiError ? (error.status ?? null) : null,
          errorCode:
            error instanceof GithubApiError
              ? (error.code ?? 'none')
              : 'local_error',
          errorCategory: 'dependency',
        });
      }
    }

    await this.prisma.externalConnection.delete({
      where: { id: connection.id },
    });

    return {
      disconnected: true,
      revokedAtProvider,
    };
  }
}
