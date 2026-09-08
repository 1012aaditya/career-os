-- Market Search: the read projection.
--
-- WHY A MIGRATION AT ALL. Phase 10's rule is to prefer queries over schema
-- changes. This is the case the rule leaves room for: there is no column
-- anywhere that says which MarketPostingVersion is a posting's current
-- one, so every search would open with a window function over 76,968
-- version rows joined to normalization and skill mentions - per request,
-- before a single filter is applied. The projection turns that into one
-- indexed table scan.
--
-- WHY EACH INDEX EXISTS. Stated here because an index nobody can justify
-- is an index nobody dares delete.
--
--   sourceSlug            the `source` filter, and the only filter that
--                         partitions the corpus unevenly (70% is one
--                         source), so it must not be a scan
--   roleSlug              the canonical-role filter, Phase 9's whole
--                         point; 45,231 of 76,968 rows carry one
--   companyNormalized     the `company` filter
--   sourcePublishedAt     the freshness filter's range bound AND the
--                         first pagination tie-breaker, so it is read in
--                         sorted order on every page
--   lastSeenAt            the freshness verdict's age input
--   (sourceId, groupKey)  search-time grouping. Composite and in this
--                         order because a groupKey is only meaningful
--                         within its source - two sources may reuse a
--                         requisition number and mean different jobs
--   versionId             the detail lookup's join back to content
--
--   GIN searchTokens      free-text matching. GIN rather than btree
--   GIN titleTokens       because these are arrays and the query is
--   GIN locationTokens    containment (&&, @>), which btree cannot
--   GIN skillSlugs        answer. A LIKE '%term%' scan was the
--                         alternative and it cannot use an index at all.
--
-- NO index on externalId even though it is the final tie-breaker: it is
-- only ever read as the last key of an ordering the leading columns have
-- already narrowed to a handful of rows.
--
-- Both foreign keys CASCADE, and that is safe here in a way it would not
-- be on evidence: this table asserts nothing of its own. Losing a row
-- costs a rebuild, so a purge that deletes a posting should take its
-- document with it rather than being blocked by it.

-- CreateTable
CREATE TABLE "MarketPostingSearchDocument" (
    "postingId" UUID NOT NULL,
    "projectionVersion" INTEGER NOT NULL,
    "rulesetVersion" INTEGER NOT NULL,
    "sourceId" UUID NOT NULL,
    "sourceSlug" TEXT NOT NULL,
    "sourceScope" TEXT NOT NULL,
    "versionId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "titleRaw" TEXT NOT NULL,
    "titleNormalized" TEXT NOT NULL,
    "titleTokens" TEXT[],
    "companyRaw" TEXT,
    "companyNormalized" TEXT,
    "locationRaw" TEXT,
    "locationNormalized" TEXT,
    "locationTokens" TEXT[],
    "roleSlug" TEXT,
    "skillSlugs" TEXT[],
    "searchTokens" TEXT[],
    "sourcePublishedAt" TIMESTAMP(3),
    "sourceValidThrough" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "applyUrl" TEXT,
    "groupKey" TEXT,
    "contentHash" TEXT NOT NULL,
    "projectedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketPostingSearchDocument_pkey" PRIMARY KEY ("postingId")
);

-- CreateIndex
CREATE INDEX "MarketPostingSearchDocument_sourceSlug_idx" ON "MarketPostingSearchDocument"("sourceSlug");

-- CreateIndex
CREATE INDEX "MarketPostingSearchDocument_roleSlug_idx" ON "MarketPostingSearchDocument"("roleSlug");

-- CreateIndex
CREATE INDEX "MarketPostingSearchDocument_companyNormalized_idx" ON "MarketPostingSearchDocument"("companyNormalized");

-- CreateIndex
CREATE INDEX "MarketPostingSearchDocument_sourcePublishedAt_idx" ON "MarketPostingSearchDocument"("sourcePublishedAt");

-- CreateIndex
CREATE INDEX "MarketPostingSearchDocument_lastSeenAt_idx" ON "MarketPostingSearchDocument"("lastSeenAt");

-- CreateIndex
CREATE INDEX "MarketPostingSearchDocument_sourceId_groupKey_idx" ON "MarketPostingSearchDocument"("sourceId", "groupKey");

-- CreateIndex
CREATE INDEX "MarketPostingSearchDocument_versionId_idx" ON "MarketPostingSearchDocument"("versionId");

-- CreateIndex
CREATE INDEX "MarketPostingSearchDocument_searchTokens_idx" ON "MarketPostingSearchDocument" USING GIN ("searchTokens");

-- CreateIndex
CREATE INDEX "MarketPostingSearchDocument_titleTokens_idx" ON "MarketPostingSearchDocument" USING GIN ("titleTokens");

-- CreateIndex
CREATE INDEX "MarketPostingSearchDocument_locationTokens_idx" ON "MarketPostingSearchDocument" USING GIN ("locationTokens");

-- CreateIndex
CREATE INDEX "MarketPostingSearchDocument_skillSlugs_idx" ON "MarketPostingSearchDocument" USING GIN ("skillSlugs");

-- AddForeignKey
ALTER TABLE "MarketPostingSearchDocument" ADD CONSTRAINT "MarketPostingSearchDocument_postingId_fkey" FOREIGN KEY ("postingId") REFERENCES "MarketPosting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketPostingSearchDocument" ADD CONSTRAINT "MarketPostingSearchDocument_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "MarketPostingVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

