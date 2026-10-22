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
 * `cache: 'no-store'` on the client's fetch (see crm.tsx) keeps this from ever being served from
 * Next's fetch cache — every call must re-run requireAuth() for real.
 */
export async function GET() {
  try {
    const { orgId, ownerId } = await requireAuth()
    const includePayments = await canAccessPayments()
    const data = await loadCrmData(orgId, ownerId, includePayments)
    return NextResponse.json(data)
  } catch {
    // Never redirects, never leaks why — requireAuth() throwing (deactivated Owner, no session,
    // etc.) and any other failure both just mean "the client should fail quietly and retry later."
    return NextResponse.json({ error: 'unavailable' }, { status: 401 })
  }
}
