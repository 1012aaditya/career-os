-- Evidence Reliability Contract.
--
-- Additive only. No column is dropped, renamed or retyped, the existing
-- @@unique([userId, sourceType, externalId]) is untouched, and no Career
-- Graph table is altered.
--
-- The DDL below is exactly what `prisma migrate diff` produced. The
-- backfill after it is hand-written, because it derives trust properties
-- from facts already stored rather than from anything new.

-- CreateEnum
CREATE TYPE "EvidenceAuthenticity" AS ENUM ('DIRECT_API_OBSERVATION', 'VERIFIED_ARTIFACT', 'USER_PROVIDED_ARTIFACT', 'USER_CLAIM', 'MODEL_INTERPRETATION');

-- CreateEnum
CREATE TYPE "EvidenceAttribution" AS ENUM ('AUTHENTICATED_ACCOUNT', 'VERIFIED_OWNERSHIP', 'EXPLICIT_AUTHORSHIP', 'USER_ASSERTED', 'WEAK_MATCH');

-- CreateEnum
CREATE TYPE "EvidenceCompleteness" AS ENUM ('COMPLETE', 'PARTIAL', 'NOT_SCANNED', 'ACCESS_LOST', 'UNKNOWN');

-- AlterTable
--
-- Every default is the WEAKEST value in its enum, so an existing row - and
-- any future producer that forgets to declare - is classified as an
-- unverified user claim rather than inheriting credibility it never earned.
ALTER TABLE "Evidence" ADD COLUMN     "attribution" "EvidenceAttribution" NOT NULL DEFAULT 'USER_ASSERTED',
ADD COLUMN     "authenticity" "EvidenceAuthenticity" NOT NULL DEFAULT 'USER_CLAIM',
ADD COLUMN     "completeness" "EvidenceCompleteness" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "independenceKey" TEXT,
ADD COLUMN     "lastObservedAt" TIMESTAMP(3),
ADD COLUMN     "transformVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Evidence_userId_independenceKey_idx" ON "Evidence"("userId", "independenceKey");

-- ---------------------------------------------------------------------
-- BACKFILL
-- ---------------------------------------------------------------------
--
-- Deterministic, and derived only from columns that already exist. No
-- network call, no re-sync, nothing invented: where a fact is absent the
-- column is left NULL, because a guessed provenance is worse than a
-- missing one and this is the exact migration where guessing would be
-- most tempting.
--
-- Defensive against legacy metadata by construction. In Postgres, `->` on
-- a SQL NULL, on a JSON null, or on a scalar all yield NULL rather than
-- raising - so a row whose metadata predates any of this shape, or was
-- written by hand, falls through to the ELSE branches instead of aborting
-- the migration.

-- GitHub evidence.
--
-- authenticity and attribution are not assumptions. Phase 7's
-- observations/attribution.ts attributes an artifact only when GitHub
-- itself resolved it to the authenticated account by numeric id, and
-- explicitly refuses git author email, login, repository ownership and
-- name similarity. Every GITHUB row in this table was written through
-- that path, so DIRECT_API_OBSERVATION and AUTHENTICATED_ACCOUNT are
-- statements of what already happened.
UPDATE "Evidence" SET
  "authenticity" = 'DIRECT_API_OBSERVATION',
  "attribution"  = 'AUTHENTICATED_ACCOUNT',

  -- Phase 7's three-value CommitCompleteness widened into the universal
  -- five. DEFAULT_BRANCH_ONLY becomes PARTIAL because that is precisely
  -- what it means: the repository WAS scanned and the count is a lower
  -- bound, since only the default branch is visible through that endpoint.
  --
  -- Anything unrecognised becomes UNKNOWN, never COMPLETE. An unreadable
  -- completeness record is missing coverage information, and the one
  -- reading it must not be free to assume the most flattering answer.
  "completeness" = (CASE "metadata"->'completeness'->>'commits'
    WHEN 'DEFAULT_BRANCH_ONLY' THEN 'PARTIAL'
    WHEN 'NOT_SCANNED'         THEN 'NOT_SCANNED'
    WHEN 'ACCESS_LOST'         THEN 'ACCESS_LOST'
    ELSE 'UNKNOWN'
  END)::"EvidenceCompleteness",

  -- scannedAt is when the sync that last WROTE this row consulted GitHub
  -- about it, which is the best available answer to "last verified" for
  -- rows written before this column existed. It is a floor, not a
  -- fiction: later syncs that changed nothing wrote nothing, so the true
  -- value may be more recent. Understating freshness is the safe error.
  --
  -- Guarded by an ISO-8601 pattern rather than cast blindly, because a
  -- malformed string would abort the whole migration - and read AT TIME
  -- ZONE 'UTC' so the result does not depend on the session's TimeZone,
  -- which would otherwise make this migration non-deterministic across
  -- machines.
  "lastObservedAt" = (CASE
    WHEN "metadata"->'completeness'->>'scannedAt' ~
         '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$'
    THEN (("metadata"->'completeness'->>'scannedAt')::timestamptz AT TIME ZONE 'UTC')
    ELSE NULL
  END),

  -- One authenticated GitHub account is ONE source, however many
  -- repositories it produced rows for. Keying on the account id is what
  -- stops fourteen repositories reading as fourteen corroborating
  -- sources.
  --
  -- NULL when the account id is absent, rather than the string
  -- 'github:' - a key that is present but meaningless would silently
  -- group unrelated rows together, which is worse than having no key.
  "independenceKey" = (CASE
    WHEN COALESCE("metadata"->'account'->>'accountId', '') <> ''
    THEN 'github:' || ("metadata"->'account'->>'accountId')
    ELSE NULL
  END),

  "transformVersion" = 1
WHERE "sourceType" = 'GITHUB';

-- Resume evidence.
--
-- A resume is a document a person wrote about themselves. That makes it a
-- USER_CLAIM attributed because the user said so - not a weaker judgement
-- of the user, but an accurate description of what the artifact is. It is
-- currently the only evidence the Career Graph consumes, which is exactly
-- why the row must say so out loud.
--
-- completeness is UNKNOWN rather than COMPLETE: nothing about a resume
-- import establishes how much of a career it covers, and COMPLETE would
-- assert that a two-page document is the whole of a working life.
--
-- lastObservedAt is capturedAt because a resume is observed exactly once,
-- at confirmation. It is never re-consulted, so the moment of capture IS
-- the last verification, and it will not advance again.
UPDATE "Evidence" SET
  "authenticity"    = 'USER_CLAIM',
  "attribution"     = 'USER_ASSERTED',
  "completeness"    = 'UNKNOWN',
  "lastObservedAt"  = "capturedAt",
  "independenceKey" = (CASE
    WHEN "resumeImportId" IS NOT NULL
    THEN 'resume:' || "resumeImportId"::text
    ELSE NULL
  END),
  "transformVersion" = 1
WHERE "sourceType" = 'RESUME';

-- Every other sourceType is deliberately left at the column defaults with
-- transformVersion 0.
--
-- There are none today. If one appears, 0 marks it as written before any
-- producer declared its provenance - a finding a test can assert on,
-- rather than a row silently wearing a classification nobody derived.
