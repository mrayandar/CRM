-- AlterTable
-- Soft-delete flag for Owner — see the field comment in schema.prisma for why this is a soft
-- delete rather than a real one (every FK to owners is ON DELETE RESTRICT). Existing rows all
-- default to true, which is correct: every current Owner is, by definition, still active.
ALTER TABLE "owners" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
