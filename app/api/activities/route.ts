import { NextResponse } from 'next/server'
import { requireAuth, canAccessPayments } from '@lib/auth'
import { getLeadById } from '@lib/data/leads'
import { getContactById } from '@lib/data/contacts'
import { getDealById } from '@lib/data/deals'
import { listActivitiesForSubject } from '@lib/data/activities'
import { mapActivity } from '@lib/mappers'
import type { Scope } from '@lib/scope'

/**
 * One record's own activity history, paginated — powers RecordDetail's Activity and Notes tabs.
 * Not the dashboard feed (that stays on GET /api/crm-refetch's capped, org-wide `activities`,
 * unchanged). See listActivitiesForSubject's doc comment for the bug this replaces: the old
 * per-record timeline used to filter that same capped array, so any record whose activity wasn't
 * among the org's 50 most recent overall silently showed an incomplete or empty timeline.
 *
 * A Route Handler, not a Server Action, for the same measured reason GET /api/crm-refetch is one
 * — see that route's doc comment. `requireAuth()` + `canAccessPayments()` gives this identical
 * role/tenant gating to first load, by construction, same as that route.
 *
 * Status codes, unlike crm-refetch's uniform 401: 401 means only "no valid session" — the one
 * case a client should treat as its own auth having gone stale. Everything else (a cross-tenant
 * subject, one that doesn't exist, bad params, or any other failure once a session is confirmed)
 * is a 404. The two are never distinguished further within each bucket — a cross-tenant subject
 * and a nonexistent one both just 404, so a client can't use this to probe which ids exist in
 * another org.
 */
export const dynamic = 'force-dynamic'

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

const SUBJECT_TYPES = ['lead', 'contact', 'deal'] as const
type SubjectType = (typeof SUBJECT_TYPES)[number]

function isSubjectType(value: string | null): value is SubjectType {
  return value !== null && (SUBJECT_TYPES as readonly string[]).includes(value)
}

export async function GET(request: Request) {
  let scope: Scope
  try {
    const { orgId, scopeOwnerId } = await requireAuth()
    scope = { orgId, scopeOwnerId }
  } catch {
    // The one case that gets a 401 — no valid session, same meaning as crm-refetch's 401.
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401, headers: NO_STORE_HEADERS })
  }

  try {
    const params = new URL(request.url).searchParams
    const subjectType = params.get('subjectType')
    const subjectId = params.get('subjectId')
    const cursor = params.get('cursor') ?? undefined
    if (!isSubjectType(subjectType) || !subjectId) throw new Error('Invalid subject')

    // The subject must belong to this org AND (once scoped) to this caller — same scoped by-id
    // read, same rejection as a cross-tenant id, as everywhere else in the app. Never leaks
    // "found in another org/owner" vs. "doesn't exist at all": both just fall through to the
    // catch below as the same 404. Once this passes, every activity attached to the subject is
    // already known to share its current owner (see listActivitiesForSubject's doc comment), so
    // no separate scope filter is needed on the activities query itself.
    const subject =
      subjectType === 'lead'
        ? await getLeadById(scope, subjectId)
        : subjectType === 'contact'
          ? await getContactById(scope, subjectId)
          : await getDealById(scope, subjectId)
    if (!subject) throw new Error('Subject not found')

    const includePayments = await canAccessPayments()
    const { rows, nextCursor } = await listActivitiesForSubject(
      scope,
      { type: subjectType, id: subjectId },
      { cursor, excludeKinds: includePayments ? [] : ['payment'] },
    )

    return NextResponse.json(
      { activities: rows.map(mapActivity), nextCursor },
      { headers: NO_STORE_HEADERS },
    )
  } catch {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE_HEADERS })
  }
}
