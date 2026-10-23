-- CreateEnum
CREATE TYPE "RepVisibility" AS ENUM ('ALL', 'OWN');

-- AlterTable
ALTER TABLE "activities" ADD COLUMN     "ownerId" TEXT;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "repVisibility" "RepVisibility" NOT NULL DEFAULT 'ALL';

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "createdById" TEXT;

-- Backfill (one-time, historical rows only — see the schema comments on both columns for why
-- neither is NOT NULL yet: no write path populates them going forward until Stage 1).

-- Activity.ownerId: whoever currently owns the subject (lead/contact/deal), or the actor for a
-- standalone activity with no subject. This is the best available approximation for history that
-- predates the column — a reassignment that happened before this backfill is not reconstructible,
-- so a backfilled row reflects the subject's *current* owner, not who owned it at the time.
UPDATE "activities" a
SET "ownerId" = COALESCE(
  (SELECT l."ownerId" FROM "leads" l WHERE l.id = a."leadId"),
  (SELECT c."ownerId" FROM "contacts" c WHERE c.id = a."contactId"),
  (SELECT d."ownerId" FROM "deals" d WHERE d.id = a."dealId"),
  a."actorId"
);

-- Task.createdById: no historical creator is recorded, so the current assignee (ownerId) is the
-- closest available approximation for existing rows. Real creator going forward, once Stage 1
-- wires task creation to set it.
UPDATE "tasks" SET "createdById" = "ownerId" WHERE "createdById" IS NULL;

-- CreateIndex
CREATE INDEX "activities_orgId_ownerId_at_idx" ON "activities"("orgId", "ownerId", "at");

-- CreateIndex
CREATE INDEX "tasks_orgId_createdById_idx" ON "tasks"("orgId", "createdById");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "owners"("id") ON DELETE SET NULL ON UPDATE CASCADE;
