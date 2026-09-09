import { describe, expect, it, vi } from 'vitest';

import { UserStorageService } from './user-storage.service.js';
import type { SupabaseClientService } from '../auth/supabase.client.js';

/*
 * Deleting a user's files, and provably nobody else's.
 *
 * The dangerous mistake in this file's subject matter is not failing to
 * delete - it is deleting too much. A prefix built from the wrong value,
 * or a path taken on trust from a caller, removes another person's resume
 * and there is no undo. So most of what is asserted here is about what
 * does NOT get removed.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function makeService(
  listing: Record<string, string[]> = {},
  options: { removeFails?: boolean; listFails?: boolean } = {},
) {
  const removed: string[][] = [];

  const list = vi.fn(async (path: string) =>
    options.listFails
      ? { data: null, error: { message: 'listing unavailable' } }
      : {
          data: (listing[path] ?? []).map((name) => ({ name })),
          error: null,
        },
  );

  const remove = vi.fn(async (paths: string[]) => {
    removed.push(paths);

    return options.removeFails
      ? { data: null, error: { message: 'storage unavailable' } }
      : { data: paths.map((p) => ({ name: p })), error: null };
  });

  const supabase = {
    client: { storage: { from: () => ({ list, remove }) } },
  } as unknown as SupabaseClientService;

  return {
    service: new UserStorageService(supabase),
    removed,
    /*
     * A function, not a getter. Destructuring a getter evaluates it once
     * at destructuring time, which would capture an empty array before any
     * deletion had happened - a test helper that always reports "nothing
     * was removed" and therefore passes whatever the code does.
     */
    allRemoved: () => removed.flat(),
  };
}

describe('the prefix rule', () => {
  it('claims a path under the user prefix', () => {
    expect(
      UserStorageService.belongsTo(USER, `${USER}/import-1/resume.pdf`),
    ).toBe(true);
  });

  it('refuses another user path', () => {
    expect(
      UserStorageService.belongsTo(USER, `${OTHER}/import-1/resume.pdf`),
    ).toBe(false);
  });

  /*
   * The off-by-one that a bare startsWith would let through. With ids like
   * "user-1" and "user-10", a prefix without the separator matches the
   * wrong person. Uuids make this unlikely rather than impossible, and
   * "unlikely" is not the standard for deleting somebody's resume.
   */
  it('does not match a user id that merely starts the same', () => {
    expect(UserStorageService.belongsTo('user-1', 'user-10/x/y.pdf')).toBe(
      false,
    );
    expect(UserStorageService.belongsTo('user-1', 'user-1/x/y.pdf')).toBe(true);
  });

  it.each([
    ['a bare filename', 'resume.pdf'],
    ['an absolute-looking path', `/${USER}/import/resume.pdf`],
    ['a traversal', `${OTHER}/../${USER}/resume.pdf`],
    ['an empty path', ''],
  ])('refuses %s', (_label, path) => {
    expect(UserStorageService.belongsTo(USER, path)).toBe(false);
  });
});

describe('deleting everything a user owns', () => {
  it('removes the paths the database knew about', async () => {
    const { service, allRemoved } = makeService();

    const result = await service.deleteAllForUser(USER, [
      `${USER}/a/one.pdf`,
      `${USER}/b/two.pdf`,
    ]);

    expect(result.deleted).toBe(2);
    expect(result.failed).toEqual([]);
    expect(allRemoved().sort()).toEqual([`${USER}/a/one.pdf`, `${USER}/b/two.pdf`]);
  });

  /*
   * THE test in this file. A caller passing another user's path - by bug,
   * by a poisoned row, by anything - must not cause that file to be
   * deleted, however it got here.
   */
  it('silently drops a path belonging to somebody else', async () => {
    const { service, allRemoved } = makeService();

    await service.deleteAllForUser(USER, [
      `${USER}/a/mine.pdf`,
      `${OTHER}/a/theirs.pdf`,
    ]);

    expect(allRemoved()).toEqual([`${USER}/a/mine.pdf`]);
    expect(allRemoved().join(' ')).not.toContain(OTHER);
  });

  /*
   * The sweep exists because the database is not a complete index of the
   * bucket: an upload that landed after its row was deleted leaves an
   * object nothing points at, and it would otherwise survive account
   * deletion forever.
   */
  it('sweeps objects the database did not know about', async () => {
    const { service, allRemoved } = makeService({
      [USER]: ['import-a', 'import-b'],
      [`${USER}/import-a`]: ['known.pdf'],
      [`${USER}/import-b`]: ['orphan.pdf'],
    });

    const result = await service.deleteAllForUser(USER, [
      `${USER}/import-a/known.pdf`,
    ]);

    expect(allRemoved().sort()).toEqual([
      `${USER}/import-a/known.pdf`,
      `${USER}/import-b/orphan.pdf`,
    ]);
    expect(result.orphansSwept).toBe(1);
  });

  it('sweeps only the user own prefix', async () => {
    const { service, allRemoved } = makeService({
      [USER]: ['import-a'],
      [`${USER}/import-a`]: ['mine.pdf'],
      [OTHER]: ['import-z'],
      [`${OTHER}/import-z`]: ['theirs.pdf'],
    });

    await service.deleteAllForUser(USER);

    expect(allRemoved()).toEqual([`${USER}/import-a/mine.pdf`]);
  });

  it('does not delete the same object twice', async () => {
    const { service, allRemoved } = makeService({
      [USER]: ['import-a'],
      [`${USER}/import-a`]: ['one.pdf'],
    });

    await service.deleteAllForUser(USER, [`${USER}/import-a/one.pdf`]);

    expect(allRemoved()).toEqual([`${USER}/import-a/one.pdf`]);
  });

  /*
   * Reported, not thrown, and this is what the account deletion above it
   * depends on: it must be able to stop BEFORE destroying the rows that
   * index these files.
   */
  it('reports failures instead of pretending they deleted', async () => {
    const { service } = makeService({}, { removeFails: true });

    const result = await service.deleteAllForUser(USER, [`${USER}/a/one.pdf`]);

    expect(result.deleted).toBe(0);
    expect(result.failed).toEqual([`${USER}/a/one.pdf`]);
  });

  /*
   * A listing failure degrades to "delete what the database knew", which
   * is safe in this direction - the sweep is an addition to the precise
   * list, never a replacement for it.
   */
  it('still deletes known paths when the listing fails', async () => {
    const { service, allRemoved } = makeService({}, { listFails: true });

    const result = await service.deleteAllForUser(USER, [`${USER}/a/one.pdf`]);

    expect(allRemoved()).toEqual([`${USER}/a/one.pdf`]);
    expect(result.failed).toEqual([]);
  });

  it('is a no-op for a user with nothing stored', async () => {
    const { service, allRemoved } = makeService();

    const result = await service.deleteAllForUser(USER, []);

    expect(result.deleted).toBe(0);
    expect(result.failed).toEqual([]);
    expect(allRemoved()).toEqual([]);
  });
});

describe('deleting one object', () => {
  it('removes a path the user owns', async () => {
    const { service, allRemoved } = makeService();

    await expect(
      service.deleteObject(USER, `${USER}/a/one.pdf`),
    ).resolves.toBe(true);

    expect(allRemoved()).toEqual([`${USER}/a/one.pdf`]);
  });

  /*
   * Throws rather than returning false. Reaching this method with another
   * user's path means a caller constructed it wrongly, and that is worth
   * failing loudly over rather than absorbing into a boolean somebody
   * might ignore.
   */
  it('refuses a path outside the user prefix, loudly', async () => {
    const { service, allRemoved } = makeService();

    await expect(
      service.deleteObject(USER, `${OTHER}/a/theirs.pdf`),
    ).rejects.toThrow(/outside the user prefix/i);

    expect(allRemoved()).toEqual([]);
  });

  it('reports a storage failure rather than claiming success', async () => {
    const { service } = makeService({}, { removeFails: true });

    await expect(
      service.deleteObject(USER, `${USER}/a/one.pdf`),
    ).resolves.toBe(false);
  });
});
