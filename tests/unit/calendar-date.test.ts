/**
 * Lead.followUpAt (and any other field following the same "calendar date stored as midnight
 * UTC" convention) must display as the SAME calendar day for every viewer, regardless of their
 * own timezone offset. A plain `new Date(iso).toLocaleDateString()`/`.getDate()` reinterprets the
 * stored UTC instant through the *viewer's* local offset — for anyone west of UTC (most of the
 * Americas), midnight UTC of a date already fell on the previous local evening, silently showing
 * one calendar day earlier than what was actually picked. Verified manually against a real
 * Intl-simulated America/Los_Angeles viewer during Stage A's review: a lead's follow-up date
 * stored as "2026-07-01T00:00:00.000Z" displayed as "6/30/2026" under
 * `toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' })` — exactly the bug this
 * guards against. asCalendarDate/calendarDueLabel/calendarDayDelta read the stored value's UTC
 * year/month/day directly and are deterministic regardless of which machine/timezone runs this
 * test — their own local getters are only ever applied to the *already-corrected* value.
 */
import { describe, expect, it } from 'vitest'
import { asCalendarDate, calendarDayDelta, calendarDueLabel, isLeadFollowUpDue } from '@/lib/utils'

describe('asCalendarDate', () => {
  it('resolves to the UTC calendar day, never reinterpreted through this process\'s own timezone', () => {
    const d = asCalendarDate('2026-07-01T00:00:00.000Z')
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 6, 1]) // July is month 6, 0-indexed
  })

  it('is stable across a year boundary (Dec 31 stays Dec 31, not Jan 1 or Dec 30)', () => {
    const d = asCalendarDate('2026-12-31T00:00:00.000Z')
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 11, 31])
  })
})

describe('calendarDayDelta', () => {
  it('is 0 for a date matching today\'s own calendar day', () => {
    const today = new Date()
    const iso = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())).toISOString()
    expect(calendarDayDelta(iso)).toBe(0)
  })
})

describe('calendarDueLabel', () => {
  it('formats a far-future date using its own stored calendar day, not a shifted one', () => {
    const future = new Date(Date.UTC(new Date().getFullYear() + 2, 2, 15)) // March 15, two years out
    const label = calendarDueLabel(future.toISOString())
    expect(label.text).toMatch(/Mar 15/)
  })
})

describe('isLeadFollowUpDue', () => {
  const dueToday = new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())).toISOString()
  const overdue = '2020-01-01T00:00:00.000Z'

  it('is true for an open lead whose follow-up date is today or overdue', () => {
    expect(isLeadFollowUpDue({ followUpAt: dueToday, status: 'new' })).toBe(true)
    expect(isLeadFollowUpDue({ followUpAt: overdue, status: 'contacted' })).toBe(true)
  })

  it('is false with no follow-up date at all', () => {
    expect(isLeadFollowUpDue({ followUpAt: null, status: 'new' })).toBe(false)
  })

  it('is false for a closed-status lead (lost/unqualified), even when overdue', () => {
    expect(isLeadFollowUpDue({ followUpAt: overdue, status: 'lost' })).toBe(false)
    expect(isLeadFollowUpDue({ followUpAt: overdue, status: 'unqualified' })).toBe(false)
  })

  it('is false for a converted lead (has a deal or a contact), even when overdue', () => {
    expect(isLeadFollowUpDue({ followUpAt: overdue, status: 'qualified', convertedDealId: 'd1' })).toBe(false)
    expect(isLeadFollowUpDue({ followUpAt: overdue, status: 'qualified', convertedContactId: 'c1' })).toBe(false)
  })

  it('is false for a future follow-up date, even on an otherwise-eligible lead', () => {
    const future = new Date(Date.UTC(new Date().getFullYear() + 1, 0, 1)).toISOString()
    expect(isLeadFollowUpDue({ followUpAt: future, status: 'new' })).toBe(false)
  })
})
