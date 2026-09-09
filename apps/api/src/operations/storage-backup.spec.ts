import { describe, expect, it } from 'vitest';

import {
  BackupIntegrityError,
  assertFaithfulCopy,
  backupDestinationIsSafe,
  digestOf,
  planBackup,
} from './storage-backup.js';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('deciding what to copy', () => {
  it('copies an object it has never seen', () => {
    const plan = planBackup([{ name: 'u/1/cv.pdf', size: 100 }], []);

    expect(plan).toEqual([
      { action: 'copy', name: 'u/1/cv.pdf', reason: 'new' },
    ]);
  });

  it('skips an object already backed up unchanged', () => {
    const plan = planBackup(
      [{ name: 'u/1/cv.pdf', size: 100 }],
      [{ name: 'u/1/cv.pdf', size: 100, digest: 'abc' }],
    );

    expect(plan).toEqual([
      { action: 'skip', name: 'u/1/cv.pdf', reason: 'unchanged' },
    ]);
  });

  it('re-copies an object whose size changed', () => {
    const plan = planBackup(
      [{ name: 'u/1/cv.pdf', size: 250 }],
      [{ name: 'u/1/cv.pdf', size: 100, digest: 'abc' }],
    );

    expect(plan).toEqual([
      { action: 'copy', name: 'u/1/cv.pdf', reason: 'changed' },
    ]);
  });

  /*
   * The property that makes this a backup rather than a mirror. An object
   * deleted at the source - by a user, or by the accident being protected
   * against - must not be proposed for removal from the backup.
   */
  it('never proposes deleting a backup whose source is gone', () => {
    const plan = planBackup(
      [],
      [{ name: 'u/1/deleted.pdf', size: 100, digest: 'abc' }],
    );

    expect(plan).toEqual([]);
    expect(plan.some((d) => d.action !== 'copy' && d.action !== 'skip')).toBe(
      false,
    );
  });
});

describe('proving a copy is faithful', () => {
  it('returns the digest when the bytes match', () => {
    const source = bytes('%PDF-1.4 resume');

    expect(assertFaithfulCopy('u/1/cv.pdf', source, bytes('%PDF-1.4 resume'))).toBe(
      digestOf(source),
    );
  });

  it('refuses a copy that differs by a single byte', () => {
    expect(() =>
      assertFaithfulCopy('u/1/cv.pdf', bytes('%PDF-1.4 resume'), bytes('%PDF-1.4 resumf')),
    ).toThrow(BackupIntegrityError);
  });

  it('refuses a truncated copy', () => {
    expect(() =>
      assertFaithfulCopy('u/1/cv.pdf', bytes('%PDF-1.4 resume'), bytes('%PDF-1.4')),
    ).toThrow(BackupIntegrityError);
  });

  /*
   * The error names the object so an operator can find it, and says nothing
   * about its contents. A storage path here is `<userId>/<importId>/<name>`
   * and the name is usually a real person's.
   */
  it('carries no file content in the message', () => {
    try {
      assertFaithfulCopy('u/1/Jane Doe CV.pdf', bytes('secret'), bytes('other'));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toBe('backup_integrity_mismatch');
      expect((error as Error).message).not.toContain('secret');
      expect((error as Error).message).not.toContain('Jane');
    }
  });
});

describe('where a backup may be written', () => {
  it('accepts a bucket that is explicitly private', () => {
    expect(backupDestinationIsSafe({ public: false })).toBe(true);
  });

  it('refuses a public bucket', () => {
    expect(backupDestinationIsSafe({ public: true })).toBe(false);
  });

  /*
   * Fails closed on every shape that is not an explicit `false`. A backup
   * of every resume in the system is one URL away from being the whole
   * corpus, and publishing it cannot be undone by changing the flag back.
   */
  it('refuses when the flag is missing, null or undefined', () => {
    expect(backupDestinationIsSafe({})).toBe(false);
    expect(backupDestinationIsSafe({ public: null })).toBe(false);
    expect(backupDestinationIsSafe({ public: undefined })).toBe(false);
  });
});
