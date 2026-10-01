-- Additive: introduce the Company entity and nullable companyId FKs on
-- Lead/Contact/Deal, alongside their existing `company` string column (which
-- is left untouched here). A later migration drops the string columns and
-- makes companyId required, once the backfill is verified lossless.

CREATE TABLE "companies" (
    "id"        TEXT NOT NULL,
    "orgId"     TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "website"   TEXT,
    "industry"  TEXT,
    "notes"     TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "companies_orgId_idx" ON "companies"("orgId");
CREATE INDEX "companies_orgId_name_idx" ON "companies"("orgId", "name");

ALTER TABLE "leads" ADD COLUMN "companyId" TEXT;
ALTER TABLE "contacts" ADD COLUMN "companyId" TEXT;
ALTER TABLE "deals" ADD COLUMN "companyId" TEXT;

CREATE INDEX "leads_orgId_companyId_idx" ON "leads"("orgId", "companyId");
CREATE INDEX "contacts_orgId_companyId_idx" ON "contacts"("orgId", "companyId");
CREATE INDEX "deals_orgId_companyId_idx" ON "deals"("orgId", "companyId");

ALTER TABLE "leads" ADD CONSTRAINT "leads_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deals" ADD CONSTRAINT "deals_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
