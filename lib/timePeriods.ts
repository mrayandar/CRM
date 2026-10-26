/**
 * Timezone-aware day/month/quarter boundary math — shared, dependency-free (pure `Intl`, no new
 * library), importable from both server and client code like lib/timezones.ts.
 *
 * Every `DateTime` column in prisma/schema.prisma, and which of the two kinds it is:
 *
 *  - **Calendar date** — a date someone chose or expects, compared as a date in a specific
 *    zone's calendar, never shifted by a clock time it doesn't really have:
 *    - `Task.dueDate` — when a task is due.
 *    - `Payment.dueDate` — when a payment is expected (nullable: null means "awaiting milestone,"
 *      tied to work completing rather than a date — never compared at all).
 *    - `Deal.closeDate` **while the deal is still open** — see below, it changes kind.
 *
 *  - **Instant** — a real moment something happened. "Which day/month/quarter did this fall in"
 *    still needs a zone to answer (midnight is a different instant in every zone), but the
 *    underlying value itself isn't "shifted" — it's a fixed point; the question is only which
 *    local calendar box it landed in for a given viewer:
 *    - `Owner.createdAt`/`updatedAt`, `Company.createdAt`/`updatedAt`,
 *      `Lead.createdAt`, `Contact.createdAt`, `Deal.createdAt`/`updatedAt`,
 *      `Payment.createdAt`/`updatedAt`, `Task.createdAt`/`updatedAt` — ordinary row timestamps.
 *    - `Lead.lastTouchedAt`, `Contact.lastInteractionAt` — bumped by `lib/data/activities.ts`'s
 *      `logActivity` whenever an activity is logged against that record; display-only
 *      ("2h ago"-style), never fed into any of this module's functions.
 *    - `Payment.paidAt` — stamped once, when a payment transitions to `paid`; never cleared even
 *      if later cancelled (see `cancelPayment` in `lib/data/payments.ts`) — `receivedTotal`
 *      excludes a cancelled payment by its `status`, never by this field.
 *    - `Activity.at` — when the activity happened; feeds the dashboard's recent-activity feed and
 *      a record's own timeline (`GET /api/activities`), neither of which currently buckets by
 *      day/month, so nothing here calls into this module for it yet.
 *    - `Deal.closeDate` **once the deal is Won or Lost** — see below.
 *
 * `Deal.closeDate` is the one column that's genuinely both, depending on the deal's own state:
 * while open, it holds an *expected* close date — a calendar date, not yet a real event, entered
 * by a rep against their own calendar. The moment a deal enters a Won (or Lost) stage,
 * `closeDateOnStageChange` (lib/data/deals.ts) stamps it to "now" — from that point on the same
 * column holds an instant (when the deal actually closed), not an expectation anymore. Every
 * "won this month"/"closing in 30 days" style comparison here already only ever reads it in the
 * state it's actually in (closed deals for "won", open deals for "closing soon"), so this isn't
 * a latent bug — just worth naming, since the column's meaning genuinely changes underneath it.
 *
 * Which zone a given comparison uses is a *rule*, not a per-call choice — see each function's own
 * doc comment for whether it's org-wide (Organization.timezone) or personal (Owner.timezone).
 */

/** "YYYY-MM-DD" for the given instant, as a calendar date in `timezone`. en-CA formats dates in
 *  that exact order, which is what makes this a clean, locale-independent extraction trick rather
 *  than a string someone might expect to display. */
function ymdInZone(date: Date, timezone: string): [number, number, number] {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
  const [y, m, d] = parts.split('-').map(Number)
  return [y!, m!, d!]
}

/** Midnight (00:00) on the given Y/M/D, as it would read on a clock in `timezone` — returned as
 *  the real UTC instant that midnight actually is. Two dates that read the same Y/M/D in the same
 *  zone produce the identical instant here, which is what makes a plain subtraction between two
 *  of these give a true calendar-day difference, not an instant difference skewed by whatever
 *  time of day each one happened to be at. */
function midnightInZone(y: number, m: number, d: number, timezone: string): number {
  // UTC as a first guess, then correct by however far that guess's own Y/M/D (read back in the
  // target zone) differs from the Y/M/D we actually want — this converges in one correction for
  // every real-world zone (all offsets are whole hours/half-hours/45-minutes, well under a day).
  const guess = Date.UTC(y, m - 1, d)
  const [gy, gm, gd] = ymdInZone(new Date(guess), timezone)
  const drift = Date.UTC(gy, gm - 1, gd) - Date.UTC(y, m - 1, d)
  return guess - drift
}

const DAY_MS = 86_400_000

/** Whole calendar days from "today" (in `timezone`) to `iso`, treated purely as a date — the
 *  timezone-aware equivalent of src/lib/utils.ts's `dayDelta` (which stays zone-naive, using
 *  whichever zone happens to be running the code, for every use that isn't one of the specific
 *  org-wide/personal rules below). */
export function dayDeltaInZone(iso: string, timezone: string): number {
  const [ty, tm, td] = ymdInZone(new Date(), timezone)
  const [iy, im, id] = ymdInZone(new Date(iso), timezone)
  return Math.round((midnightInZone(iy, im, id, timezone) - midnightInZone(ty, tm, td, timezone)) / DAY_MS)
}

/** Personal day boundary — a task's own due date is in the past, in the *viewer's* timezone
 *  (Owner.timezone, falling back to the browser's resolved zone while unset). */
export function isTaskOverdue(task: { dueDate: string }, viewerTimezone: string): boolean {
  return dayDeltaInZone(task.dueDate, viewerTimezone) < 0
}

/** Personal day boundary — same rule as isTaskOverdue, for "due today." */
export function isTaskDueToday(task: { dueDate: string }, viewerTimezone: string): boolean {
  return dayDeltaInZone(task.dueDate, viewerTimezone) === 0
}

/** Org-wide business period — a deal's (expected, while open) close date is within `withinDays`
 *  of today in the *org's* timezone (Organization.timezone) — "closing in 30 days" means the same
 *  thing for every rep looking at the same pipeline, regardless of where each of them sits. */
export function isClosingSoon(deal: { closeDate: string }, orgTimezone: string, withinDays = 30): boolean {
  return dayDeltaInZone(deal.closeDate, orgTimezone) <= withinDays
}

/** Org-wide business period — `iso` (an instant, once the deal/activity it belongs to is in a
 *  state where this comparison applies — see this file's own doc comment) falls in the current
 *  calendar month, in the org's timezone. */
export function isThisMonth(iso: string, orgTimezone: string): boolean {
  const [y, m] = ymdInZone(new Date(iso), orgTimezone)
  const [ny, nm] = ymdInZone(new Date(), orgTimezone)
  return y === ny && m === nm
}

/** Org-wide business period — `iso` falls in the calendar month exactly `monthsAgo` months
 *  before the current one (0 = this month, 1 = last month, ...), in the org's timezone. */
export function isMonthsAgo(iso: string, monthsAgo: number, orgTimezone: string): boolean {
  const [y, m] = ymdInZone(new Date(iso), orgTimezone)
  const [ny, nm] = ymdInZone(new Date(), orgTimezone)
  const targetMonthIndex = (ny * 12 + (nm - 1)) - monthsAgo
  const targetY = Math.floor(targetMonthIndex / 12)
  const targetM = (targetMonthIndex % 12) + 1
  return y === targetY && m === targetM
}

/** Org-wide business period — buckets already-won deals into calendar months (oldest to newest,
 *  `months` wide, including the current month) in the org's timezone, and sums their value per
 *  month. Every bucket in the window is present even when empty. */
export function monthlyWonRevenue(
  wonDeals: Array<{ value: number; closeDate: string }>,
  orgTimezone: string,
  months = 6,
): Array<{ month: string; value: number }> {
  const [ny, nm] = ymdInZone(new Date(), orgTimezone)
  const nowMonthIndex = ny * 12 + (nm - 1)
  const buckets = new Map<number, { month: string; value: number }>()
  for (let i = months - 1; i >= 0; i--) {
    const idx = nowMonthIndex - i
    const y = Math.floor(idx / 12)
    const m = idx % 12 // 0-based for toLocaleDateString below
    buckets.set(idx, {
      month: new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
      value: 0,
    })
  }
  for (const deal of wonDeals) {
    const [y, m] = ymdInZone(new Date(deal.closeDate), orgTimezone)
    const idx = y * 12 + (m - 1)
    const bucket = buckets.get(idx)
    if (bucket) bucket.value += deal.value
  }
  return [...buckets.values()]
}

const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

export interface FiscalQuarter {
  /** Inclusive start instant, as midnight of the quarter's first day in `orgTimezone`. */
  start: Date
  /** Exclusive end instant — midnight of the NEXT quarter's first day, same zone. */
  end: Date
  /** e.g. "Jul to Sep" — the 3 calendar months this fiscal quarter spans, regardless of fiscal
   *  year start month. Never includes the year: this is always "the current one." */
  label: string
}

const idxToYM = (idx: number): [number, number] => [Math.floor(idx / 12), (((idx % 12) + 12) % 12) + 1]

/** Absolute, 0-based month index (year*12 + month-1) of the first month of the fiscal quarter
 *  containing `now`, in `orgTimezone`, plus the (exclusive) index just past its last month.
 *  Pure month arithmetic, deliberately never routed through `midnightInZone`'s day-granularity
 *  math: `midnightInZone` only ever promises that two calls IN THE SAME ZONE, subtracted, give
 *  the right calendar-day difference (every existing caller in this file — isThisMonth,
 *  isClosingSoon, dayDeltaInZone — only ever uses it that way) — for a positive-UTC-offset zone
 *  its OWN return value is not the real UTC instant of local midnight, which an absolute
 *  timestamp comparison (what isInCurrentFiscalQuarter needs) would silently get wrong by a
 *  zone's own UTC offset. Comparing whole-month indices sidesteps that entirely: a fiscal quarter
 *  is always 3 whole calendar months, so there's no finer-than-a-month boundary to get wrong. */
function fiscalQuarterMonthRange(orgTimezone: string, fiscalYearStartMonth: number, now: Date): { startIdx: number; endIdx: number } {
  const [ny, nm] = ymdInZone(now, orgTimezone)
  const nowIdx = ny * 12 + (nm - 1)
  // How many whole months into the CURRENT fiscal year "now" falls, 0-11.
  const monthsIntoFiscalYear = ((nm - fiscalYearStartMonth) % 12 + 12) % 12
  const startIdx = nowIdx - (monthsIntoFiscalYear % 3)
  return { startIdx, endIdx: startIdx + 3 }
}

/**
 * The one shared helper every "what's the current quarter" computation in this app must go
 * through — see this module's own doc comment for the org-wide-vs-personal-zone rule this
 * follows (always `Organization.timezone`, never a viewer's own). `fiscalYearStartMonth` is
 * `Organization.fiscalYearStartMonth` (1-12, 1 = January) — a fiscal quarter is always 3 whole
 * calendar months starting from that month, same as a calendar quarter is 3 months starting from
 * January; this generalizes `isInCurrentQuarter`'s old hardcoded Jan/Apr/Jul/Oct boundaries,
 * which is exactly what a `fiscalYearStartMonth` of 1 still produces. `start`/`end` are for
 * display (the label, or formatting a date range) — `isInCurrentFiscalQuarter` below does its own
 * membership check via month indices, never by comparing against these two Dates directly.
 */
export function currentFiscalQuarter(orgTimezone: string, fiscalYearStartMonth: number, now: Date = new Date()): FiscalQuarter {
  const { startIdx, endIdx } = fiscalQuarterMonthRange(orgTimezone, fiscalYearStartMonth, now)
  const [sy, sm] = idxToYM(startIdx)
  const [ey, em] = idxToYM(endIdx)
  const [, lm] = idxToYM(endIdx - 1) // the quarter's own last month, for the label

  return {
    start: new Date(midnightInZone(sy, sm, 1, orgTimezone)),
    end: new Date(midnightInZone(ey, em, 1, orgTimezone)),
    label: `${MONTH_ABBR[sm - 1]} to ${MONTH_ABBR[lm - 1]}`,
  }
}

/** Org-wide business period — whether `iso` falls within the current fiscal quarter (inclusive of
 *  its start, exclusive of its end), in the org's timezone. Powers the quota card's
 *  quarter-to-date comparison. Compares whole-month indices, not instants — see
 *  `fiscalQuarterMonthRange`'s own doc comment for why. */
export function isInCurrentFiscalQuarter(iso: string, orgTimezone: string, fiscalYearStartMonth: number): boolean {
  const { startIdx, endIdx } = fiscalQuarterMonthRange(orgTimezone, fiscalYearStartMonth, new Date())
  const [iy, im] = ymdInZone(new Date(iso), orgTimezone)
  const isoIdx = iy * 12 + (im - 1)
  return isoIdx >= startIdx && isoIdx < endIdx
}
