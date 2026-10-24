-- CreateEnum
CREATE TYPE "ImportEntityType" AS ENUM ('lead', 'contact');

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "importBatchId" TEXT;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "importBatchId" TEXT;

-- CreateTable
CREATE TABLE "import_batches" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityType" "ImportEntityType" NOT NULL,
    "totalRows" INTEGER NOT NULL,
    "importedById" TEXT NOT NULL,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "committedAt" TIMESTAMP(3),
    "undoneAt" TIMESTAMP(3),
    "undoneById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_batches_orgId_idx" ON "import_batches"("orgId");

-- CreateIndex
CREATE INDEX "import_batches_orgId_createdAt_idx" ON "import_batches"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "contacts_orgId_importBatchId_idx" ON "contacts"("orgId", "importBatchId");

-- CreateIndex
CREATE INDEX "leads_orgId_importBatchId_idx" ON "leads"("orgId", "importBatchId");

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_importedById_fkey" FOREIGN KEY ("importedById") REFERENCES "owners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
