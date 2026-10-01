-- Cutover: the Company backfill (20261001150000) has been verified lossless
-- against real data (every Lead/Contact/Deal linked, zero orphans, zero
-- cross-org leakage). Drop the old `company` string columns and make
-- `companyId` required.

-- Contact had an index on the old string column; replaced by the
-- (orgId, companyId) index added in the previous migration.
DROP INDEX "contacts_orgId_company_idx";

ALTER TABLE "leads" DROP COLUMN "company";
ALTER TABLE "contacts" DROP COLUMN "company";
ALTER TABLE "deals" DROP COLUMN "company";

ALTER TABLE "leads" ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "contacts" ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "deals" ALTER COLUMN "companyId" SET NOT NULL;
