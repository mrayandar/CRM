-- Additive: a Payment gets a descriptive label (defaulting every existing row to 'Other', so
-- nothing changes for data already in the table), and its dueDate becomes optional — a payment
-- can now be "awaiting milestone" (no calendar date yet, just tied to work completing).

-- CreateEnum
CREATE TYPE "PaymentLabel" AS ENUM ('Advance', 'Milestone', 'Final', 'Other');

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "label" "PaymentLabel" NOT NULL DEFAULT 'Other';
ALTER TABLE "payments" ALTER COLUMN "dueDate" DROP NOT NULL;
