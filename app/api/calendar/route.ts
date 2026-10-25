import { NextResponse } from 'next/server'
import { requireAuth } from '@lib/auth'
import { listTasksForCalendar } from '@lib/data/tasks'
import { listLeadFollowUpsForCalendar } from '@lib/data/leads'
import { listOpenDealsForCalendar } from '@lib/data/deals'
import type { Scope } from '@lib/scope'

/**
 * Powers the Calendar screen's month grid + agenda panel — tasks, lead follow-ups, and open
 * deals' expected close dates, merged into one list. Deliberately NOT drawn from the
 * CrmProvider arrays already in the client (unlike most of this app's UI): a month view routinely
 * needs dates outside what `loadCrmData` ever fetches in bulk, and re-fetching this one range on
 * every month navigation is far cheaper than loading every task/lead/deal an org has ever had.
 *
 * Route Handler, not a Server Action — same reasoning as GET /api/crm-refetch: avoids Next's
 * action-dispatch queue, so navigating months or refocusing the tab never queues behind an
 * unrelated mutation in flight.
 *
 * `from`/`to` are "YYYY-MM-DD" calendar dates (the same convention `Task.dueDate`/
 * `Lead.followUpAt`/`Deal.closeDate` already store their own values in — UTC midnight of the
 * picked day), parsed with `new Date(ymd)` so the inclusive range comparison in each data-layer
 * query lines up exactly with how those columns were written, with no viewer-timezone conversion
 * needed on the fetch itself (the per-viewer "is this today/overdue" distinction happens
 * client-side, via localDayDelta, same as everywhere else calendar dates are displayed).
 *
 * No payments: Payments is admin-only and intentionally excluded from the calendar in v1, not an
 * oversight — see this feature's own design note and canAccessPayments's existing gating
 * elsewhere in this app. Nothing here even imports lib/data/payments.
 *
 * EXPLAIN ANALYZE against the real Neon DB: the lead and deal queries each use their own
 * dedicated index (`leads_orgId_ownerId_followUpAt_idx`, `deals_orgId_ownerId_closeDate_idx` —
 * the latter new, alongside this feature) via an Index Scan. The task query is a Seq Scan — same
 * documented caveat as Stage C's identical finding on this table: `tasks` is tiny (~25-50 rows
 * total today), so the planner correctly prefers a sequential scan over any index at this size;
 * it would use the existing `tasks_orgId_ownerId_done_idx`/`tasks_orgId_createdById_idx` once the
 * table grows large enough to matter.
 */
export const dynamic = 'force-dynamic'

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_RANGE_DAYS = 62
const DAY_MS = 24 * 60 * 60 * 1000

export interface CalendarItemDTO {
  id: string
  kind: 'task' | 'lead_follow_up' | 'deal_close'
  /** "YYYY-MM-DD" — see this route's own doc comment on why it's a plain calendar-date string,
   *  not an ISO instant: it removes any chance of the client re-deriving the wrong day via a
   *  local-time Date method, the exact bug Stage A's sign-off check found and fixed elsewhere. */
  date: string
  title: string
  done?: boolean
  subjectType: 'task' | 'lead' | 'deal'
  subjectId: string
}

function utcYmd(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** "YYYY-MM-DD" and a real calendar date — rejects "2026-02-30" the same way `new Date(...)`
 *  would silently roll over into March, which `isNaN` alone wouldn't catch for every malformed
 *  case (e.g. "2026-13-01" DOES produce an Invalid Date, but a few bad combinations don't). */
function parseYmd(value: string | null): Date | null {
  if (!value || !YMD_RE.test(value)) return null
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return null
  if (utcYmd(date) !== value) return null // e.g. "2026-02-30" rolled over to March
  return date
}

export async function GET(request: Request) {
  let scope: Scope
  try {
    const { orgId, scopeOwnerId } = await requireAuth()
    scope = { orgId, scopeOwnerId }
  } catch {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401, headers: NO_STORE_HEADERS })
  }

  const params = new URL(request.url).searchParams
  const from = parseYmd(params.get('from'))
  const to = parseYmd(params.get('to'))
  if (!from || !to || from.getTime() > to.getTime()) {
    return NextResponse.json({ error: 'Invalid range' }, { status: 400, headers: NO_STORE_HEADERS })
  }
  const rangeDays = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1
  if (rangeDays > MAX_RANGE_DAYS) {
    return NextResponse.json({ error: 'Range too large' }, { status: 400, headers: NO_STORE_HEADERS })
  }

  const [tasks, leadFollowUps, deals] = await Promise.all([
    listTasksForCalendar(scope, from, to),
    listLeadFollowUpsForCalendar(scope, from, to),
    listOpenDealsForCalendar(scope, from, to),
  ])

  const items: CalendarItemDTO[] = [
    ...tasks.map((t) => ({
      id: `task:${t.id}`, kind: 'task' as const, date: utcYmd(t.dueDate), title: t.title, done: t.done,
      subjectType: 'task' as const, subjectId: t.id,
    })),
    ...leadFollowUps.map((l) => ({
      id: `lead_follow_up:${l.id}`, kind: 'lead_follow_up' as const, date: utcYmd(l.followUpAt), title: l.name,
      subjectType: 'lead' as const, subjectId: l.id,
    })),
    ...deals.map((d) => ({
      id: `deal_close:${d.id}`, kind: 'deal_close' as const, date: utcYmd(d.closeDate), title: d.name,
      subjectType: 'deal' as const, subjectId: d.id,
    })),
  ]

  return NextResponse.json({ items }, { headers: NO_STORE_HEADERS })
}
