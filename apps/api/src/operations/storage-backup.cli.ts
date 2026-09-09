import { NestFactory } from '@nestjs/core';

import { AuthModule } from '../auth/auth.module.js';
import { SupabaseClientService } from '../auth/supabase.client.js';
import {
  assertFaithfulCopy,
  backupDestinationIsSafe,
  planBackup,
  type BackupRecord,
  type StoredObject,
} from './storage-backup.js';

/*
 * Copies the resume bucket into a private backup bucket, and verifies every
 * byte it writes.
 *
 * WHY THIS EXISTS AT ALL: PR-5 proved that a database backup - logical dump
 * or PITR - restores the index of every resume and none of the files,
 * because `storage.objects` holds metadata only. This is the other half.
 *
 * NOT YET RUN AGAINST REAL DATA. The Career OS Supabase project is not
 * reachable from this machine, so this has never executed against the
 * `resumes` bucket. The rules it enforces - what to copy, what makes a copy
 * faithful, and where a backup may be written - are in storage-backup.ts
 * and are covered by tests that do not need a provider. The network calls
 * below are not. Treat the first run as a test: run it, then restore one
 * object and compare, before believing the word "backup".
 *
 *   pnpm build && node dist/operations/storage-backup.cli.js
 *
 * Environment: STORAGE_BACKUP_BUCKET names the destination. The source is
 * the resumes bucket. Both live in the same Supabase project today, which
 * is a REAL limitation and is recorded as such in
 * docs/operations/backup-and-recovery.md: it survives an accidental delete,
 * and it does not survive losing the project.
 */

const SOURCE_BUCKET = 'resumes';

/* Supabase's list() pages; 100 is its default and the pages are cheap. */
const PAGE_SIZE = 100;

async function listAll(
  storage: ReturnType<SupabaseClientService['client']['storage']['from']>,
  prefix: string,
): Promise<StoredObject[]> {
  const found: StoredObject[] = [];

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await storage.list(prefix, {
      limit: PAGE_SIZE,
      offset,
    });

    if (error) {
      throw new Error('storage_list_failed');
    }

    if (data === null || data.length === 0) {
      return found;
    }

    for (const entry of data) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

      /*
       * Supabase returns folders as entries with no id. Resume paths are
       * `<userId>/<importId>/<filename>`, so the walk is two levels deep
       * and recursion is how every file is reached rather than only the
       * top-level user folders.
       */
      if (entry.id === null) {
        found.push(...(await listAll(storage, path)));
        continue;
      }

      found.push({
        name: path,
        size: Number(entry.metadata?.['size'] ?? 0),
      });
    }

    if (data.length < PAGE_SIZE) {
      return found;
    }
  }
}

async function main(): Promise<void> {
  const destination = process.env.STORAGE_BACKUP_BUCKET;

  if (destination === undefined || destination.trim() === '') {
    console.error('STORAGE_BACKUP_BUCKET must name a private backup bucket.');
    process.exitCode = 1;
    return;
  }

  const app = await NestFactory.createApplicationContext(AuthModule, {
    logger: false,
  });

  try {
    const supabase = app.get(SupabaseClientService).client;

    /*
     * The destination is checked BEFORE a single byte is read, and the
     * check fails closed. Copying every resume in the system into a public
     * bucket is a worse outcome than having no backup, and it cannot be
     * undone by flipping the flag back afterwards.
     */
    const { data: buckets, error: bucketError } =
      await supabase.storage.listBuckets();

    if (bucketError || buckets === null) {
      console.error('Could not read bucket configuration. Refusing to copy.');
      process.exitCode = 1;
      return;
    }

    const target = buckets.find((bucket) => bucket.name === destination);

    if (target === undefined || !backupDestinationIsSafe(target)) {
      console.error(
        `Backup bucket "${destination}" is missing or not private. Refusing to copy.`,
      );
      process.exitCode = 1;
      return;
    }

    const source = supabase.storage.from(SOURCE_BUCKET);
    const backup = supabase.storage.from(destination);

    const objects = await listAll(source, '');
    const existing: BackupRecord[] = (await listAll(backup, '')).map(
      (object) => ({ name: object.name, size: object.size, digest: '' }),
    );

    const plan = planBackup(objects, existing);

    let copied = 0;
    let skipped = 0;
    let failed = 0;

    for (const decision of plan) {
      if (decision.action === 'skip') {
        skipped += 1;
        continue;
      }

      try {
        const { data: downloaded, error: downloadError } = await source.download(
          decision.name,
        );

        if (downloadError || downloaded === null) {
          throw new Error('download_failed');
        }

        const bytes = new Uint8Array(await downloaded.arrayBuffer());

        const { error: uploadError } = await backup.upload(
          decision.name,
          bytes,
          { upsert: true, contentType: 'application/pdf' },
        );

        if (uploadError) {
          throw new Error('upload_failed');
        }

        /*
         * Read back what was written and compare digests. An upload that
         * returns success and stored something else is exactly the failure
         * a backup must not have, and the only way to know is to look.
         */
        const { data: verify, error: verifyError } = await backup.download(
          decision.name,
        );

        if (verifyError || verify === null) {
          throw new Error('verify_failed');
        }

        assertFaithfulCopy(
          decision.name,
          bytes,
          new Uint8Array(await verify.arrayBuffer()),
        );

        copied += 1;
      } catch {
        /*
         * Counted, not printed. A storage path is
         * `<userId>/<importId>/<filename>` and that filename is usually a
         * real person's name - so naming the failing object here would put
         * PII in an operator's terminal and scrollback. The count says
         * whether the backup is complete, which is the operational
         * question; finding the specific object is a follow-up done
         * against the store, not the log.
         */
        failed += 1;
      }
    }

    console.log(
      `resumes -> ${destination}: ${copied} copied, ${skipped} unchanged, ${failed} failed, ${objects.length} total`,
    );

    /* A partial backup must not report success to a scheduler. */
    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

await main();
