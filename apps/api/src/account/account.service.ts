import { Injectable, InternalServerErrorException } from '@nestjs/common';

import { AuthService } from '../auth/auth.service.js';
import { SupabaseClientService } from '../auth/supabase.client.js';
import { GithubConnectionService } from '../integrations/github/github-connection.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UserStorageService } from './user-storage.service.js';

/*
 * Deleting an account.
 *
 * THE ORDER IS THE DESIGN. Three systems hold this user's data and none of
 * them can be enrolled in one transaction: Postgres, Supabase Storage, and
 * Supabase Auth. So there is no atomic delete to write, and the honest
 * question is not "how do we make this atomic" but "in what order does
 * every possible partial failure leave the user able to finish the job".
 *
 *   1. GITHUB, revoked and disconnected. First, because it needs the
 *      encrypted token that step 3 destroys. Best effort: a failure here
 *      is recorded and does not stop the deletion, because the token is
 *      removed locally either way and a grant the user can also revoke
 *      from GitHub's own settings is not worth trapping them for.
 *
 *   2. STORAGE, every object under the user's prefix. Before the database,
 *      because the database is the INDEX of what to delete. A failure here
 *      ABORTS - nothing further happens, and the caller is told the
 *      deletion did not complete. Deleting the rows while files remained
 *      would leave objects that nothing points at, and would let us report
 *      success over a resume still sitting in a bucket.
 *
 *   3. DATABASE, one delete of the User row. Thirteen owned tables and
 *      every join table between them cascade from it. `Company` and
 *      `Skill` deliberately survive: they are shared vocabulary rather
 *      than this person's data, and deleting them would corrupt other
 *      users' graphs.
 *
 *   4. THE AUTH IDENTITY, last. While it exists the user can still
 *      authenticate, which means they can still RETRY. Deleting it first
 *      would strand anyone whose storage or database step failed - locked
 *      out, with their data still there, and no way to ask again.
 *
 * WHAT A FAILURE AT STEP 4 MEANS, stated plainly because it is the one
 * residue this design accepts: the data is gone and the login is not. The
 * caller gets an error, never a success, so nothing tells the user their
 * account is deleted when an identity still exists. Retrying reaches step
 * 4 again - the earlier steps are no-ops by then - and converges.
 *
 * EVERY STEP IS RETRY-SAFE. A missing GitHub connection, an object already
 * removed, a User row already deleted and an auth identity already gone
 * are all treated as the expected result of a retry rather than as errors.
 */

export type AccountDeletionResult = {
  /** Objects removed from storage, including ones already absent. */
  storageObjectsDeleted: number;
  /** Objects found under the prefix that no database row pointed at. */
  storageOrphansSwept: number;
  /** Whether a database row existed to delete. False on a retry. */
  databaseRecordDeleted: boolean;
  /** Whether the GitHub grant was revoked at GitHub, not merely locally. */
  githubRevokedAtProvider: boolean;
  /**
   * True when GitHub cleanup failed. The connection row is destroyed by
   * the cascade regardless; this says the grant may still exist at GitHub
   * and the user should revoke it there.
   */
  githubCleanupFailed: boolean;
  /** Whether the Supabase identity existed to delete. False on a retry. */
  authIdentityDeleted: boolean;
};

@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseClientService,
    private readonly storage: UserStorageService,
    private readonly github: GithubConnectionService,
    private readonly auth: AuthService,
  ) {}

  /**
   * Deletes the authenticated user's account, everywhere.
   *
   * `userId` comes from the verified session and from nowhere else. There
   * is no parameter on this method, this service or the controller above
   * it by which a caller could name a different user - which is the only
   * form in which "you cannot delete somebody else's account" is a
   * property rather than a check somebody might forget.
   */
  async deleteAccount(userId: string): Promise<AccountDeletionResult> {
    /*
     * ---- 1. GitHub -------------------------------------------------
     * Needs the encrypted token, which the cascade at step 3 destroys.
     */
    let githubRevokedAtProvider = false;
    let githubCleanupFailed = false;

    try {
      const result = await this.github.disconnect(userId);

      githubRevokedAtProvider = result.revokedAtProvider;
    } catch {
      /*
       * Caught and reduced to a flag. The error object carries the
       * provider request that produced it, and this is a path that has
       * held an access token - so it is classified and dropped rather
       * than logged or re-thrown.
       */
      githubCleanupFailed = true;
    }

    /*
     * ---- 2. Storage ------------------------------------------------
     * The database rows are read first, because they are the precise
     * index; the sweep inside the storage service is the second source.
     */
    const imports = await this.prisma.resumeImport.findMany({
      where: { userId },
      select: { storagePath: true },
    });

    const storage = await this.storage.deleteAllForUser(
      userId,
      imports.map((row) => row.storagePath),
    );

    if (storage.failed.length > 0) {
      /*
       * Stop. Nothing has been destroyed that the user cannot recover by
       * retrying, and the row that indexes the surviving files is intact.
       * The message names no path - a storage path embeds the user id and
       * their own filename, and this response is not the place for either.
       */
      throw new InternalServerErrorException(
        'Account deletion could not remove all stored files. Nothing was deleted; please try again.',
      );
    }

    /*
     * ---- 3. Database -----------------------------------------------
     * One statement. Everything owned cascades; shared vocabulary does not.
     */
    const deleted = await this.prisma.user.deleteMany({ where: { id: userId } });

    /*
     * ---- 4. Provisioning cache -------------------------------------
     * Before the auth call, so a request arriving in the window between
     * these two steps re-provisions honestly rather than being told by a
     * stale cache entry that a row exists which no longer does.
     */
    this.auth.forgetProvisioning(userId);

    /*
     * ---- 5. The auth identity --------------------------------------
     */
    const authIdentityDeleted = await this.deleteAuthIdentity(userId);

    /*
     * Again, because the guard may have re-provisioned this user on a
     * request that arrived while steps 3 to 5 were running.
     */
    this.auth.forgetProvisioning(userId);

    return {
      storageObjectsDeleted: storage.deleted,
      storageOrphansSwept: storage.orphansSwept,
      databaseRecordDeleted: deleted.count > 0,
      githubRevokedAtProvider,
      githubCleanupFailed,
      authIdentityDeleted,
    };
  }

  /**
   * Removes the Supabase identity, using the service-role client.
   *
   * That key lives only on the server, is never sent to a client and is
   * never logged - the client that holds it is constructed once from
   * configuration and shared.
   *
   * An identity that is already gone counts as deleted: on a retry, the
   * first attempt having succeeded here is the expected state, and
   * treating it as a failure would make the endpoint permanently unable
   * to report completion.
   */
  private async deleteAuthIdentity(userId: string): Promise<boolean> {
    const { error } = await this.supabase.client.auth.admin.deleteUser(userId);

    if (!error) {
      return true;
    }

    if (this.isAlreadyGone(error)) {
      return true;
    }

    /*
     * The data is gone and the login is not. Reported as a failure so
     * that nothing upstream tells the user their account is deleted -
     * the provider's own message is deliberately not included.
     */
    throw new InternalServerErrorException(
      'Account data was removed but the sign-in identity could not be deleted. Please try again.',
    );
  }

  private isAlreadyGone(error: { status?: number; message?: string }): boolean {
    if (error.status === 404) {
      return true;
    }

    const message = error.message?.toLowerCase() ?? '';

    return message.includes('not found') || message.includes('user_not_found');
  }
}
