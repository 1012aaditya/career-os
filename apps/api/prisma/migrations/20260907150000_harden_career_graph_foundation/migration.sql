-- Phase 6.8 — Career Graph hardening.
-- Every change is additive and nullable. No column is dropped, no value is
-- rewritten, and no existing row is touched: pre-existing rows simply carry
-- NULL, which reads as "unknown" rather than as a fabricated value.

-- The worker's original extraction, preserved so it survives the user's edits.
ALTER TABLE "ResumeImport" ADD COLUMN "rawExtractionResult" JSONB;

-- The end date exactly as the source wrote it, so a role that the source
-- SAID was ongoing stays distinguishable from one that merely omitted a date.
ALTER TABLE "Experience" ADD COLUMN "endDateText" TEXT;

-- Provenance for education, the only entity that could not previously say
-- which import it came from.
CREATE TABLE "EvidenceEducation" (
    "evidenceId" UUID NOT NULL,
    "educationId" UUID NOT NULL,

    CONSTRAINT "EvidenceEducation_pkey" PRIMARY KEY ("evidenceId","educationId")
);

CREATE INDEX "EvidenceEducation_educationId_idx" ON "EvidenceEducation"("educationId");

ALTER TABLE "EvidenceEducation" ADD CONSTRAINT "EvidenceEducation_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "Evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EvidenceEducation" ADD CONSTRAINT "EvidenceEducation_educationId_fkey" FOREIGN KEY ("educationId") REFERENCES "Education"("id") ON DELETE CASCADE ON UPDATE CASCADE;
