import 'server-only'

import { randomUUID } from 'node:crypto'
import { prisma } from '@lib/prisma'

export type AiRateLimitScopeType = 'user_hour' | 'org_hour' | 'org_month'

// Every row here is naturally bounded by a cap — a brand-new row per org/user per hour/month,
// forever — with nothing that ever deletes an old one on its own. Left alone, the table grows by
// roughly (distinct users + orgs) * (hours + months) rows forever. Pruned lazily, inside the same
// reserveSlot every request already calls, rather than a separate cron (there's no scheduler in
// this app yet — see PROGRESS.md's Vercel-cron note) — gated by a low probability so the extra
// DELETE only runs on roughly 1 in 100 calls, not every one. The `LIMIT` keeps each individual
// prune bounded and cheap even if the table has fallen far behind; it would just take a few more
// 1-in-100 draws to fully catch up, never one slow request blocking on an unbounded delete.
const STALE_ROW_MAX_AGE_MS = 48 * 60 * 60 * 1000
const CLEANUP_PROBABILITY = 0.01
const CLEANUP_BATCH_LIMIT = 500

async function maybePruneStaleCounters(): Promise<void> {
  if (Math.random() >= CLEANUP_PROBABILITY) return
  const cutoff = new Date(Date.now() - STALE_ROW_MAX_AGE_MS)
  try {
    await prisma.$executeRaw`
      DELETE FROM "ai_rate_limit_counters"
      WHERE "id" IN (
        SELECT "id" FROM "ai_rate_limit_counters" WHERE "bucketStart" < ${cutoff} LIMIT ${CLEANUP_BATCH_LIMIT}
      )
    `
  } catch {
    // Best-effort maintenance, never allowed to fail the real request it rode in on.
  }
}

/** Start of the UTC hour containing `now`. */
export function hourBucketStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()))
}

/** Start of the UTC month containing `now`. */
export function monthBucketStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

/**
 * Atomically reserves one slot for `(scopeType, scopeId, bucketStart)` against `cap`, via a
 * single INSERT ... ON CONFLICT DO UPDATE ... WHERE "requestCount" < cap ... RETURNING statement.
 *
 * Postgres semantics make this race-free without an application-level lock: the first request for
 * a bucket has no existing row, so the plain INSERT branch always succeeds (requestCount starts
 * at 1) and RETURNING always yields a row. Every later request for the same bucket hits the ON
 * CONFLICT branch; if the WHERE clause is false (already at cap), that row is left untouched and
 * RETURNING yields NO row at all for that statement — not "0 rows updated" silently merged with
 * "succeeded", an actual empty result set this function can distinguish. Two concurrent requests
 * racing a cap of 1 therefore can never both get a row back: Postgres serializes the two INSERT
 * statements against the same unique key, and only one of them observes requestCount still below
 * cap at the moment it runs.
 *
 * Returns true if the slot was reserved, false if the cap was already reached.
 */
export async function reserveSlot(
  scopeType: AiRateLimitScopeType,
  scopeId: string,
  bucketStart: Date,
  cap: number,
): Promise<boolean> {
  await maybePruneStaleCounters()
  const rows = await prisma.$queryRaw<Array<{ requestCount: number }>>`
    INSERT INTO "ai_rate_limit_counters" ("id", "scopeType", "scopeId", "bucketStart", "requestCount")
    VALUES (${randomUUID()}, ${scopeType}, ${scopeId}, ${bucketStart}, 1)
    ON CONFLICT ("scopeType", "scopeId", "bucketStart")
    DO UPDATE SET "requestCount" = "ai_rate_limit_counters"."requestCount" + 1
    WHERE "ai_rate_limit_counters"."requestCount" < ${cap}
    RETURNING "requestCount"
  `
  return rows.length > 0
}

/**
 * Gives back a slot reserved by `reserveSlot` for a request that never completed successfully
 * (the provider errored, timed out, or the request failed after reservation but before a result)
 * — an unauthorized or invalid request never calls this because it never reserved a slot to begin
 * with (see the generate route's check order). Floors at 0, so a stray double-refund can never
 * push a counter negative and manufacture extra headroom.
 */
export async function refundSlot(scopeType: AiRateLimitScopeType, scopeId: string, bucketStart: Date): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "ai_rate_limit_counters"
    SET "requestCount" = "requestCount" - 1
    WHERE "scopeType" = ${scopeType} AND "scopeId" = ${scopeId} AND "bucketStart" = ${bucketStart} AND "requestCount" > 0
  `
}
