import { apiRequest } from './client';

/*
 * The account lifecycle endpoints.
 *
 * There is exactly one, and its shape is the security control: the server
 * derives the account to delete from the authenticated session, so there
 * is no id to pass and no way for this client to name anybody else. That
 * is worth stating here as well as on the server, because the obvious
 * "improvement" to this file would be to add a userId parameter.
 */

/**
 * What the server reports after deleting an account.
 *
 * Deliberately more than a bare success. `githubRevokedAtProvider` is the
 * one fact the user cannot discover for themselves: if the grant could not
 * be revoked at GitHub, they should be told to revoke it there.
 */
export type AccountDeletionResult = {
  storageObjectsDeleted: number;
  storageOrphansSwept: number;
  databaseRecordDeleted: boolean;
  githubRevokedAtProvider: boolean;
  githubCleanupFailed: boolean;
  authIdentityDeleted: boolean;
};

/**
 * Deletes the signed-in user's account.
 *
 * Not retried automatically anywhere - see request-policy.ts. The server
 * deletes the auth identity LAST and reports an error if that fails, so a
 * rejection here means the caller must NOT treat the account as gone.
 */
export async function deleteAccount(): Promise<AccountDeletionResult> {
  return apiRequest<AccountDeletionResult>('/account', {
    method: 'DELETE',
  });
}
