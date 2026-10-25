export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/** Same subject-type routing ActivityStream.tsx's subjectHref already uses, for the notification
 *  bell's click-through (PageShell.tsx) — a deal has no per-record detail page, so it goes to
 *  the Pipeline board; a task likewise has none, so it goes to the Tasks list (nowhere more
 *  specific to send it). Kept here, not in PageShell.tsx (a 'use client' component file), so it's
 *  unit-testable without a DOM — this repo's vitest setup runs in plain Node, no jsdom. */
export function notificationHref(item: {
  subjectType: 'lead' | 'contact' | 'deal' | 'task' | null
  subjectId: string | null
}): string | null {
  if (item.subjectType === 'lead' && item.subjectId) return `/leads/${item.subjectId}`
  if (item.subjectType === 'contact' && item.subjectId) return `/contacts/${item.subjectId}`
  if (item.subjectType === 'deal') return '/pipeline'
  if (item.subjectType === 'task') return '/tasks'
  return null
}

/**
 * The list an assignment picker (New lead/contact/deal/task's Owner field, Reassign, a task's
 * Assignee) should offer — active owners, plus the record's CURRENT owner even if they've since
 * gone inactive, so an edit modal's existing selection still has a matching `<option>` and
 * doesn't silently blank out. Never used for a FILTER dropdown ("All owners" on a list screen) —
 * those need every owner who's ever owned something, active or not, to stay useful for finding
 * their past records. See PROGRESS.md's "Deliberately not built in this pass" note on
 * Owner.active for why a new assignment and an unchanged existing one need different rules.
 */
export function assignableOwners<T extends { id: string; active: boolean }>(
  owners: T[],
  currentOwnerId?: string,
): T[] {
  return owners.filter((o) => o.active || o.id === currentOwnerId)
}

/** $148,000 (or the org's own currency — pass `orgCurrency` from `useCrm()`; defaults to USD only
 *  for the rare caller that genuinely has no org context, e.g. a pure unit test). */
export function currency(value: number, currencyCode = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
    maximumFractionDigits: 0,
  }).format(value)
}

/** $148K — for metric tiles and column headers where space is tight. Same currency-code param as
 *  `currency()`. */
export function currencyCompact(value: number, currencyCode = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
    notation: 'compact',
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(value)
}

/** Just the symbol/prefix ("$", "PKR", "AED", ...) with no number — for input-field prefixes that
 *  show a bare dollar sign today. Pulled from the same Intl formatter `currency()` uses, so it's
 *  exactly what a 0-value `currency()` call would show, minus the digits. */
export function currencySymbol(currencyCode = 'USD'): string {
  const parts = new Intl.NumberFormat('en-US', { style: 'currency', currency: currencyCode }).formatToParts(0)
  return parts.find((p) => p.type === 'currency')?.value ?? currencyCode
}

export function percent(value: number, fractionDigits = 0): string {
  return `${value.toFixed(fractionDigits)}%`
}

export function initialsOf(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('')
}

const DAY = 86_400_000

export function startOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

/** Whole days from today to the given date. Negative means the past. */
export function dayDelta(iso: string): number {
  const then = startOfDay(new Date(iso)).getTime()
  const today = startOfDay(new Date()).getTime()
  return Math.round((then - today) / DAY)
}

/**
 * The one definition of "weighted pipeline value" for a deal — used by Dashboard's funnel tile
 * and Pipeline's per-column total, which used to each write out `(d.value * d.probability) / 100`
 * inline. No date/timezone sensitivity (pure arithmetic on two numbers already on the deal).
 */
export function weightedValue(deal: { value: number; probability: number }): number {
  return (deal.value * deal.probability) / 100
}

/** "2h ago", "Yesterday", "Sep 12" */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  const diff = Date.now() - then
  const minutes = Math.round(diff / 60_000)

  if (diff < 0) {
    const delta = dayDelta(iso)
    if (delta === 0) return 'Later today'
    if (delta === 1) return 'Tomorrow'
    return `in ${delta}d`
  }
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = -dayDelta(iso)
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return formatDate(iso)
}

/** "Sep 12" or "Sep 12, 2025" when the year differs from today's. */
export function formatDate(iso: string): string {
  const d = new Date(iso)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  })
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return `${formatDate(iso)} · ${d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })}`
}

export function formatDateLong(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

/** "Overdue by 2d" / "Due today" / "Due in 5d" */
export function dueLabel(iso: string): { text: string; tone: 'overdue' | 'today' | 'soon' | 'later' } {
  const delta = dayDelta(iso)
  if (delta < 0) return { text: delta === -1 ? 'Overdue by 1d' : `Overdue by ${-delta}d`, tone: 'overdue' }
  if (delta === 0) return { text: 'Due today', tone: 'today' }
  if (delta === 1) return { text: 'Due tomorrow', tone: 'soon' }
  if (delta <= 7) return { text: `Due in ${delta}d`, tone: 'soon' }
  return { text: formatDate(iso), tone: 'later' }
}

/**
 * Reinterprets a calendar-date field (stored as midnight UTC of the day picked — true of
 * Lead.followUpAt) as a plain local Date carrying the identical year/month/day, by reading the
 * stored value's UTC components directly rather than letting `new Date(iso)` + a local-time
 * method (`setHours`, `getDate`, `toLocaleDateString` with no explicit zone) reinterpret it
 * through the *viewer's* offset. That reinterpretation is exactly the bug this works around: for
 * any viewer west of UTC (most of the Americas), midnight UTC of a date already fell on the
 * previous local evening, so `new Date(iso).toLocaleDateString()` silently shows one calendar day
 * earlier than what was actually picked. The value this returns is safe to feed directly into
 * `toLocaleDateString()`/`getFullYear()` etc. — its *local* y/m/d already equal the stored date,
 * so no further conversion can shift it again.
 */
export function asCalendarDate(iso: string): Date {
  const stored = new Date(iso)
  return new Date(stored.getUTCFullYear(), stored.getUTCMonth(), stored.getUTCDate())
}

/** Whole days from the viewer's own local today to the calendar date `iso` represents — see
 *  `asCalendarDate`'s doc comment for why this isn't just `dayDelta(iso)`. */
export function calendarDayDelta(iso: string): number {
  const then = asCalendarDate(iso).getTime()
  const today = startOfDay(new Date()).getTime()
  return Math.round((then - today) / DAY)
}

/** Same shape as `dueLabel`, for a calendar-date field — see `asCalendarDate`. */
export function calendarDueLabel(iso: string): { text: string; tone: 'overdue' | 'today' | 'soon' | 'later' } {
  const delta = calendarDayDelta(iso)
  if (delta < 0) return { text: delta === -1 ? 'Overdue by 1d' : `Overdue by ${-delta}d`, tone: 'overdue' }
  if (delta === 0) return { text: 'Due today', tone: 'today' }
  if (delta === 1) return { text: 'Due tomorrow', tone: 'soon' }
  if (delta <= 7) return { text: `Due in ${delta}d`, tone: 'soon' }
  const asLocal = asCalendarDate(iso)
  const sameYear = asLocal.getFullYear() === new Date().getFullYear()
  return {
    text: asLocal.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' }),
    tone: 'later',
  }
}

/** A lead whose status is one of these is done — a follow-up date on it is stale, not pending. */
export const CLOSED_LEAD_STATUSES: readonly string[] = ['lost', 'unqualified']

/**
 * Whether a lead's follow-up date should count as "due" anywhere in the app — used by the Leads
 * screen's "Follow-up due" filter today, and by Stage C's server-side lead_follow_up notification
 * generation (which can't import this directly, since it reads a Prisma row, not this frontend
 * Lead shape — but must encode the identical exclusion: status check against the same closed set,
 * and "already converted" via the row's own convertedDeal/convertedContact relations). A
 * converted lead, or one in a closed status, is done regardless of what its follow-up date says.
 */
export function isLeadFollowUpDue(lead: {
  followUpAt?: string | null
  status: string
  convertedDealId?: string
  convertedContactId?: string
}): boolean {
  if (!lead.followUpAt) return false
  if (lead.convertedDealId || lead.convertedContactId) return false
  if (CLOSED_LEAD_STATUSES.includes(lead.status)) return false
  return calendarDayDelta(lead.followUpAt) <= 0
}

export function groupBy<T, K extends string>(items: T[], key: (item: T) => K): Record<K, T[]> {
  return items.reduce((acc, item) => {
    const k = key(item)
    ;(acc[k] ||= []).push(item)
    return acc
  }, {} as Record<K, T[]>)
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0)
}

/**
 * The one correct definition of "received"/"collected" for Payments: sums only rows whose
 * `status` is `paid`. Deliberately keyed off `status`, never off `paidAt` being set — a payment
 * that was paid and then cancelled keeps `paidAt` (see `cancelPayment` in lib/data/payments.ts,
 * which keeps it on purpose so the history reads "paid on X, then cancelled") but must never count
 * toward a received total again. Every place that sums received money must call this, not
 * re-derive its own filter, so a future summary tile/card can't reintroduce the same bug.
 */
export function receivedTotal(payments: Array<{ status: string; amount: number }>): number {
  return sum(payments.filter((p) => p.status === 'paid').map((p) => p.amount))
}

/**
 * The one correct definition of "overdue" for a Payment: `pending`, has a `dueDate` at all, and
 * that date is in the past (day-level, same comparison dayDelta/dueLabel use for tasks). A
 * payment with no `dueDate` — "awaiting milestone", tied to work completing rather than a
 * calendar date — can never be overdue by definition; this function is the only place that rule
 * needs to be correct, rather than every caller re-deriving it.
 */
export function isPaymentOverdue(payment: { status: string; dueDate?: string | null }): boolean {
  return payment.status === 'pending' && !!payment.dueDate && dayDelta(payment.dueDate) < 0
}

/** A pending payment with no `dueDate` yet — waiting on a milestone, not a date. */
export function isAwaitingMilestone(payment: { status: string; dueDate?: string | null }): boolean {
  return payment.status === 'pending' && !payment.dueDate
}

/**
 * Splits `total` into `percents.length` whole-unit integer parts that always sum to exactly
 * `total`: every part but the last is `floor(total * percent / 100)`, and the last absorbs
 * whatever rounding remainder is left over (positive or, with heavily-skewed percentages,
 * occasionally negative-but-still-reconciling) — so a "Split into installments" action never
 * leaves the parts a cent short of (or over) the deal's actual value.
 */
export function splitAmounts(total: number, percents: number[]): number[] {
  if (percents.length === 0) return []
  const parts = percents.slice(0, -1).map((p) => Math.floor((total * p) / 100))
  const remainder = total - sum(parts)
  return [...parts, remainder]
}

/**
 * Whether a deal that was just confirmed moved into Won should trigger the "set up payments"
 * prompt. False for anyone without payment access (a Member's `payments` is always `[]` and this
 * check isn't even the thing that hides it from them — the whole prompt/dialog never renders for
 * them, see AppLayout — but this is the one place both conditions are decided, so neither call
 * site can independently get one of them wrong). False if the deal already has any payment row —
 * re-winning a reopened deal that already has payments doesn't re-prompt.
 */
export function shouldPromptWonPaymentSetup({
  canAccessPayments,
  dealId,
  payments,
}: {
  canAccessPayments: boolean
  dealId: string
  payments: Array<{ dealId: string }>
}): boolean {
  if (!canAccessPayments) return false
  return !payments.some((p) => p.dealId === dealId)
}

export function sortBy<T>(items: T[], value: (item: T) => number | string, dir: 'asc' | 'desc' = 'asc'): T[] {
  const factor = dir === 'asc' ? 1 : -1
  return [...items].sort((a, b) => {
    const av = value(a)
    const bv = value(b)
    if (av === bv) return 0
    return (av > bv ? 1 : -1) * factor
  })
}

/** Stable pseudo-random from a string id — keeps generated timelines consistent. */
export function seededRandom(seed: string): () => number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return () => {
    h ^= h << 13
    h ^= h >>> 17
    h ^= h << 5
    return ((h >>> 0) % 100000) / 100000
  }
}

/**
 * A real phone number (e.g. "+1 555 010 0199") legitimately starts with `+` — the exact character
 * this app's formula-injection guard would otherwise treat as an injection attempt. Deliberately
 * gated on a leading `+` specifically, not `-`: a bare leading `-` is how a negative-number-shaped
 * injection attempt (e.g. "-1+1") looks, never how a real phone number is written, so it still gets
 * neutralized below. The body (after the `+`) allows only digits/spaces/parens/dots/dashes — a
 * payload like "+=cmd" or "+1,=1+1" fails this (the second char class rejects `=`/`,`) and still
 * gets neutralized.
 */
const PHONE_SHAPE_RE = /^\+[\d\s().-]*\d[\d\s().-]*$/

/**
 * A cell starting with `=`, `+`, `-`, or `@` is interpreted as a formula by Excel/Sheets when the
 * CSV is opened — a lead/contact/company name or note containing one (typed by any rep, or an
 * attacker seeding a record precisely to exploit whoever exports it later) would otherwise execute
 * on open. Prefixing with a single quote neutralizes it in every spreadsheet app. The one
 * deliberate exception is a value that's unambiguously phone-shaped (see `PHONE_SHAPE_RE`) — this
 * check is content-based, not field-based, since `csvCell` has no idea which column it's rendering.
 */
function neutralizeFormula(s: string): string {
  if (!/^[=+\-@]/.test(s)) return s
  if (PHONE_SHAPE_RE.test(s)) return s
  return `'${s}`
}

export function csvCell(value: unknown): string {
  const s = neutralizeFormula(value == null ? '' : String(value))
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Builds a CSV from row objects and triggers a browser download. Client-side only — the rows
 * passed in are whatever's currently filtered/visible on screen, so the export always matches
 * what the user is looking at.
 */
export function exportCsv(filename: string, rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) return
  const headers = Object.keys(rows[0]!)
  const lines = [
    headers.join(','),
    ...rows.map((row) => headers.map((h) => csvCell(row[h])).join(',')),
  ]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Real month-over-month % change. Returns null — render as "not enough data yet", never a
 * fabricated number — when there's nothing meaningful to compare against (no prior-period value).
 */
export function momDelta(current: number, previous: number): number | null {
  if (previous <= 0) return null
  return ((current - previous) / previous) * 100
}
