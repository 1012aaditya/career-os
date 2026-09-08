-- Phase 8.1 - Market Graph foundation.
--
-- Every statement here is additive. Eleven new enums, fourteen new tables,
-- their indexes, their foreign keys and four CHECK constraints. No
-- existing table is altered, no column is added, changed or dropped, and
-- no existing row is read or rewritten.
--
-- In particular the frozen Career Graph is untouched: User, Profile,
-- Education, Company, Experience, Project, Skill, UserSkill, Achievement,
-- Evidence, Goal, ResumeImport, CareerGraphIngestion and every join
-- between them are exactly as Phase 6.9 left them. So are the Phase 7
-- tables ExternalConnection, OAuthAuthorizationRequest and
-- ExternalSyncRun.
--
-- Every foreign key created below points at another Market* table. There
-- is no relation from the Market Graph into the Career Graph, and none in
-- the other direction. That absence is the boundary between "what
-- employers are advertising" and "what this user should do about it" - the
-- second is Phase 9 - and a test scans this schema to keep it absent.
--
-- Deletion semantics are deliberate. Every foreign key pointing at an
-- ingestion run or a source is RESTRICT, not CASCADE. Under CASCADE, a
-- single DELETE of one run row would remove the posting versions it first
-- saw, cascade to every later sighting of those versions, and leave the
-- postings orphaned and every signal computed from them still rendering
-- with its evidence gone. A run row is about a kilobyte; there is no
-- space argument for ever deleting one, and RESTRICT makes that a fact
-- about the database rather than a hope about operators.
--
-- See docs/market-graph/phase-8-0-decisions.md.

-- CreateEnum
CREATE TYPE "MarketSourceKind" AS ENUM ('JOB_BOARD', 'SKILL_TAXONOMY');

-- CreateEnum
CREATE TYPE "MarketLicenceBasis" AS ENUM ('UNADDRESSED_PUBLIC_ENDPOINT', 'EXPLICIT_GRANT', 'CONTRACTED');

-- CreateEnum
CREATE TYPE "MarketIngestionStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "MarketComputationStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "MarketIdentityBasis" AS ENUM ('SOURCE_ID', 'SOURCE_URL', 'CONTENT_FINGERPRINT');

-- CreateEnum
CREATE TYPE "MarketDescriptionCompleteness" AS ENUM ('FULL', 'TRUNCATED', 'ABSENT');

-- CreateEnum
CREATE TYPE "MarketSkillExtractionStatus" AS ENUM ('EXTRACTED', 'NO_TEXT', 'FAILED');

-- CreateEnum
CREATE TYPE "MarketTermMatchMethod" AS ENUM ('EXACT_CANONICAL', 'ALIAS', 'SOURCE_TAXONOMY', 'UNMAPPED');

-- CreateEnum
CREATE TYPE "MarketTermLocus" AS ENUM ('TITLE', 'DESCRIPTION', 'SOURCE_TAXONOMY');

-- CreateEnum
CREATE TYPE "MarketSignalType" AS ENUM ('ROLE_POSTING_VOLUME', 'ROLE_SKILL_PREVALENCE');

-- CreateEnum
CREATE TYPE "MarketDedupeMethod" AS ENUM ('NONE');

-- CreateTable
CREATE TABLE "MarketSource" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "kind" "MarketSourceKind" NOT NULL DEFAULT 'JOB_BOARD',
    "identityBasis" "MarketIdentityBasis" NOT NULL DEFAULT 'SOURCE_ID',
    "licenceBasis" "MarketLicenceBasis" NOT NULL,
    "licenceNote" TEXT,
    "licenceReviewedAt" TIMESTAMP(3),
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mayRedistributeDerived" BOOLEAN NOT NULL DEFAULT false,
    "expectedPostingLifetimeDays" INTEGER NOT NULL DEFAULT 30,
    "pollIntervalHours" INTEGER NOT NULL DEFAULT 24,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketIngestionRun" (
    "id" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "status" "MarketIngestionStatus" NOT NULL DEFAULT 'RUNNING',
    "runSeq" SERIAL NOT NULL,
    "adapterVersion" INTEGER NOT NULL,
    "rulesetVersion" INTEGER NOT NULL,
    "queryParams" JSONB NOT NULL,
    "queryFingerprint" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "errorReason" TEXT,
    "stats" JSONB,

    CONSTRAINT "MarketIngestionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketRunScopeCoverage" (
    "runId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "sourceScope" TEXT NOT NULL,
    "requested" BOOLEAN NOT NULL DEFAULT true,
    "read" BOOLEAN NOT NULL,
    "completeForScope" BOOLEAN NOT NULL,
    "failureReason" TEXT,
    "postingsSeen" INTEGER NOT NULL DEFAULT 0,
    "postingsAccepted" INTEGER NOT NULL DEFAULT 0,
    "postingsRejected" INTEGER NOT NULL DEFAULT 0,
    "duplicatesDropped" INTEGER NOT NULL DEFAULT 0,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "MarketRunScopeCoverage_pkey" PRIMARY KEY ("runId","sourceScope")
);

-- CreateTable
CREATE TABLE "MarketPosting" (
    "id" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "identityBasis" "MarketIdentityBasis" NOT NULL,
    "identityVersion" INTEGER NOT NULL,
    "externalKey" TEXT NOT NULL,
    "sourceScope" TEXT NOT NULL,
    "externalGroupKey" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "companyRaw" TEXT,
    "companyNormalized" TEXT,
    "applyUrlCanonical" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketPosting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketPostingVersion" (
    "id" UUID NOT NULL,
    "postingId" UUID NOT NULL,
    "contentHashVersion" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "firstSeenRunId" UUID NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "titleRaw" TEXT NOT NULL,
    "companyRaw" TEXT,
    "locationRaw" TEXT,
    "descriptionRaw" TEXT,
    "descriptionCompleteness" "MarketDescriptionCompleteness" NOT NULL,
    "sourcePublishedAt" TIMESTAMP(3),
    "sourceUpdatedAt" TIMESTAMP(3),
    "sourceValidThrough" TIMESTAMP(3),
    "applyUrlRaw" TEXT,
    "sourceCategoriesRaw" TEXT[],
    "rawPayload" JSONB NOT NULL,
    "rawPayloadHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketPostingVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketPostingSighting" (
    "runId" UUID NOT NULL,
    "postingId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "runSeq" INTEGER NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3),
    "pageIndex" INTEGER NOT NULL,
    "indexInPage" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketPostingSighting_pkey" PRIMARY KEY ("runId","postingId","versionId")
);

-- CreateTable
CREATE TABLE "MarketRole" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "introducedInRulesetVersion" INTEGER NOT NULL,
    "deprecatedAt" TIMESTAMP(3),
    "supersededById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketSkill" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "introducedInRulesetVersion" INTEGER NOT NULL,
    "deprecatedAt" TIMESTAMP(3),
    "supersededById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketRoleAlias" (
    "id" UUID NOT NULL,
    "rulesetVersion" INTEGER NOT NULL,
    "aliasNormalized" TEXT NOT NULL,
    "roleId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketRoleAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketSkillAlias" (
    "id" UUID NOT NULL,
    "rulesetVersion" INTEGER NOT NULL,
    "aliasNormalized" TEXT NOT NULL,
    "skillId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketSkillAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketPostingNormalization" (
    "id" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "rulesetVersion" INTEGER NOT NULL,
    "titleNormalized" TEXT NOT NULL,
    "roleId" UUID,
    "roleMatchMethod" "MarketTermMatchMethod" NOT NULL,
    "roleAliasId" UUID,
    "titleModifierRaw" TEXT,
    "companyNormalized" TEXT,
    "descriptionText" TEXT,
    "skillExtractionStatus" "MarketSkillExtractionStatus" NOT NULL,
    "outputHash" TEXT NOT NULL,
    "normalizedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketPostingNormalization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketPostingSkillMention" (
    "id" UUID NOT NULL,
    "normalizationId" UUID NOT NULL,
    "rulesetVersion" INTEGER NOT NULL,
    "rawTerm" TEXT NOT NULL,
    "termNormalized" TEXT NOT NULL,
    "skillId" UUID,
    "aliasId" UUID,
    "matchMethod" "MarketTermMatchMethod" NOT NULL,
    "extractedFrom" "MarketTermLocus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketPostingSkillMention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketSignalRun" (
    "id" UUID NOT NULL,
    "status" "MarketComputationStatus" NOT NULL DEFAULT 'RUNNING',
    "rulesetVersion" INTEGER NOT NULL,
    "computationVersion" INTEGER NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "sourceScopeKey" TEXT NOT NULL,
    "scopes" TEXT[],
    "minDenominator" INTEGER NOT NULL,
    "minDistinctCompanies" INTEGER NOT NULL,
    "coverageComplete" BOOLEAN NOT NULL DEFAULT false,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "stats" JSONB,

    CONSTRAINT "MarketSignalRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketSignal" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "signalType" "MarketSignalType" NOT NULL,
    "roleId" UUID NOT NULL,
    "skillId" UUID,
    "numeratorCount" INTEGER NOT NULL,
    "denominatorCount" INTEGER NOT NULL,
    "distinctCompanyCount" INTEGER NOT NULL,
    "distinctSourceCount" INTEGER NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "rulesetVersion" INTEGER NOT NULL,
    "computationVersion" INTEGER NOT NULL,
    "sourceScopeKey" TEXT NOT NULL,
    "dedupeMethod" "MarketDedupeMethod" NOT NULL,
    "coverageComplete" BOOLEAN NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketSignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketSource_slug_key" ON "MarketSource"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "MarketIngestionRun_runSeq_key" ON "MarketIngestionRun"("runSeq");

-- CreateIndex
CREATE INDEX "MarketIngestionRun_sourceId_startedAt_idx" ON "MarketIngestionRun"("sourceId", "startedAt");

-- CreateIndex
CREATE INDEX "MarketIngestionRun_queryFingerprint_idx" ON "MarketIngestionRun"("queryFingerprint");

-- CreateIndex
CREATE INDEX "MarketRunScopeCoverage_sourceId_sourceScope_completeForScop_idx" ON "MarketRunScopeCoverage"("sourceId", "sourceScope", "completeForScope", "finishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MarketPosting_externalId_key" ON "MarketPosting"("externalId");

-- CreateIndex
CREATE INDEX "MarketPosting_sourceId_sourceScope_idx" ON "MarketPosting"("sourceId", "sourceScope");

-- CreateIndex
CREATE INDEX "MarketPosting_sourceId_firstSeenAt_idx" ON "MarketPosting"("sourceId", "firstSeenAt");

-- CreateIndex
CREATE INDEX "MarketPosting_sourceId_externalGroupKey_idx" ON "MarketPosting"("sourceId", "externalGroupKey");

-- CreateIndex
CREATE INDEX "MarketPosting_companyNormalized_idx" ON "MarketPosting"("companyNormalized");

-- CreateIndex
CREATE INDEX "MarketPostingVersion_postingId_idx" ON "MarketPostingVersion"("postingId");

-- CreateIndex
CREATE INDEX "MarketPostingVersion_firstSeenRunId_idx" ON "MarketPostingVersion"("firstSeenRunId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketPostingVersion_postingId_contentHashVersion_contentHa_key" ON "MarketPostingVersion"("postingId", "contentHashVersion", "contentHash");

-- CreateIndex
CREATE INDEX "MarketPostingSighting_observedAt_idx" ON "MarketPostingSighting"("observedAt");

-- CreateIndex
CREATE INDEX "MarketPostingSighting_postingId_observedAt_runSeq_idx" ON "MarketPostingSighting"("postingId", "observedAt", "runSeq");

-- CreateIndex
CREATE INDEX "MarketPostingSighting_versionId_idx" ON "MarketPostingSighting"("versionId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketRole_slug_key" ON "MarketRole"("slug");

-- CreateIndex
CREATE INDEX "MarketRole_supersededById_idx" ON "MarketRole"("supersededById");

-- CreateIndex
CREATE UNIQUE INDEX "MarketSkill_slug_key" ON "MarketSkill"("slug");

-- CreateIndex
CREATE INDEX "MarketSkill_supersededById_idx" ON "MarketSkill"("supersededById");

-- CreateIndex
CREATE INDEX "MarketRoleAlias_roleId_idx" ON "MarketRoleAlias"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketRoleAlias_rulesetVersion_aliasNormalized_key" ON "MarketRoleAlias"("rulesetVersion", "aliasNormalized");

-- CreateIndex
CREATE INDEX "MarketSkillAlias_skillId_idx" ON "MarketSkillAlias"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketSkillAlias_rulesetVersion_aliasNormalized_key" ON "MarketSkillAlias"("rulesetVersion", "aliasNormalized");

-- CreateIndex
CREATE INDEX "MarketPostingNormalization_rulesetVersion_roleId_idx" ON "MarketPostingNormalization"("rulesetVersion", "roleId");

-- CreateIndex
CREATE INDEX "MarketPostingNormalization_roleId_idx" ON "MarketPostingNormalization"("roleId");

-- CreateIndex
CREATE INDEX "MarketPostingNormalization_roleAliasId_idx" ON "MarketPostingNormalization"("roleAliasId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketPostingNormalization_versionId_rulesetVersion_key" ON "MarketPostingNormalization"("versionId", "rulesetVersion");

-- CreateIndex
CREATE UNIQUE INDEX "MarketPostingNormalization_id_rulesetVersion_key" ON "MarketPostingNormalization"("id", "rulesetVersion");

-- CreateIndex
CREATE INDEX "MarketPostingSkillMention_skillId_rulesetVersion_idx" ON "MarketPostingSkillMention"("skillId", "rulesetVersion");

-- CreateIndex
CREATE INDEX "MarketPostingSkillMention_rulesetVersion_idx" ON "MarketPostingSkillMention"("rulesetVersion");

-- CreateIndex
CREATE INDEX "MarketPostingSkillMention_aliasId_idx" ON "MarketPostingSkillMention"("aliasId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketPostingSkillMention_normalizationId_termNormalized_ex_key" ON "MarketPostingSkillMention"("normalizationId", "termNormalized", "extractedFrom");

-- CreateIndex
CREATE INDEX "MarketSignalRun_computedAt_idx" ON "MarketSignalRun"("computedAt");

-- CreateIndex
CREATE INDEX "MarketSignalRun_windowStart_windowEnd_idx" ON "MarketSignalRun"("windowStart", "windowEnd");

-- CreateIndex
CREATE INDEX "MarketSignal_runId_signalType_idx" ON "MarketSignal"("runId", "signalType");

-- CreateIndex
CREATE INDEX "MarketSignal_roleId_signalType_idx" ON "MarketSignal"("roleId", "signalType");

-- CreateIndex
CREATE INDEX "MarketSignal_skillId_idx" ON "MarketSignal"("skillId");

-- AddForeignKey
ALTER TABLE "MarketIngestionRun" ADD CONSTRAINT "MarketIngestionRun_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "MarketSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketRunScopeCoverage" ADD CONSTRAINT "MarketRunScopeCoverage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MarketIngestionRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketRunScopeCoverage" ADD CONSTRAINT "MarketRunScopeCoverage_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "MarketSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketPosting" ADD CONSTRAINT "MarketPosting_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "MarketSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketPostingVersion" ADD CONSTRAINT "MarketPostingVersion_postingId_fkey" FOREIGN KEY ("postingId") REFERENCES "MarketPosting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketPostingVersion" ADD CONSTRAINT "MarketPostingVersion_firstSeenRunId_fkey" FOREIGN KEY ("firstSeenRunId") REFERENCES "MarketIngestionRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketPostingSighting" ADD CONSTRAINT "MarketPostingSighting_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MarketIngestionRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketPostingSighting" ADD CONSTRAINT "MarketPostingSighting_postingId_fkey" FOREIGN KEY ("postingId") REFERENCES "MarketPosting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketPostingSighting" ADD CONSTRAINT "MarketPostingSighting_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "MarketPostingVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketRole" ADD CONSTRAINT "MarketRole_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "MarketRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketSkill" ADD CONSTRAINT "MarketSkill_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "MarketSkill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketRoleAlias" ADD CONSTRAINT "MarketRoleAlias_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "MarketRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketSkillAlias" ADD CONSTRAINT "MarketSkillAlias_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "MarketSkill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketPostingNormalization" ADD CONSTRAINT "MarketPostingNormalization_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "MarketPostingVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketPostingNormalization" ADD CONSTRAINT "MarketPostingNormalization_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "MarketRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketPostingNormalization" ADD CONSTRAINT "MarketPostingNormalization_roleAliasId_fkey" FOREIGN KEY ("roleAliasId") REFERENCES "MarketRoleAlias"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketPostingSkillMention" ADD CONSTRAINT "MarketPostingSkillMention_normalizationId_rulesetVersion_fkey" FOREIGN KEY ("normalizationId", "rulesetVersion") REFERENCES "MarketPostingNormalization"("id", "rulesetVersion") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketPostingSkillMention" ADD CONSTRAINT "MarketPostingSkillMention_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "MarketSkill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketPostingSkillMention" ADD CONSTRAINT "MarketPostingSkillMention_aliasId_fkey" FOREIGN KEY ("aliasId") REFERENCES "MarketSkillAlias"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketSignal" ADD CONSTRAINT "MarketSignal_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MarketSignalRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketSignal" ADD CONSTRAINT "MarketSignal_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "MarketRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketSignal" ADD CONSTRAINT "MarketSignal_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "MarketSkill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Four partial unique indexes and four CHECK constraints that Prisma's
-- schema language cannot express. Each closes a hole that would otherwise
-- be silent.

-- A signal is one statement per (run, type, role, skill). skillId is NULL
-- for ROLE_POSTING_VOLUME, and Postgres treats NULLs as DISTINCT - so a
-- plain UNIQUE over four columns would permit unlimited duplicate volume
-- rows while appearing to forbid them. This is the same trap the Evidence
-- model documents at length. Two partial indexes instead, so both shapes
-- are covered and neither relies on NULL comparison.
CREATE UNIQUE INDEX "MarketSignal_run_type_role_skill_key"
  ON "MarketSignal" ("runId", "signalType", "roleId", "skillId")
  WHERE "skillId" IS NOT NULL;

CREATE UNIQUE INDEX "MarketSignal_run_type_role_key"
  ON "MarketSignal" ("runId", "signalType", "roleId")
  WHERE "skillId" IS NULL;

-- At most one live ingestion run per source.
--
-- ExternalSyncRun has no equivalent constraint and guards concurrency with
-- a read-then-write in application code, which is documented there as an
-- accepted residual: under READ COMMITTED two callers can both read "no
-- run in flight" and both insert.
--
-- A constraint alone would be worse than the defect, though: a process
-- killed mid-run would leave a RUNNING row that no later run could get
-- past, and the source would go dark permanently with no error anywhere.
-- So this index ships together with the stale-run lease in
-- MarketIngestionRunService.start, which reclaims an abandoned run before
-- inserting. The constraint and the lease are one mechanism and neither is
-- safe without the other.
CREATE UNIQUE INDEX "MarketIngestionRun_one_running_per_source_key"
  ON "MarketIngestionRun" ("sourceId")
  WHERE "status" = 'RUNNING';

-- The same, for computations. Two concurrent recomputes of the identical
-- question would otherwise write two full sets of signals, and a consumer
-- reading by role would pick between them arbitrarily.
CREATE UNIQUE INDEX "MarketSignalRun_one_running_per_scope_key"
  ON "MarketSignalRun" ("sourceScopeKey")
  WHERE "status" = 'RUNNING';

-- Source slugs are authored ASCII. Constrained here rather than trusted,
-- because the slug is a component of every posting's derived identity and
-- a slug containing a separator would make that identity ambiguous.
ALTER TABLE "MarketSource"
  ADD CONSTRAINT "MarketSource_slug_shape"
  CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]*$');

-- Scopes are ATS board tokens, country codes, or '*' for a source with no
-- sub-scope. Also part of derived identity.
ALTER TABLE "MarketPosting"
  ADD CONSTRAINT "MarketPosting_sourceScope_shape"
  CHECK ("sourceScope" ~ '^[a-z0-9*][a-z0-9._*-]*$');

-- "Unmapped" and "has a role" must not be simultaneously true, and a role
-- that resolved must not be recorded as unmapped. Without this, the
-- explainability guarantee is a convention that any writer can break; with
-- it, the broken state cannot be stored at all.
ALTER TABLE "MarketPostingNormalization"
  ADD CONSTRAINT "MarketPostingNormalization_role_match_consistent"
  CHECK (("roleId" IS NULL) = ("roleMatchMethod" = 'UNMAPPED'));

ALTER TABLE "MarketPostingSkillMention"
  ADD CONSTRAINT "MarketPostingSkillMention_skill_match_consistent"
  CHECK (("skillId" IS NULL) = ("matchMethod" = 'UNMAPPED'));
