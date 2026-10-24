-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "followUpAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "leads_orgId_followUpAt_idx" ON "leads"("orgId", "followUpAt");
