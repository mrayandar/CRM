/**
 * localDayDelta compares a calendar date against the recipient's own local "today" — never raw
 * instant arithmetic. The case that actually distinguishes the two: right around midnight UTC, a
 * recipient in a zone already past midnight is living in a different calendar day than one who
 * isn't, even though both are being asked about at the exact same instant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localDayDelta } from '@lib/timezones'

describe('localDayDelta', () => {
  afterEach(() => vi.useRealTimers())

  it('returns 0 (due today) for a same-day date in UTC with no time-of-day confusion', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-05T12:00:00Z'))
    expect(localDayDelta('2026-03-05T00:00:00.000Z', 'UTC')).toBe(0)
  })

  it('returns -1 for yesterday and 1 for tomorrow, in UTC', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-05T12:00:00Z'))
    expect(localDayDelta('2026-03-04T00:00:00.000Z', 'UTC')).toBe(-1)
    expect(localDayDelta('2026-03-06T00:00:00.000Z', 'UTC')).toBe(1)
  })

  describe('right at the UTC midnight boundary — the case that actually needs timezone awareness', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      // 23:58 UTC on March 5 — already March 6 in Asia/Karachi (UTC+5), still March 5 in
      // America/Los_Angeles (UTC-8 in March, before US DST starts that year on March 8).
      vi.setSystemTime(new Date('2026-03-05T23:58:00Z'))
    })

    it('a date stored as March 6 reads as "due today" (delta 0) for a Karachi recipient', () => {
      expect(localDayDelta('2026-03-06T00:00:00.000Z', 'Asia/Karachi')).toBe(0)
    })

    it('the exact same stored date reads as "due tomorrow" (delta 1) for an LA recipient, at the same instant', () => {
      expect(localDayDelta('2026-03-06T00:00:00.000Z', 'America/Los_Angeles')).toBe(1)
    })

    it('a date stored as March 5 already reads as "overdue by 1 day" (delta -1) for Karachi', () => {
      expect(localDayDelta('2026-03-05T00:00:00.000Z', 'Asia/Karachi')).toBe(-1)
    })

    it('the same March 5 date still reads as "due today" (delta 0) for LA, at the same instant', () => {
      expect(localDayDelta('2026-03-05T00:00:00.000Z', 'America/Los_Angeles')).toBe(0)
    })
  })
})
