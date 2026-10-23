import { NextResponse } from 'next/server'
import { requireAuth, canAccessPayments } from '@lib/auth'
import { loadCrmData } from '@lib/data-loader'

/**
 * Powers CrmProvider's live-update refetch (src/store/crm.tsx, src/store/livePoll.ts) — the same
 * requireAuth() + canAccessPayments() + loadCrmData() the (app) layout calls on first load, so
 * this gets identical role/tenant gating to first load by construction.
 *
 * A plain Route Handler, not a Server Action, specifically to avoid a real, measured problem: a
 * Next.js Server Action invoked from the client goes through Next's own action-dispatch queue,
 * which serializes concurrent action calls from the same client — a mutation (e.g. moveDealAction)
 * started while a Server Action refetch was in flight did not even have its network request sent
 * until the refetch's response came back, adding the refetch's full ~3-4s to the mutation's own
 * latency. A Route Handler is a plain fetch() to a URL, outside that queue entirely, so a mutation
 * fired while this is in flight goes out immediately and the two run genuinely concurrently.
 *
 * `cache: 'no-store'` on the client's fetch (see crm.tsx) keeps Next's own client-side fetch cache
 * from ever reusing this — but says nothing about shared/intermediary caches (a browser's disk
 * cache, a corporate proxy, a CDN in front of this deployment). This response is one org's data,
 * including Payment rows for an admin — it must never be cacheable by anything that could hand
 * that response to a *different* user. Two explicit, independent guarantees against that:
 * `dynamic = 'force-dynamic'` (never statically optimized/cached by Next itself, regardless of
 * whether a dynamic API is detected) and an explicit `Cache-Control: private, no-store` response
 * header (so no shared cache between here and the browser is allowed to store or reuse it either).
 */
export const dynamic = 'force-dynamic'

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

export async function GET() {
  try {
    const { orgId, ownerId, scopeOwnerId } = await requireAuth()
    const includePayments = await canAccessPayments()
    const data = await loadCrmData({ orgId, scopeOwnerId }, ownerId, includePayments)
    return NextResponse.json(data, { headers: NO_STORE_HEADERS })
  } catch {
    // Never redirects, never leaks why — requireAuth() throwing (deactivated Owner, no session,
    // etc.) and any other failure both just mean "the client should fail quietly and retry later."
    return NextResponse.json({ error: 'unavailable' }, { status: 401, headers: NO_STORE_HEADERS })
  }
}
