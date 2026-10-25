-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "triggerDate" TEXT;

-- AlterTable
ALTER TABLE "owners" ADD COLUMN     "lastScannedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "leads_orgId_ownerId_followUpAt_idx" ON "leads"("orgId", "ownerId", "followUpAt");

-- CreateIndex
CREATE INDEX "tasks_orgId_ownerId_done_idx" ON "tasks"("orgId", "ownerId", "done");
