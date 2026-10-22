import { NextResponse } from 'next/server'
import { requireAuth, canAccessPayments } from '@lib/auth'
import { getLeadById } from '@lib/data/leads'
import { getContactById } from '@lib/data/contacts'
import { getDealById } from '@lib/data/deals'
import { listActivitiesForSubject } from '@lib/data/activities'
import { mapActivity } from '@lib/mappers'

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
 */
export const dynamic = 'force-dynamic'

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

const SUBJECT_TYPES = ['lead', 'contact', 'deal'] as const
type SubjectType = (typeof SUBJECT_TYPES)[number]

function isSubjectType(value: string | null): value is SubjectType {
  return value !== null && (SUBJECT_TYPES as readonly string[]).includes(value)
}

export async function GET(request: Request) {
  try {
    const { orgId } = await requireAuth()

    const params = new URL(request.url).searchParams
    const subjectType = params.get('subjectType')
    const subjectId = params.get('subjectId')
    const cursor = params.get('cursor') ?? undefined
    if (!isSubjectType(subjectType) || !subjectId) throw new Error('Invalid subject')

    // The subject must belong to this org — same scoped by-id read, same rejection as a
    // cross-tenant id, as everywhere else in the app. Never leaks "found in another org" vs.
    // "doesn't exist at all": both just fall through to the catch below.
    const subject =
      subjectType === 'lead'
        ? await getLeadById(orgId, subjectId)
        : subjectType === 'contact'
          ? await getContactById(orgId, subjectId)
          : await getDealById(orgId, subjectId)
    if (!subject) throw new Error('Subject not found')

    const includePayments = await canAccessPayments()
    const { rows, nextCursor } = await listActivitiesForSubject(
      orgId,
      { type: subjectType, id: subjectId },
      { cursor, excludeKinds: includePayments ? [] : ['payment'] },
    )

    return NextResponse.json(
      { activities: rows.map(mapActivity), nextCursor },
      { headers: NO_STORE_HEADERS },
    )
  } catch {
    // Never leaks why — bad/missing params, no session, a cross-tenant or nonexistent subject,
    // and any other failure all just mean "the client should fail quietly and retry later," same
    // philosophy as GET /api/crm-refetch.
    return NextResponse.json({ error: 'unavailable' }, { status: 401, headers: NO_STORE_HEADERS })
  }
}
