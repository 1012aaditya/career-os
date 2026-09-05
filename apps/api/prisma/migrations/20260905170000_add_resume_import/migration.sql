-- CreateEnum
CREATE TYPE "ResumeImportStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'NEEDS_REVIEW',
  'CONFIRMED',
  'FAILED'
);

-- CreateTable
CREATE TABLE "ResumeImport" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "fileName" TEXT NOT NULL,
  "storagePath" TEXT NOT NULL,
  "status" "ResumeImportStatus" NOT NULL DEFAULT 'PENDING',
  "extractionResult" JSONB,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ResumeImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResumeImport_userId_idx"
ON "ResumeImport"("userId");

-- CreateIndex
CREATE INDEX "ResumeImport_userId_status_idx"
ON "ResumeImport"("userId", "status");

-- AddForeignKey
ALTER TABLE "ResumeImport"
ADD CONSTRAINT "ResumeImport_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
