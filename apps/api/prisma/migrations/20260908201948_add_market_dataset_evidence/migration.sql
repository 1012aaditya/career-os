-- CreateEnum
CREATE TYPE "MarketDatasetKind" AS ENUM ('TAXONOMY', 'AGGREGATE');

-- CreateEnum
CREATE TYPE "MarketTermKind" AS ENUM ('OCCUPATION', 'ALTERNATE_TITLE', 'SKILL', 'TECHNOLOGY', 'INDUSTRY');

-- CreateTable
CREATE TABLE "MarketDatasetVersion" (
    "id" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "kind" "MarketDatasetKind" NOT NULL,
    "datasetKey" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "retrievedAt" TIMESTAMP(3) NOT NULL,
    "contentHash" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "attribution" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketDatasetVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketTaxonomyTerm" (
    "id" UUID NOT NULL,
    "datasetVersionId" UUID NOT NULL,
    "kind" "MarketTermKind" NOT NULL,
    "externalCode" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "parentCode" TEXT,

    CONSTRAINT "MarketTaxonomyTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketAggregateObservation" (
    "id" UUID NOT NULL,
    "datasetVersionId" UUID NOT NULL,
    "seriesKey" TEXT NOT NULL,
    "geography" TEXT NOT NULL,
    "category" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "periodType" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "unit" TEXT NOT NULL,

    CONSTRAINT "MarketAggregateObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketDatasetVersion_sourceId_datasetKey_releasedAt_idx" ON "MarketDatasetVersion"("sourceId", "datasetKey", "releasedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MarketDatasetVersion_sourceId_datasetKey_version_key" ON "MarketDatasetVersion"("sourceId", "datasetKey", "version");

-- CreateIndex
CREATE INDEX "MarketTaxonomyTerm_datasetVersionId_kind_idx" ON "MarketTaxonomyTerm"("datasetVersionId", "kind");

-- CreateIndex
CREATE INDEX "MarketTaxonomyTerm_externalCode_idx" ON "MarketTaxonomyTerm"("externalCode");

-- CreateIndex
CREATE UNIQUE INDEX "MarketTaxonomyTerm_datasetVersionId_kind_externalCode_label_key" ON "MarketTaxonomyTerm"("datasetVersionId", "kind", "externalCode", "label", "language");

-- CreateIndex
CREATE INDEX "MarketAggregateObservation_datasetVersionId_seriesKey_idx" ON "MarketAggregateObservation"("datasetVersionId", "seriesKey");

-- CreateIndex
CREATE INDEX "MarketAggregateObservation_periodStart_idx" ON "MarketAggregateObservation"("periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "MarketAggregateObservation_datasetVersionId_seriesKey_geogr_key" ON "MarketAggregateObservation"("datasetVersionId", "seriesKey", "geography", "category", "periodStart", "metric");

-- AddForeignKey
ALTER TABLE "MarketDatasetVersion" ADD CONSTRAINT "MarketDatasetVersion_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "MarketSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketTaxonomyTerm" ADD CONSTRAINT "MarketTaxonomyTerm_datasetVersionId_fkey" FOREIGN KEY ("datasetVersionId") REFERENCES "MarketDatasetVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketAggregateObservation" ADD CONSTRAINT "MarketAggregateObservation_datasetVersionId_fkey" FOREIGN KEY ("datasetVersionId") REFERENCES "MarketDatasetVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
