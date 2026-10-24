import { NextResponse } from 'next/server'
import { requireAuth } from '@lib/auth'
import { getUnreadCount } from '@lib/data/notifications'

/**
 * Polled ~60s by the bell (see src/store/crm.tsx's live poll) — kept as cheap as possible: a
 * single indexed COUNT, `getUnreadCount`, scoped to the caller's own orgId + recipientId (never
 * anyone else's). Route Handler, not a Server Action — same reasoning as GET /api/crm-refetch:
 * avoids Next's action-dispatch queue so a frequent poll never serializes behind/ahead of a
 * mutation in flight.
 *
 * `force-dynamic` + an explicit `Cache-Control: private, no-store` header, same two independent
 * guarantees as crm-refetch's route — this is one recipient's own unread count, never cacheable by
 * anything that could hand it to a different user.
 *
 * EXPLAIN ANALYZE against the real Neon DB (200 seeded rows, 20 unread) confirmed Postgres uses
 * `notifications_orgId_recipientId_readAt_idx` (added alongside the Notification model) via an
 * Index Only Scan for this exact where-clause shape — not a sequential scan.
 */
export const dynamic = 'force-dynamic'

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

export async function GET() {
  try {
    const { orgId, ownerId } = await requireAuth()
    const count = await getUnreadCount(orgId, ownerId)
    return NextResponse.json({ count }, { headers: NO_STORE_HEADERS })
  } catch {
    return NextResponse.json({ error: 'unavailable' }, { status: 401, headers: NO_STORE_HEADERS })
  }
}
