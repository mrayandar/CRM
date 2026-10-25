import { NextResponse } from 'next/server'
import { requireAuth } from '@lib/auth'
import { getUnreadCount, scanAndNotify } from '@lib/data/notifications'

/**
 * Polled ~60s by the bell (see src/store/crm.tsx's live poll) — kept as cheap as possible on the
 * common path: a single indexed COUNT, `getUnreadCount`, scoped to the caller's own orgId +
 * recipientId (never anyone else's). Route Handler, not a Server Action — same reasoning as
 * GET /api/crm-refetch: avoids Next's action-dispatch queue so a frequent poll never serializes
 * behind/ahead of a mutation in flight.
 *
 * `force-dynamic` + an explicit `Cache-Control: private, no-store` header, same two independent
 * guarantees as crm-refetch's route — this is one recipient's own unread count, never cacheable by
 * anything that could hand it to a different user.
 *
 * EXPLAIN ANALYZE against the real Neon DB (200 seeded rows, 20 unread) confirmed Postgres uses
 * `notifications_orgId_recipientId_readAt_idx` (added alongside the Notification model) via an
 * Index Only Scan for this exact where-clause shape — not a sequential scan.
 *
 * `scanAndNotify` runs here, not in GET /api/notifications — this is the endpoint polled every
 * ~60s, so it's the natural trigger for the no-cron scan (see its own doc comment in
 * lib/data/notifications.ts). It's awaited before the count is read, so a notification it just
 * wrote shows up in THIS same response, not the next poll a minute later. On every call beyond
 * the first one per 5 minutes it does only its own atomic claim UPDATE (0 rows affected) and
 * returns immediately — the cost on the common path is one extra indexed write attempt, not a
 * full scan.
 */
export const dynamic = 'force-dynamic'

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

export async function GET() {
  try {
    const { orgId, ownerId } = await requireAuth()
    await scanAndNotify(orgId, ownerId)
    const count = await getUnreadCount(orgId, ownerId)
    return NextResponse.json({ count }, { headers: NO_STORE_HEADERS })
  } catch {
    return NextResponse.json({ error: 'unavailable' }, { status: 401, headers: NO_STORE_HEADERS })
  }
}
