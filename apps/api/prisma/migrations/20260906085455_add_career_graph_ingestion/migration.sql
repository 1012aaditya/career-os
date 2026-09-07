-- CreateTable
CREATE TABLE "CareerGraphIngestion" (
    "id" UUID NOT NULL,
    "resumeImportId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CareerGraphIngestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CareerGraphIngestion_resumeImportId_key" ON "CareerGraphIngestion"("resumeImportId");

-- CreateIndex
CREATE INDEX "CareerGraphIngestion_userId_idx" ON "CareerGraphIngestion"("userId");

-- AddForeignKey
ALTER TABLE "CareerGraphIngestion" ADD CONSTRAINT "CareerGraphIngestion_resumeImportId_fkey" FOREIGN KEY ("resumeImportId") REFERENCES "ResumeImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CareerGraphIngestion" ADD CONSTRAINT "CareerGraphIngestion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
