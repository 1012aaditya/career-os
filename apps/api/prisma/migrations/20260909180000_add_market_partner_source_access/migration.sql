-- Phase 11: partner / company / ATS coverage.
--
-- WHY A MIGRATION AT ALL. Phase 8's rule, restated by Phase 11 Part S, is
-- to extend the existing source registry rather than build a second one.
-- This migration is that extension and nothing else: five columns on
-- MarketSource, two enums, one CHECK constraint, no new table, and no
-- per-company or per-vendor structure of any kind.
--
-- WHY EACH COLUMN EXISTS.
--
--   category            `kind` already says WHAT a source supplies
--                       (postings or a taxonomy). Nothing said what kind
--                       of RELATIONSHIP produces it, and the difference
--                       between an open-data release and an ATS endpoint
--                       is the whole of Phase 11's legal question: an ATS
--                       vendor does not own the posting text, so an open
--                       ATS endpoint is not a grant the way an open
--                       government release is.
--
--   accessState         `isEnabled` answered "is it on" and nothing
--                       answered "why is it off". Six sources were off
--                       for six different reasons and all six were the
--                       same boolean.
--
--   accessNote          The reason, in prose, INTERNAL. It records
--                       refusals, partnership status and what was asked
--                       of whom, and no read path selects it.
--
--   requiresCredentials Lets source health distinguish "needs no
--                       credential" from "credential missing". A boolean
--                       only: key names live in code, values live in the
--                       environment, and neither belongs in a row.
--
--   attribution         The credit a permission obliges us to display.
--                       The dataset side has carried this since Phase 8
--                       (MarketDatasetVersion.attribution); the posting
--                       side never had it, so the read path was serving
--                       licenceNote - our own internal reasoning - as if
--                       it were a credit line.
--
-- WHY THE CHECK CONSTRAINT. This is the part that is not bookkeeping.
--
-- Before this migration, `isEnabled` was set once by ensureSource's CREATE
-- and never again (its UPDATE block is empty, deliberately, so operator
-- tuning survives a deploy). The consequence was live on this database:
-- the Greenhouse and NAV descriptors both read `isEnabled: false`, and
-- both rows read TRUE, because the rows were written before the
-- descriptors changed their minds. The fail-closed behaviour existed in
-- the code and not in the data, and `sync greenhouse` would have walked a
-- source whose licence position is recorded as unresolved.
--
-- The constraint makes the rule true of the DATA: a source may be enabled
-- only from the ENABLED access state. An operator flipping isEnabled by
-- hand - which is a documented, supported thing to do - now cannot enable
-- a source that has not cleared access. The backfill below repairs the two
-- rows that were already wrong.
--
-- PRESERVING EXISTING DATA. Every backfill below is stated per source with
-- its reason. No posting, version, sighting, normalization or signal row
-- is read or written by this migration.

-- CreateEnum
CREATE TYPE "MarketSourceCategory" AS ENUM ('PUBLIC_OPEN_DATA', 'DIRECT_EMPLOYER', 'ATS', 'LICENSED_AGGREGATOR', 'PARTNER_FEED');

-- CreateEnum
CREATE TYPE "MarketSourceAccessState" AS ENUM ('DISCOVERED', 'ACCESS_REQUESTED', 'ACCESS_GRANTED', 'CREDENTIALS_REQUIRED', 'CREDENTIALS_CONFIGURED', 'LEGAL_REVIEW', 'BLOCKED_EXTERNAL_ACCESS', 'ENABLED', 'DISABLED', 'REJECTED', 'EXPIRED');

-- AlterTable: added nullable, backfilled, then made NOT NULL, so an
-- existing row never has to guess its own category.
ALTER TABLE "MarketSource"
  ADD COLUMN "category" "MarketSourceCategory",
  ADD COLUMN "accessState" "MarketSourceAccessState" NOT NULL DEFAULT 'DISCOVERED',
  ADD COLUMN "accessNote" TEXT,
  ADD COLUMN "accessReviewedAt" TIMESTAMP(3),
  ADD COLUMN "requiresCredentials" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "attribution" TEXT;

-- Backfill: category.
--
-- The default for anything not named below is PUBLIC_OPEN_DATA, which is
-- true of every source in this database except the two named: all of them
-- are government or public-body releases under a stated open licence.
UPDATE "MarketSource" SET "category" = 'PUBLIC_OPEN_DATA';

-- An applicant tracking system. The endpoint is open and the CONTENT is
-- the employer's, which is exactly the distinction the column was added
-- for.
UPDATE "MarketSource" SET "category" = 'ATS' WHERE "slug" = 'greenhouse';

-- Jobicy grants reuse by published syndication terms - a grant made to
-- reusers rather than to the world, and withdrawable. That is
-- LICENSED_AGGREGATOR rather than PUBLIC_OPEN_DATA, and the difference is
-- that this one can stop being true.
UPDATE "MarketSource" SET "category" = 'LICENSED_AGGREGATOR' WHERE "slug" = 'jobicy';

ALTER TABLE "MarketSource" ALTER COLUMN "category" SET NOT NULL;

-- Backfill: accessState.
--
-- ENABLED for every source that was actually being used, which is every
-- row whose licence basis is an affirmative grant and which was not
-- deliberately switched off.
UPDATE "MarketSource" SET "accessState" = 'ENABLED' WHERE "isEnabled" = true;

-- Greenhouse: assessed and refused. No terms of any kind govern the public
-- Job Board API in either direction, and the ATS vendor does not own the
-- posting text it serves. REJECTED is a recorded decision so the question
-- is not reopened by whoever next notices that the endpoint answers.
UPDATE "MarketSource"
   SET "accessState" = 'REJECTED',
       "isEnabled" = false,
       "accessNote" = 'Assessed 2026-09-08 and refused. No terms of service govern the public Job Board API in either direction, and the posting text is the EMPLOYER''s rather than the ATS vendor''s - so vendor access would not be a copyright licence even if it were offered. Not to be re-enabled without an employer-side or partner-side grant.'
 WHERE "slug" = 'greenhouse';

-- NAV: the access position is one of the best available - the terms name
-- statistical use explicitly - and the blocker is ours. The feed is
-- append-only from 2019 and requires a cursor persisted across runs, which
-- the ingestion model does not have. DISABLED, not REJECTED: nothing about
-- the source was refused.
UPDATE "MarketSource"
   SET "accessState" = 'DISABLED',
       "isEnabled" = false,
       "accessNote" = 'Access granted and unused. NAV''s terms permit statistical use by name; the blocker is our own ingestion model, which starts every run from a null cursor and so re-reads an append-only feed from 2019. Re-enable when cursor persistence exists, not before.'
 WHERE "slug" = 'nav-no';

-- Backfill: attribution.
--
-- Verbatim credit lines, taken from each licence. Sources whose licence
-- requires no attribution (CC0) are left null rather than given a
-- courtesy credit, because the column records an OBLIGATION.
UPDATE "MarketSource" SET "attribution" = 'Contains public sector information licensed under the Open Government Licence v3.0.' WHERE "slug" = 'teaching-vacancies';
UPDATE "MarketSource" SET "attribution" = 'Contains information licensed under the Open Government Licence - Canada.' WHERE "slug" IN ('canada-job-bank', 'noc');
UPDATE "MarketSource" SET "attribution" = 'Source: USAJOBS, U.S. Office of Personnel Management.' WHERE "slug" = 'usajobs-historic';
UPDATE "MarketSource" SET "attribution" = 'Job listings provided by Jobicy.' WHERE "slug" = 'jobicy';
UPDATE "MarketSource" SET "attribution" = 'Data from NAV (Arbeidsplassen), Norway.' WHERE "slug" = 'nav-no';

-- Fail closed, in the data rather than only in the code.
--
-- Written as NOT VALID then VALIDATE so the table is not held under an
-- exclusive lock while every row is checked. The backfill above already
-- repaired the only two rows that violated it, so the validation is
-- expected to pass immediately - it is separated for the lock, not
-- because a failure is anticipated.
ALTER TABLE "MarketSource"
  ADD CONSTRAINT "MarketSource_enabled_requires_access"
  CHECK ("isEnabled" = false OR "accessState" = 'ENABLED') NOT VALID;

ALTER TABLE "MarketSource" VALIDATE CONSTRAINT "MarketSource_enabled_requires_access";
