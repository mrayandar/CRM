-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'UTC';

-- Migrate Owner.timezone's old free-text display labels to real IANA zone ids — the only values
-- that have ever existed in this column (the old Settings dropdown offered exactly these 4; see
-- lib/timezones.ts's LEGACY_TIMEZONE_LABEL_MAP for the same mapping, kept in application code in
-- case a stray legacy value needs handling at read time too). Anything else (including null)
-- is left untouched — in practice that's only null, confirmed before writing this migration.
UPDATE "owners" SET "timezone" = 'America/Los_Angeles' WHERE "timezone" = 'Pacific Time (US & Canada)';
UPDATE "owners" SET "timezone" = 'America/New_York' WHERE "timezone" = 'Eastern Time (US & Canada)';
UPDATE "owners" SET "timezone" = 'Europe/London' WHERE "timezone" = 'London (GMT)';
UPDATE "owners" SET "timezone" = 'Europe/Paris' WHERE "timezone" = 'Central European Time';
