import { Injectable } from '@nestjs/common';

import { SupabaseClientService } from '../auth/supabase.client.js';

/*
 * Removing a user's stored files, and nothing else's.
 *
 * A database cascade does not touch object storage. Deleting the User row
 * removes every record of which files existed and leaves the files
 * themselves sitting in the bucket - which is the exact shape of the
 * privacy failure where a product tells someone their account is gone
 * while their resume is still on disk.
 *
 * THE SCOPING RULE, and it is the whole safety argument of this file:
 * every path this service touches must start with `${userId}/`. That
 * prefix is not a convention we hope holds - it is built by
 * ResumeImportService.create as `userId/importId/safeFileName`, where the
 * filename is sanitised so it cannot contain a separator and therefore
 * cannot climb out. Every path is re-checked against the prefix here
 * anyway, immediately before deletion, because the cost of being wrong is
 * deleting somebody else's resume.
 *
 * There is deliberately no method that deletes a bucket, a prefix that is
 * not a user id, or "everything". The only way to ask this service to
 * remove something is to name a user.
 */

const BUCKET = 'resumes';

/**
 * A ceiling on the sweep, so a malformed listing can never turn into an
 * unbounded walk. A user with more than this many objects is a user whose
 * import caps failed long before; the count is reported rather than
 * silently truncated so that case is visible instead of guessed at.
 */
const MAX_OBJECTS_PER_USER = 1_000;

/** How many paths are handed to storage in one remove() call. */
const REMOVE_BATCH = 100;

export type StorageDeletionResult = {
  /** Objects storage confirmed removed, or that were already absent. */
  deleted: number;
  /**
   * Paths that could not be removed. Non-empty means the caller must NOT
   * proceed to delete the database rows that index them.
   */
  failed: string[];
  /**
   * Objects found by sweeping the user's prefix that no database row
   * pointed at. Not an error - it is what an interrupted upload leaves
   * behind - but worth reporting, because a number that is never zero
   * means something upstream is leaking.
   */
  orphansSwept: number;
};

@Injectable()
export class UserStorageService {
  constructor(private readonly supabase: SupabaseClientService) {}

  /** The prefix that owns every object belonging to one user. */
  static prefixFor(userId: string): string {
    return `${userId}/`;
  }

  /**
   * Whether a path belongs to this user.
   *
   * Exported through the class so the rule can be tested directly rather
   * than inferred from a deletion's side effects.
   */
  static belongsTo(userId: string, path: string): boolean {
    /*
     * A prefix test alone is not enough: `${userId}` is a uuid, but a
     * caller passing "user-1" would match "user-10/..." on a bare
     * startsWith. The trailing separator is what makes the boundary real.
     */
    return path.startsWith(UserStorageService.prefixFor(userId));
  }

  /**
   * Deletes every object belonging to a user.
   *
   * `knownPaths` comes from the database and is precise. The prefix sweep
   * that follows is the second source, and it exists because the database
   * is not a complete index of the bucket: an upload that succeeded after
   * its import row was deleted, or a row lost to an earlier partial
   * failure, leaves an object nothing points at. Using only the database
   * would leave those behind forever, and using only the sweep would rely
   * on a listing call succeeding.
   *
   * Never throws for an object that is already gone. Deletion is retried
   * by users and by operators, and "it was already deleted" is the
   * expected outcome of a retry rather than a failure.
   */
  async deleteAllForUser(
    userId: string,
    knownPaths: readonly string[] = [],
  ): Promise<StorageDeletionResult> {
    const fromDatabase = knownPaths.filter((path) =>
      UserStorageService.belongsTo(userId, path),
    );

    const swept = await this.sweepPrefix(userId);
    const orphans = swept.filter((path) => !fromDatabase.includes(path));

    const paths = [...new Set([...fromDatabase, ...swept])].sort();

    const failed: string[] = [];
    let deleted = 0;

    for (let index = 0; index < paths.length; index += REMOVE_BATCH) {
      const batch = paths.slice(index, index + REMOVE_BATCH);

      /*
       * Re-checked here, at the last possible moment, rather than trusted
       * from the caller. A path that reached this line without the user's
       * prefix would be another user's file.
       */
      const scoped = batch.filter((path) =>
        UserStorageService.belongsTo(userId, path),
      );

      if (scoped.length === 0) {
        continue;
      }

      const { error } = await this.supabase.client.storage
        .from(BUCKET)
        .remove(scoped);

      if (error) {
        failed.push(...scoped);
        continue;
      }

      deleted += scoped.length;
    }

    return { deleted, failed, orphansSwept: orphans.length };
  }

  /**
   * Every object under a user's prefix.
   *
   * Supabase's list() is not recursive and the layout is exactly two
   * levels - `userId/importId/file` - so this walks those two levels and
   * no further. A deeper structure would be a change to the path
   * convention, and this would report the objects it did find rather than
   * silently descending into a shape nobody designed.
   */
  private async sweepPrefix(userId: string): Promise<string[]> {
    const importFolders = await this.list(userId);
    const paths: string[] = [];

    for (const folder of importFolders) {
      if (paths.length >= MAX_OBJECTS_PER_USER) {
        break;
      }

      const files = await this.list(`${userId}/${folder}`);

      for (const file of files) {
        paths.push(`${userId}/${folder}/${file}`);
      }
    }

    return paths.slice(0, MAX_OBJECTS_PER_USER);
  }

  /**
   * One level of names under a path.
   *
   * A listing failure returns an empty array rather than throwing, and
   * that is safe in this direction: the caller still deletes everything
   * the database knew about, and the sweep is an addition to that rather
   * than a replacement for it. Reporting nothing found is never mistaken
   * for success, because the database paths are deleted regardless.
   */
  private async list(path: string): Promise<string[]> {
    const { data, error } = await this.supabase.client.storage
      .from(BUCKET)
      .list(path, { limit: MAX_OBJECTS_PER_USER });

    if (error || !Array.isArray(data)) {
      return [];
    }

    return data
      .map((entry) => entry.name)
      .filter((name): name is string => typeof name === 'string' && name !== '');
  }

  /**
   * Deletes one object, for a single-resume deletion.
   *
   * Refuses a path outside the user's prefix rather than returning false,
   * because reaching this method with somebody else's path means a caller
   * built it wrongly and that is worth failing loudly over.
   */
  async deleteObject(userId: string, path: string): Promise<boolean> {
    if (!UserStorageService.belongsTo(userId, path)) {
      throw new Error('Refusing to delete a path outside the user prefix');
    }

    const { error } = await this.supabase.client.storage
      .from(BUCKET)
      .remove([path]);

    return !error;
  }
}
