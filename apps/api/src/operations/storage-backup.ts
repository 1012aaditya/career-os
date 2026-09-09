import { createHash } from 'node:crypto';

/*
 * Backing up the resume files, which the database backup provably does not
 * contain.
 *
 * PR-5 established this by inspection rather than assumption: `storage.objects`
 * in the hosted project holds id, bucket, name, owner, timestamps and two
 * jsonb columns, and a query for `bytea` or `oid` columns across the whole
 * storage schema returns ZERO. The bytes are in object storage. So a
 * database restore - logical dump or PITR - brings back the INDEX of every
 * resume and NONE of the files: a system that believes eight resumes exist,
 * hands out signed URLs for them, and 404s on every one.
 *
 * This module is the part of the fix that can be reasoned about without a
 * network: what to copy, how to know a copy is faithful, and when to refuse.
 * The Supabase calls live in storage-backup.cli.ts, so the rules below can
 * be tested without a storage provider - which matters, because the rules
 * are the part that has to be right.
 */

/** An object as the storage provider describes it. */
export type StoredObject = {
  /** Path within the bucket. For resumes this begins with the user's id. */
  name: string;
  size: number;
  /** Provider-supplied, and NOT trusted as an integrity check - see below. */
  etag?: string | undefined;
};

/** What a previous run recorded about an object it copied. */
export type BackupRecord = {
  name: string;
  size: number;
  /** sha256 of the bytes actually written. */
  digest: string;
};

export type CopyDecision =
  | { action: 'copy'; name: string; reason: 'new' | 'changed' }
  | { action: 'skip'; name: string; reason: 'unchanged' };

/**
 * The digest that decides whether a backup is faithful.
 *
 * sha256 of the bytes, computed by US on both sides, rather than the
 * provider's ETag. An ETag is whatever the provider decided to put there -
 * for multipart uploads S3-compatible stores return a hash OF HASHES, which
 * differs between two byte-identical objects uploaded differently. Trusting
 * it would produce a backup that silently disagrees with its source, and the
 * disagreement would only surface during a restore, which is the worst
 * possible moment to discover it.
 */
export function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * What this run should copy.
 *
 * Incremental by content, not by timestamp. A modification time is metadata
 * the provider maintains and a restore does not necessarily preserve;
 * comparing digests compares the only thing that actually matters.
 *
 * Note what is NOT here: nothing is ever deleted from the backup because it
 * vanished from the source. A backup that mirrors deletions is not a backup
 * - it faithfully reproduces the accident you needed it to protect you
 * from. Retention is a separate, deliberate decision (see
 * docs/operations/backup-and-recovery.md), never a side effect of a sync.
 */
export function planBackup(
  source: readonly StoredObject[],
  existing: readonly BackupRecord[],
): CopyDecision[] {
  const byName = new Map(existing.map((record) => [record.name, record]));

  return source.map((object) => {
    const record = byName.get(object.name);

    if (record === undefined) {
      return { action: 'copy', name: object.name, reason: 'new' };
    }

    /*
     * Size is a cheap proxy that catches a truncated or replaced object
     * without downloading it. A same-size different-content edit is not
     * caught here - it is caught by the digest comparison after the copy,
     * which is the check that cannot be fooled.
     */
    if (record.size !== object.size) {
      return { action: 'copy', name: object.name, reason: 'changed' };
    }

    return { action: 'skip', name: object.name, reason: 'unchanged' };
  });
}

export class BackupIntegrityError extends Error {
  constructor(readonly objectName: string) {
    /*
     * The name of the object, and nothing about its contents. A resume's
     * storage path is `<userId>/<importId>/<filename>` and the filename is
     * usually the person's real name - so this message is already at the
     * limit of what may be written down, and the CLI logs the failure
     * count rather than this string.
     */
    super('backup_integrity_mismatch');
    this.name = 'BackupIntegrityError';
  }
}

/**
 * Confirms a copy is byte-identical, or refuses.
 *
 * Throws rather than returning false because there is no sensible way to
 * continue: a backup containing an object that does not match its source is
 * worse than one missing it outright. A missing object is a known gap; a
 * silently wrong one is a restore that succeeds and returns the wrong file.
 */
export function assertFaithfulCopy(
  objectName: string,
  source: Uint8Array,
  written: Uint8Array,
): string {
  const sourceDigest = digestOf(source);

  if (sourceDigest !== digestOf(written)) {
    throw new BackupIntegrityError(objectName);
  }

  return sourceDigest;
}

/**
 * Whether it is safe to write backups into this bucket.
 *
 * THE REQUIREMENT THIS ENFORCES: "backups must not become publicly
 * accessible". A backup of every resume in the system is strictly more
 * sensitive than any single one of them - it is one URL away from being the
 * whole corpus - so a public backup bucket is a worse breach than no backup
 * at all.
 *
 * Fails CLOSED. An unknown or absent privacy flag is treated as unsafe,
 * because the failure mode of guessing wrong in the permissive direction is
 * unrecoverable: once the objects are copied to a public bucket, they have
 * been published, and making the bucket private afterwards does not unpublish
 * them.
 */
export function backupDestinationIsSafe(bucket: {
  public?: boolean | null;
}): boolean {
  return bucket.public === false;
}
