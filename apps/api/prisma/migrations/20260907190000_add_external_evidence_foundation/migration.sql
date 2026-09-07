-- Phase 7.1 - External Evidence Layer foundation.
--
-- Every statement here is additive. Three new enums, three new tables and
-- one new unique index. No existing table is altered, no column is added,
-- changed or dropped, and no existing row is read or rewritten.
--
-- In particular CareerGraphIngestion is untouched. Widening its NOT NULL
-- resumeImportId to carry external sources was considered and rejected:
-- it would weaken a live invariant on a table the Career Graph depends on,
-- to serve a case that a separate table serves without touching anything.

CREATE TYPE "ExternalProvider" AS ENUM ('GITHUB', 'PORTFOLIO');

CREATE TYPE "ExternalConnectionStatus" AS ENUM ('ACTIVE', 'INVALID', 'REVOKED');

CREATE TYPE "ExternalSyncStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- A credential-bearing relationship between one user and one provider.
-- Token columns are nullable because not every provider carries a
-- credential: a PORTFOLIO connection is a public URL.
CREATE TABLE "ExternalConnection" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "ExternalProvider" NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "externalAccountLogin" TEXT NOT NULL,
    "tokenCiphertext" BYTEA,
    "tokenIv" BYTEA,
    "tokenTag" BYTEA,
    "tokenKeyVersion" INTEGER,
    "tokenAlg" TEXT,
    "grantedScopes" TEXT[],
    "status" "ExternalConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastVerifiedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalConnection_pkey" PRIMARY KEY ("id")
);

-- One connection per provider per user.
CREATE UNIQUE INDEX "ExternalConnection_userId_provider_key"
    ON "ExternalConnection"("userId", "provider");

-- One user per external account. This is the constraint that caps the
-- blast radius of an account-linking CSRF: a successful attack becomes a
-- unique violation instead of one attacker account silently attached to
-- many victims.
CREATE UNIQUE INDEX "ExternalConnection_provider_externalAccountId_key"
    ON "ExternalConnection"("provider", "externalAccountId");

-- A pending OAuth authorization. This table is the only thing that answers
-- "which of our users does this callback belong to" - the callback arrives
-- in a system browser with no session for a bearer-token API, so there is
-- no ambient user to read, and reading one would be the account-linking
-- CSRF.
CREATE TABLE "OAuthAuthorizationRequest" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "ExternalProvider" NOT NULL,
    "stateHash" TEXT NOT NULL,
    "codeVerifierCiphertext" BYTEA NOT NULL,
    "codeVerifierIv" BYTEA NOT NULL,
    "codeVerifierTag" BYTEA NOT NULL,
    "codeVerifierKeyVersion" INTEGER NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthAuthorizationRequest_pkey" PRIMARY KEY ("id")
);

-- Unique so that consuming a state is a single atomic compare-and-swap.
CREATE UNIQUE INDEX "OAuthAuthorizationRequest_stateHash_key"
    ON "OAuthAuthorizationRequest"("stateHash");

CREATE INDEX "OAuthAuthorizationRequest_userId_idx"
    ON "OAuthAuthorizationRequest"("userId");

-- Supports sweeping expired rows.
CREATE INDEX "OAuthAuthorizationRequest_expiresAt_idx"
    ON "OAuthAuthorizationRequest"("expiresAt");

-- The source-generic ingestion ledger: one row per sync attempt. stats
-- carries the completeness record, including reposScanned and reposTotal.
-- A run that read fewer repositories than it found is PARTIAL and must
-- never be recorded as SUCCEEDED.
CREATE TABLE "ExternalSyncRun" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "ExternalSyncStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "stats" JSONB,

    CONSTRAINT "ExternalSyncRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExternalSyncRun_connectionId_startedAt_idx"
    ON "ExternalSyncRun"("connectionId", "startedAt");

CREATE INDEX "ExternalSyncRun_userId_idx"
    ON "ExternalSyncRun"("userId");

ALTER TABLE "ExternalConnection" ADD CONSTRAINT "ExternalConnection_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OAuthAuthorizationRequest" ADD CONSTRAINT "OAuthAuthorizationRequest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExternalSyncRun" ADD CONSTRAINT "ExternalSyncRun_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "ExternalConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExternalSyncRun" ADD CONSTRAINT "ExternalSyncRun_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deduplication key for re-syncable sources.
--
-- A resume is confirmed once; an external source is pulled again and
-- again, so re-ingesting must update in place rather than accumulate a row
-- per sync. Evidence.externalId is nullable and every existing row carries
-- NULL; Postgres treats NULLs as DISTINCT in a unique index, so every
-- existing resume evidence row is unaffected and no backfill is needed.
--
-- NULLS NOT DISTINCT is deliberately NOT used here. With it, this index
-- would fail on the second resume evidence row belonging to one user.
CREATE UNIQUE INDEX "Evidence_userId_sourceType_externalId_key"
    ON "Evidence"("userId", "sourceType", "externalId");
