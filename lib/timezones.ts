/**
 * Shared, dependency-free IANA timezone helpers — no `server-only`/Prisma import, so this is
 * importable from both server code (`@lib/timezones`) and client components (same path; `@lib`
 * just maps to this directory, see tsconfig's `paths`) without crossing the client/server split
 * the rest of `lib/` vs `src/lib/` otherwise keeps.
 */

/** The only values the old Settings dropdown ever offered, before it became a searchable list of
 *  real IANA ids — used once, in the migration that backfilled existing Owner.timezone rows.
 *  Kept here too (not just in the migration's raw SQL) in case a stray legacy value ever needs
 *  handling at read time. */
export const LEGACY_TIMEZONE_LABEL_MAP: Record<string, string> = {
  'Pacific Time (US & Canada)': 'America/Los_Angeles',
  'Eastern Time (US & Canada)': 'America/New_York',
  'London (GMT)': 'Europe/London',
  'Central European Time': 'Europe/Paris',
}

export const DEFAULT_ORG_TIMEZONE = 'UTC'

/** Every IANA zone id this runtime knows about. Falls back to the legacy map's 4 values on a
 *  runtime old enough to lack `Intl.supportedValuesOf` (Node 18 and all current browsers have
 *  it; this is defensive, not expected to actually trigger). */
export function listIanaTimezones(): string[] {
  if (typeof Intl.supportedValuesOf === 'function') {
    return Intl.supportedValuesOf('timeZone')
  }
  return Object.values(LEGACY_TIMEZONE_LABEL_MAP)
}

export function isValidIanaTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false
  try {
    // eslint-disable-next-line no-new -- constructing is the only way Intl exposes this check
    new Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** The browser/runtime's own resolved zone — used to default a new owner's profile value, and to
 *  pre-fill (not silently apply) the org timezone field while it's still at the untouched
 *  default. Never written automatically on anyone's behalf. */
export function resolveBrowserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * The zone every org-wide business-period calculation (won this month, quota progress, monthly
 * charts, MoM, closing in 30 days — see lib/timePeriods.ts) must actually use. `orgTimezone`
 * itself is only trustworthy once `orgTimezoneConfigured` is true (an admin has actually saved
 * one) — until then it's just the raw "UTC" column default, and using it would silently shift
 * every pre-existing org's month/day boundaries the moment this feature shipped, with no admin
 * having chosen anything. While unconfigured, this falls back to the *viewer's own* resolved
 * zone (their Owner.timezone, or the browser's if that's unset too) — the exact behavior every
 * org had before Organization.timezone existed at all.
 */
export function resolveOrgTimezone(input: {
  orgTimezone: string
  orgTimezoneConfigured: boolean
  viewerTimezone: string
}): string {
  return input.orgTimezoneConfigured ? input.orgTimezone : input.viewerTimezone
}

const DAY_MS = 86_400_000

/** "YYYY-MM-DD" as the given instant reads in `timezone` — `en-CA` is the one standard locale
 *  whose formatted output is already exactly that shape, with no further parsing. */
function ymdInZone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

/**
 * Whole calendar days from the recipient's *local* today (in `timezone`) to the calendar date
 * `iso` represents — negative means that date has already passed for them. Deliberately not
 * instant arithmetic: a Task.dueDate/Lead.followUpAt is a calendar date, stored as UTC midnight
 * of whatever date was picked (an HTML date input's "YYYY-MM-DD" parses that way) — reading its
 * UTC year/month/day back out recovers the exact picked date regardless of the caller's own
 * zone, which then gets compared against "today" as computed in the *recipient's* zone, not the
 * server's or the caller's. This is what makes the comparison correct right around midnight: at
 * 23:58 UTC, a recipient in Asia/Karachi (UTC+5) is already living in tomorrow, and this returns
 * one day earlier than a same-moment comparison in, say, America/Los_Angeles (UTC-7/8) would.
 */
export function localDayDelta(iso: string, timezone: string): number {
  const storedYmd = ymdInZone(new Date(iso), 'UTC')
  const todayYmd = ymdInZone(new Date(), timezone)
  const storedMs = new Date(`${storedYmd}T00:00:00Z`).getTime()
  const todayMs = new Date(`${todayYmd}T00:00:00Z`).getTime()
  return Math.round((storedMs - todayMs) / DAY_MS)
}
