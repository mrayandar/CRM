import { NextResponse } from 'next/server'
import { requireAuth } from '@lib/auth'
import { listNotifications } from '@lib/data/notifications'
import type { Scope } from '@lib/scope'

/**
 * Newest 50 of the caller's own notifications, titles built at read time (see
 * `listNotifications`/`buildTitle`) — never anything stored on the row itself. Same Route Handler
 * + no-store reasoning as GET /api/notifications/unread-count.
 */
export const dynamic = 'force-dynamic'

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

export async function GET() {
  try {
    const { orgId, ownerId, scopeOwnerId } = await requireAuth()
    const scope: Scope = { orgId, scopeOwnerId }
    const notifications = await listNotifications(scope, ownerId)
    return NextResponse.json({ notifications }, { headers: NO_STORE_HEADERS })
  } catch {
    return NextResponse.json({ error: 'unavailable' }, { status: 401, headers: NO_STORE_HEADERS })
  }
}
