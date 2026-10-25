-- CreateEnum
CREATE TYPE "AiCapability" AS ENUM ('draft_email', 'summarize', 'next_step');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "aiAssistEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "aiAssistEnabledChangedAt" TIMESTAMP(3),
ADD COLUMN     "aiAssistEnabledChangedBy" TEXT;

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "yearMonth" TEXT NOT NULL,
    "capability" "AiCapability" NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_rate_limit_counters" (
    "id" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ai_rate_limit_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "ai_usage_orgId_idx" ON "ai_usage"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_usage_orgId_yearMonth_capability_key" ON "ai_usage"("orgId", "yearMonth", "capability");

-- CreateIndex
CREATE UNIQUE INDEX "ai_rate_limit_counters_scopeType_scopeId_bucketStart_key" ON "ai_rate_limit_counters"("scopeType", "scopeId", "bucketStart");
