# Backup and recovery

What is actually configured, what was actually tested, and what is not
covered. Written in PR-5 against the **development** environment, because
that is the only environment that exists — production and staging are
PR-6's to create.

Nothing in this document is inferred from a vendor's marketing page. Every
claim below is either something a command returned, or is explicitly
labelled as unverified.

---

## What was verified

### The database server is archiving WAL, continuously

Read from the hosted development project on 2026-09-09:

```
wal_level        = logical
archive_mode     = on
max_wal_senders  = 5
server_version   = 17.6

pg_stat_archiver: archived_count=279, last_archived=2026-09-09 11:05:07Z, failed_count=0
```

`archive_mode = on` is the *precondition* for point-in-time recovery, and a
non-zero `archived_count` with zero failures shows archiving is genuinely
running rather than merely enabled.

**This does not prove PITR is available to us.** On Supabase, whether those
archives can be replayed to an arbitrary instant — and how far back — is a
plan-level feature configured outside the database, and the `postgres` role
we hold cannot read that configuration. See *Not verified* below.

### A full logical backup restores completely

Performed against the local development database, which holds the Market
Graph corpus:

```
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" -f drill.dump
createdb career_os_restore_drill
pg_restore --no-owner --no-privileges --dbname="$RESTORE_URL" drill.dump
```

Dump size 210 MB, dump 19s, restore 25s.

Every count matched exactly, original against restored:

| | original | restored |
|---|---|---|
| MarketPostingVersion | 76,968 | 76,968 |
| MarketPosting | 76,965 | 76,965 |
| MarketPostingSighting | 86,041 | 86,041 |
| MarketPostingNormalization | 387,795 | 387,795 |
| MarketPostingSearchDocument | 76,965 | 76,965 |
| MarketSource | 13 | 13 |
| foreign keys | 65 | 65 |
| CHECK constraints | 7 | 7 |
| indexes | 146 | 146 |
| applied migrations | 11 | 11 |

The CHECK-constraint count matters more than it looks: Phase 11's
`isEnabled = false OR accessState = 'ENABLED'` is one of those seven, so a
restore that dropped constraints would silently restore a database in which
a rejected market source could be enabled.

### The application runs against restored data

The API was booted against the restored database and served real rows:

```
GET /v1/health/live   -> 200 {"status":"ok","service":"career-os-api"}
GET /v1/health/ready  -> 200 {"status":"ok","checks":{"database":"ok"}}
```

Reading through Prisma returned real postings, and the source access states
survived intact — `ashby` still `BLOCKED_EXTERNAL_ACCESS` with
`isEnabled: false`, so Phase 11's fail-closed position is preserved across
a restore rather than reset to a permissive default.

The drill database was dropped afterwards. The development database was
never written to.

---

## What is NOT covered

### Resume files are not in the database

This is the most important line in this document, and it is demonstrated
rather than assumed.

`storage.objects` in the hosted project holds **only metadata**: id,
bucket, name, owner, timestamps, and two jsonb columns. A query for
`bytea` or `oid` columns across the entire `storage` schema returns **0**.

The file bytes live in object storage, not in Postgres. Therefore:

> A database backup — logical dump or PITR — restores the **index** of
> every resume and **none of the files**.

Restoring the database alone produces a system that believes eight resumes
exist, hands out signed URLs for them, and 404s on every one. There were 8
objects in the `resumes` bucket at the time of writing.

**PR-6 must establish a storage backup.** Until it does, resume files have
no recovery path beyond whatever the storage provider retains by default,
which we have not verified.

### Not verified

| Item | Why not |
|---|---|
| Whether PITR is enabled, and its retention window | Requires the Supabase Management API; we hold a project service-role key, not a management token |
| Daily backup schedule and retention | Same |
| Restore of the *hosted* database | Would require provisioning a second project; PR-6 owns environment creation |
| Storage object recovery | No storage backup exists to restore from |
| RPO / RTO under real failure | Cannot be measured against infrastructure that does not exist yet |

---

## Recovery procedure

For the environment that exists today. PR-6 should revise this once
staging and production are real.

**1. Take a backup**

```sh
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" \
  -f "career-os-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

Custom format, so `pg_restore` can be selective and parallel. `--no-owner`
and `--no-privileges` because roles differ between environments and a dump
that insists on the source's roles will not restore into a new project.

**2. Restore into a NEW database, never over a live one**

```sh
createdb career_os_recovery
pg_restore --no-owner --no-privileges --dbname="$RECOVERY_URL" backup.dump
```

Restoring over a running database is how a recovery becomes an outage.
Restore beside it, verify, then repoint.

**3. Verify before repointing anything**

```sh
psql "$RECOVERY_URL" -tAc "select count(*) from \"MarketPostingVersion\""
psql "$RECOVERY_URL" -tAc "select count(*) from pg_constraint where contype='c'"
psql "$RECOVERY_URL" -tAc "select count(*) from _prisma_migrations"
```

Compare against the source. Counts and constraint totals both, for the
reason given above.

**4. Point the API at it and check readiness**

```sh
DATABASE_URL="$RECOVERY_URL" node dist/main.js
curl -s localhost:3000/v1/health/ready
```

A 200 with `{"checks":{"database":"ok"}}` is the signal that the
application — not just Postgres — accepts the restored data.

**5. Remember the files**

A database restore does not restore resumes. Any real recovery has to
re-establish the storage bucket separately, and until PR-6 provides a
storage backup, those files are gone.

---

## PR-6: what changed

### The database drill was repeated, and passed

Against the local development database on 2026-09-09, after PR-6's changes:

```
pg_dump  --format=custom --no-owner --no-privileges  ->  210 MB in 70s
pg_restore into a NEW database                       ->  35s
```

| | original | restored |
|---|---|---|
| MarketPostingVersion | 76,968 | 76,968 |
| MarketPosting | 76,965 | 76,965 |
| MarketPostingNormalization | 387,795 | 387,795 |
| MarketSource | 13 | 13 |
| foreign keys | 65 | 65 |
| CHECK constraints | 7 | 7 |
| indexes | 146 | 146 |
| applied migrations | 11 | 11 |

And the property that matters more than the row counts: the fail-closed
source states survived unchanged.

```
ashby       BLOCKED_EXTERNAL_ACCESS  isEnabled=false
greenhouse  REJECTED                 isEnabled=false
nav-no      DISABLED                 isEnabled=false
```

A restore that reset those to a permissive default would silently re-enable
a source whose licence position was deliberately refused. It does not.

### Migrations apply to an empty database

Separately verified, because this is how production will be created and it
had never been tested:

```
createdb career_os_pr6_drill && prisma migrate deploy
```

produced a schema identical to development - 45 tables, 21 enums, 65
foreign keys, 7 CHECK constraints, 146 indexes, 11 migrations. This now
runs on every CI run against a real Postgres service container, so it
cannot silently rot.

### Storage backup: RUN, and the restore drill PERFORMED

Executed 2026-09-15 against the live Supabase project. The database was
not touched; this section is entirely about object storage.

**The destination.** A new `resume-backups` bucket, created private, PDF
only, 10 MB - mirroring `resumes` exactly:

```
career-files     public=false  size=none      mime=any
resumes          public=false  size=10485760  mime=application/pdf
resume-backups   public=false  size=10485760  mime=application/pdf
```

**The backup.** `src/operations/storage-backup.cli.ts`, unmodified, first
real execution:

```
run 1:  resumes -> resume-backups: 8 copied, 0 unchanged, 0 failed, 8 total
run 2:  resumes -> resume-backups: 0 copied, 8 unchanged, 0 failed, 8 total
```

Run 2 proves the copy is incremental by content rather than re-uploading
every file on every run. `0 failed` is the load-bearing number: every
object was re-read after writing and compared against a sha256 the tool
computes on both sides, and a mismatch throws rather than warning.

**Fail-closed, demonstrated.** Pointed at a bucket it could not confirm
was private:

```
Backup bucket "does-not-exist" is missing or not private. Refusing to copy.
```

**The restore drill.** A synthetic PDF, never a user's file:

| Step | Result |
|---|---|
| 1. Upload synthetic PDF to `resumes` | present |
| 2. Copy to backup, verify written bytes | sha256 == source |
| 3. **Delete from source** | verified absent |
| 4. Restore from backup | present again, **sha256 == original** |
| 5. Privacy of restored object | unauthenticated fetch -> **400** |
| 6. Cleanup | both buckets clean |

Afterwards: `resumes` 8 files, `resume-backups` 8 files. No real object
was deleted at any point.

**One thing the drill itself taught.** The first run verified deletion
with `download()` and reported the object still present. It was not -
Supabase serves storage through a CDN, which kept answering from cache
for a moment after the delete. `list()` reads the authoritative record.
The drill was re-run with list-based checks, because a deletion check
that races a cache is exactly the check that would report a successful
restore over an object that had never gone away.

### What this protects against, and what it does not

**Protects:** an accidental delete, a bad migration, a bug that removes
the wrong prefix, a user deleting their own file by mistake.

**Does NOT protect:** losing the Supabase project or the account. Source
and backup are two buckets in ONE project - the same blast radius. Real
off-site recovery needs a second destination and is an infrastructure
decision, not a code one.

Stated plainly because "we have backups" is exactly the sentence that
stops people asking where they are.

### RPO and RTO

| | Database | Resume files |
|---|---|---|
| RPO | **Unestablished.** No schedule exists; PITR availability on the production plan is unread. | **Since the last manual run.** The CLI is not scheduled, so today the answer is "whenever somebody last ran it" - currently 2026-09-15. |
| RTO | ~35s restore for a 210 MB dump, plus provisioning and repointing. Under an hour, measured on a laptop against a local database. | **Seconds per file, measured.** A single object restored and byte-verified inside one drill run. A full-bucket restore of 8 files is the same operation repeated. |
| Retention | None configured. | **None configured.** The backup never deletes, so it grows and keeps everything - including objects deleted at source, which is deliberate (a backup that mirrors deletions reproduces the accident). |

The remaining honest gap is scheduling. A backup somebody remembers to
run is not a backup strategy, and until the CLI runs on a schedule the
RPO is a human habit rather than a number.

---

## Still open after PR-6

1. **Schedule the storage backup.** It works and it is not automated. Until
   it runs on a timer the RPO is a human habit.
2. Create the production Supabase project in US East. Everything below
   depends on it.
3. Confirm PITR availability and retention on the production plan with a
   management token, and record the actual numbers.
4. Schedule the database backup too. A `pg_dump` somebody remembers to run
   is not a backup strategy.
5. Give the storage backup a destination outside the project. Today source
   and backup share one account, so they share one blast radius.
6. Decide on `career-files` - private, but with no size or MIME limit and
   no application code referencing it.
