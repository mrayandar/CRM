import 'server-only'

import { randomUUID } from 'node:crypto'
import { prisma } from '@lib/prisma'

export type AiRateLimitScopeType = 'user_hour' | 'org_hour' | 'org_month'

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
