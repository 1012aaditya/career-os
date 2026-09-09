import { InternalServerErrorException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { AccountService } from './account.service.js';
import { UserStorageService } from './user-storage.service.js';
import type { AuthService } from '../auth/auth.service.js';
import type { SupabaseClientService } from '../auth/supabase.client.js';
import type { GithubConnectionService } from '../integrations/github/github-connection.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/*
 * Account deletion.
 *
 * Three systems hold this user's data and none can be enrolled in one
 * transaction, so there is no atomic delete to test. What there is instead
 * is an ORDER, chosen so that every partial failure leaves the user able
 * to finish the job - and the order is what these tests assert.
 *
 * The two properties worth stating up front, because most of the file
 * exists to defend them:
 *
 *   Storage is emptied BEFORE the database, and a storage failure stops
 *   everything. The database is the index of what to delete; destroying it
 *   while files remain leaves objects nothing points at.
 *
 *   The auth identity goes LAST. While it exists the user can still sign
 *   in, which means they can still retry. Deleting it first would strand
 *   anyone whose storage step failed - locked out, data intact.
 */

const USER = '11111111-1111-4111-8111-111111111111';

function makeService(
  options: {
    imports?: { storagePath: string }[];
    storageFails?: boolean;
    githubThrows?: boolean;
    revokedAtProvider?: boolean;
    authError?: { status?: number; message?: string } | null;
    userRows?: number;
  } = {},
) {
  const calls: string[] = [];

  const prisma = {
    resumeImport: {
      findMany: vi.fn(async () => {
        calls.push('read-imports');
        return options.imports ?? [{ storagePath: `${USER}/a/one.pdf` }];
      }),
    },
    user: {
      deleteMany: vi.fn(async () => {
        calls.push('delete-user');
        return { count: options.userRows ?? 1 };
      }),
    },
  } as unknown as PrismaService;

  const deleteUser = vi.fn(async () => {
    calls.push('delete-auth');
    return { data: null, error: options.authError ?? null };
  });

  const supabase = {
    client: { auth: { admin: { deleteUser } } },
  } as unknown as SupabaseClientService;

  const storage = {
    deleteAllForUser: vi.fn(async () => {
      calls.push('delete-storage');
      return options.storageFails
        ? { deleted: 0, failed: [`${USER}/a/one.pdf`], orphansSwept: 0 }
        : { deleted: 2, failed: [], orphansSwept: 1 };
    }),
  } as unknown as UserStorageService;

  const github = {
    disconnect: vi.fn(async () => {
      calls.push('github');
      if (options.githubThrows) {
        throw new Error('github unreachable');
      }
      return {
        disconnected: true,
        revokedAtProvider: options.revokedAtProvider ?? true,
      };
    }),
  } as unknown as GithubConnectionService;

  const forgetProvisioning = vi.fn(() => {
    calls.push('forget');
  });

  const auth = { forgetProvisioning } as unknown as AuthService;

  return {
    service: new AccountService(prisma, supabase, storage, github, auth),
    calls,
    storage,
    github,
    forgetProvisioning,
    deleteUser,
    prisma,
  };
}

describe('the happy path', () => {
  it('deletes github, then storage, then the database, then the identity', async () => {
    const { service, calls } = makeService();

    await service.deleteAccount(USER);

    /*
     * The whole design, as a sequence. Reordering any of these is a
     * change to the failure model, and it should be a failing test rather
     * than something noticed in an incident.
     */
    expect(calls).toEqual([
      'github',
      'read-imports',
      'delete-storage',
      'delete-user',
      'forget',
      'delete-auth',
      'forget',
    ]);
  });

  it('reports what happened rather than a bare success', async () => {
    const { service } = makeService();

    await expect(service.deleteAccount(USER)).resolves.toEqual({
      storageObjectsDeleted: 2,
      storageOrphansSwept: 1,
      databaseRecordDeleted: true,
      githubRevokedAtProvider: true,
      githubCleanupFailed: false,
      authIdentityDeleted: true,
    });
  });

  it('gives storage the paths the database knew about', async () => {
    const { service, storage } = makeService({
      imports: [{ storagePath: `${USER}/a/one.pdf` }, { storagePath: `${USER}/b/two.pdf` }],
    });

    await service.deleteAccount(USER);

    expect(storage.deleteAllForUser).toHaveBeenCalledWith(USER, [
      `${USER}/a/one.pdf`,
      `${USER}/b/two.pdf`,
    ]);
  });
});

describe('when storage cannot be emptied', () => {
  /*
   * The most important failure in the file. Proceeding would delete the
   * rows that name the surviving files, and would report success over a
   * resume still sitting in a bucket.
   */
  it('stops before touching the database', async () => {
    const { service, calls, prisma } = makeService({ storageFails: true });

    await expect(service.deleteAccount(USER)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );

    expect(calls).not.toContain('delete-user');
    expect(calls).not.toContain('delete-auth');
    expect(prisma.user.deleteMany).not.toHaveBeenCalled();
  });

  it('says nothing was deleted, so the user can retry', async () => {
    const { service } = makeService({ storageFails: true });

    const error = await service
      .deleteAccount(USER)
      .catch((caught: unknown) => caught as Error);

    expect(error.message).toContain('Nothing was deleted');
  });

  /*
   * A storage path embeds the user id and their own filename - very often
   * their real name. It must not travel in an error a client will see.
   */
  it('names no path in the error', async () => {
    const { service } = makeService({ storageFails: true });

    const error = await service
      .deleteAccount(USER)
      .catch((caught: unknown) => caught as Error);

    expect(error.message).not.toContain(USER);
    expect(error.message).not.toContain('.pdf');
  });
});

describe('when GitHub cannot be reached', () => {
  /*
   * Best effort, on purpose. The connection row is destroyed by the
   * cascade regardless, so the local token is gone either way; trapping
   * the user in an undeletable account over a provider being down would
   * be the wrong trade.
   */
  it('continues with the deletion', async () => {
    const { service, calls } = makeService({ githubThrows: true });

    const result = await service.deleteAccount(USER);

    expect(calls).toContain('delete-user');
    expect(calls).toContain('delete-auth');
    expect(result.githubCleanupFailed).toBe(true);
  });

  /* And says so, because the user may need to revoke the grant themselves. */
  it('reports that the grant may still exist at GitHub', async () => {
    const { service } = makeService({ githubThrows: true });

    const result = await service.deleteAccount(USER);

    expect(result.githubRevokedAtProvider).toBe(false);
    expect(result.githubCleanupFailed).toBe(true);
  });

  it('reports honestly when the grant was not revoked at the provider', async () => {
    const { service } = makeService({ revokedAtProvider: false });

    const result = await service.deleteAccount(USER);

    expect(result.githubRevokedAtProvider).toBe(false);
    /* Not a failure - there may simply have been no connection. */
    expect(result.githubCleanupFailed).toBe(false);
  });
});

describe('when the auth identity cannot be deleted', () => {
  /*
   * The one residue this design accepts: data gone, login not. It must
   * surface as an error, because nothing may tell a user their account is
   * deleted while an identity that can sign in still exists.
   */
  it('fails rather than reporting success', async () => {
    const { service } = makeService({
      authError: { status: 500, message: 'auth service unavailable' },
    });

    await expect(service.deleteAccount(USER)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('does not leak the provider message', async () => {
    const { service } = makeService({
      authError: { status: 500, message: 'tenant abc-123 quota exceeded' },
    });

    const error = await service
      .deleteAccount(USER)
      .catch((caught: unknown) => caught as Error);

    expect(error.message).not.toContain('abc-123');
    expect(error.message).toContain('could not be deleted');
  });

  /*
   * An identity that is already gone is the expected state on a retry
   * whose first attempt got that far. Treating it as a failure would make
   * the endpoint permanently unable to report completion.
   */
  it.each([
    [{ status: 404, message: 'not found' }],
    [{ status: 400, message: 'User not found' }],
    [{ message: 'user_not_found' }],
  ])('treats an already-deleted identity as deleted: %j', async (authError) => {
    const { service } = makeService({ authError });

    const result = await service.deleteAccount(USER);

    expect(result.authIdentityDeleted).toBe(true);
  });
});

describe('retrying a deletion', () => {
  /*
   * Every step is a no-op the second time: no connection to disconnect,
   * no objects to remove, no row to delete, an identity already gone.
   */
  it('is safe and reports that nothing was left to remove', async () => {
    const { service } = makeService({
      imports: [],
      userRows: 0,
      authError: { status: 404, message: 'not found' },
    });

    const result = await service.deleteAccount(USER);

    expect(result.databaseRecordDeleted).toBe(false);
    expect(result.authIdentityDeleted).toBe(true);
  });
});

describe('the provisioning cache', () => {
  /*
   * PR-2 added a five-minute cache recording that a user row exists.
   * Leaving an entry behind would mean a request arriving after deletion
   * skips the upsert on the strength of a row that is gone.
   */
  it('is cleared for the deleted user', async () => {
    const { service, forgetProvisioning } = makeService();

    await service.deleteAccount(USER);

    expect(forgetProvisioning).toHaveBeenCalledWith(USER);
  });

  /*
   * Twice, and the second time is the one that matters: the auth guard may
   * have re-provisioned this user on a request that arrived while the
   * deletion was running.
   */
  it('is cleared again after the identity is removed', async () => {
    const { service, forgetProvisioning, calls } = makeService();

    await service.deleteAccount(USER);

    expect(forgetProvisioning).toHaveBeenCalledTimes(2);
    expect(calls.lastIndexOf('forget')).toBeGreaterThan(
      calls.indexOf('delete-auth'),
    );
  });

  it('is not cleared when the deletion aborted at storage', async () => {
    const { service, forgetProvisioning } = makeService({ storageFails: true });

    await service.deleteAccount(USER).catch(() => undefined);

    /* Nothing was deleted, so the cache is still telling the truth. */
    expect(forgetProvisioning).not.toHaveBeenCalled();
  });
});
