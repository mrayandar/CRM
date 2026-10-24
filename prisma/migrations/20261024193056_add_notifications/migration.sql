-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('assigned', 'task_due', 'lead_follow_up');

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "recipientId" TEXT NOT NULL,
    "subjectType" "SubjectType",
    "subjectId" TEXT,
    "count" INTEGER,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_orgId_recipientId_readAt_idx" ON "notifications"("orgId", "recipientId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_orgId_recipientId_dedupeKey_key" ON "notifications"("orgId", "recipientId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "owners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
