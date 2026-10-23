-- NOTE: Prisma's diff generator wanted to also DROP the pg_trgm trigram indexes created by the
-- previous migration (20261023110512_pg_trgm_search_indexes) — those were added via raw SQL, not
-- through schema.prisma, so Prisma's schema-diff treats them as drift to remove. Deliberately
-- removed from this migration; they must stay.

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "timezoneConfigured" BOOLEAN NOT NULL DEFAULT false;
