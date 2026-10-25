import 'server-only'

import type { AiCapability } from '@prisma/client'
import { prisma } from '@lib/prisma'

function utcYearMonth(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Records a successful provider call's token counts against the org's monthly, per-capability
 * usage row — metering only, never a cap check (see lib/ai/rateLimiter.ts for that). A plain
 * upsert-and-increment is safe here: unlike cap reservation, there is no "two concurrent writers
 * must not both pass a threshold" property to protect, just an accurate running total, and
 * Postgres serializes the two statements against the same unique key regardless.
 */
export async function recordAiUsage(
  orgId: string,
  capability: AiCapability,
  inputTokens: number,
  outputTokens: number,
  now: Date = new Date(),
): Promise<void> {
  const yearMonth = utcYearMonth(now)
  await prisma.aiUsage.upsert({
    where: { orgId_yearMonth_capability: { orgId, yearMonth, capability } },
    create: { orgId, yearMonth, capability, requestCount: 1, inputTokens, outputTokens },
    update: { requestCount: { increment: 1 }, inputTokens: { increment: inputTokens }, outputTokens: { increment: outputTokens } },
  })
}
