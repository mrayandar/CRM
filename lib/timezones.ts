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
