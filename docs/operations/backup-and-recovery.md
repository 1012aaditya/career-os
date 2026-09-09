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

### Storage backup: mechanism written, drill NOT performed

`src/operations/storage-backup.ts` and `storage-backup.cli.ts` copy the
`resumes` bucket into a private backup bucket, verifying every object by
re-reading it and comparing a sha256 the tool computes on both sides -
rather than trusting the provider's ETag, which for multipart uploads is a
hash of hashes and differs between byte-identical objects.

Three rules are enforced in code and covered by tests that need no provider:

- **The destination must be explicitly private.** An absent or unknown
  privacy flag is refused. A backup of every resume is one URL away from
  being the whole corpus, and publishing it cannot be undone by changing
  the flag back afterwards.
- **Nothing is ever deleted from the backup** because it vanished from the
  source. A backup that mirrors deletions faithfully reproduces the
  accident it exists to protect against.
- **A mismatched copy is a hard failure**, not a warning. An object that
  does not match its source is worse than a missing one: a missing object
  is a known gap, a wrong one is a restore that succeeds and returns the
  wrong file.

**The live drill has NOT been run.** The Career OS Supabase project is not
reachable from this machine, so this code has never touched the `resumes`
bucket. Do not treat resume files as backed up until the drill below has
actually been performed:

1. Create a private backup bucket in the production project.
2. Run the CLI. Confirm the reported count equals the object count.
3. Copy one test object's bytes out, delete it from the source.
4. Restore it from the backup.
5. Compare sha256 of the restored bytes against the original.
6. Confirm the restored object is not publicly readable.

Use a synthetic object. Do not delete a real user's resume to test a
restore.

### RPO and RTO

| | Database | Resume files |
|---|---|---|
| RPO | **Unestablished.** No schedule exists; PITR availability on the production plan is unread. | **Unbounded** until the backup runs on a schedule. |
| RTO | ~35s restore for a 210 MB dump, plus provisioning and repointing. Call it under an hour, measured on a laptop against a local database. | Unmeasured. |

These are honest gaps, not estimates dressed up as numbers. Both become
measurable once a production project exists.

---

## Still open after PR-6

1. Create the production Supabase project in US East. Everything below
   depends on it, and it needs an account this machine cannot reach.
2. Confirm PITR availability and retention on the production plan with a
   management token, and record the actual numbers.
3. Run the storage backup drill above, end to end, and record the result.
4. Schedule both backups. A `pg_dump` somebody remembers to run is not a
   backup strategy, and neither is a CLI nobody invokes.
5. Decide on `career-files` - private, but with no size or MIME limit and
   no application code referencing it. Inspect it in a real project before
   constraining or removing it.
6. Put the backup destination somewhere that survives losing the Supabase
   project. Today's design copies bucket-to-bucket within one project: it
   survives an accidental delete, and it does not survive losing the
   account.
