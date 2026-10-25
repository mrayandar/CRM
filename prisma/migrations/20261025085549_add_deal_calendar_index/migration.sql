-- CreateIndex
CREATE INDEX "deals_orgId_ownerId_closeDate_idx" ON "deals"("orgId", "ownerId", "closeDate");
