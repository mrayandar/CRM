-- No schema.prisma change — these are DB-level trigram indexes Prisma Client doesn't need to
-- know about, created manually rather than via `prisma migrate dev` (there's no model diff to
-- generate). Speeds up the `contains`/`insensitive` searches already in lib/data/leads.ts,
-- contacts.ts, deals.ts, and companies.ts — see PROGRESS.md for the EXPLAIN before/after captured
-- against the synthetic org.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "leads_name_trgm_idx" ON "leads" USING gin ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "leads_email_trgm_idx" ON "leads" USING gin ("email" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "contacts_name_trgm_idx" ON "contacts" USING gin ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "contacts_email_trgm_idx" ON "contacts" USING gin ("email" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "deals_name_trgm_idx" ON "deals" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "companies_name_trgm_idx" ON "companies" USING gin ("name" gin_trgm_ops);
