-- AlterTable
-- Nullable: no quota has been set for any existing org, and the Dashboard is expected to show an
-- honest "set a quota" prompt for that case rather than treating an absent value as zero.
ALTER TABLE "organizations" ADD COLUMN "quarterlyQuota" INTEGER;
