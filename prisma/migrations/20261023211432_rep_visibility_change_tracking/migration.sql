-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "repVisibilityChangedAt" TIMESTAMP(3),
ADD COLUMN     "repVisibilityChangedBy" TEXT;
