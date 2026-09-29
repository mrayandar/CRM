-- Replaces the fixed "DealStage" enum with a real per-org PipelineStage table so stages can be
-- renamed and reordered per organization. Every existing org is seeded with the 6 stages the
-- enum used to hard-code (same keys, labels, order, probabilities, and Won/Lost flags), then
-- every existing Deal row is backfilled to point at its org's matching new row before the old
-- enum column is dropped. Runs as one transaction (Prisma's default for a migration.sql that
-- contains no CONCURRENTLY statements), so a failure at any step rolls back the whole thing —
-- no organization can end up with some deals migrated and some not.

-- 1. New table.
CREATE TABLE "pipeline_stages" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "probability" INTEGER NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "isWon" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_stages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pipeline_stages_orgId_key_key" ON "pipeline_stages"("orgId", "key");
CREATE INDEX "pipeline_stages_orgId_idx" ON "pipeline_stages"("orgId");
CREATE INDEX "pipeline_stages_orgId_order_idx" ON "pipeline_stages"("orgId", "order");

-- 2. Seed every existing org with the 6 stages the enum used to represent — same order,
-- probability, and Won/Lost flags the app has always used.
INSERT INTO "pipeline_stages" ("id", "orgId", "key", "label", "order", "probability", "isClosed", "isWon", "updatedAt")
SELECT gen_random_uuid()::text, o."id", s.key, s.label, s.ord, s.prob, s.closed, s.won, CURRENT_TIMESTAMP
FROM "organizations" o
CROSS JOIN (VALUES
    ('discovery',   'Discovery',      0, 20,  false, false),
    ('proposal',    'Proposal',       1, 45,  false, false),
    ('negotiation', 'Negotiation',    2, 65,  false, false),
    ('contract',    'Contract Sent',  3, 85,  false, false),
    ('won',         'Won',            4, 100, true,  true),
    ('lost',        'Lost',           5, 0,   true,  false)
) AS s(key, label, ord, prob, closed, won);

-- 3. Add the new FK column (nullable for now, backfilled next).
ALTER TABLE "deals" ADD COLUMN "stageId" TEXT;

-- 4. Backfill: every deal's old enum value maps to its own org's newly-seeded row with the
-- same key. Total by construction — step 2 seeded all 6 keys for every org that could possibly
-- own a deal.
UPDATE "deals" d
SET "stageId" = ps."id"
FROM "pipeline_stages" ps
WHERE ps."orgId" = d."orgId" AND ps."key" = d."stage"::text;

-- 5. Now that every row has a value, enforce it, index it, and wire the FK.
ALTER TABLE "deals" ALTER COLUMN "stageId" SET NOT NULL;
CREATE INDEX "deals_orgId_stageId_idx" ON "deals"("orgId", "stageId");
ALTER TABLE "deals" ADD CONSTRAINT "deals_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "pipeline_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6. Drop the old column, its index, and the enum type it depended on.
DROP INDEX "deals_orgId_stage_idx";
ALTER TABLE "deals" DROP COLUMN "stage";
DROP TYPE "DealStage";
