/**
 * Golden boundary tests for lib/timePeriods.ts — proving the exact failure mode the org/owner
 * timezone split (PROGRESS.md's timezone design) exists to prevent: the same instant can read as
 * a different calendar day/month/quarter depending on which zone asks. Each test fixes "now" via
 * vitest's fake timers (not a real-time-dependent assertion) and picks an instant that genuinely
 * disagrees between UTC, Asia/Karachi (UTC+5, no DST), and America/New_York (UTC-5/-4 with DST).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dayDeltaInZone,
  isClosingSoon,
  isInCurrentQuarter,
  isMonthsAgo,
  isTaskDueToday,
  isTaskOverdue,
  isThisMonth,
} from '@lib/timePeriods'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('dayDeltaInZone — midnight boundary disagreement', () => {
  it('Asia/Karachi (UTC+5): being ahead means it can call the same instant "yesterday" while UTC still calls it "today"', () => {
    // now = 2026-01-31T21:00:00Z → UTC today is Jan 31; Karachi local is Feb 1 02:00, so
    // Karachi's today is Feb 1.
    vi.setSystemTime(new Date('2026-01-31T21:00:00.000Z'))
    const target = '2026-01-31T01:00:00.000Z' // UTC: still Jan 31 ("today"); Karachi local:
    // Jan 31 06:00 — a full day before Karachi's "today" (Feb 1), so "yesterday" there.

    expect(dayDeltaInZone(target, 'UTC')).toBe(0) // today, by UTC's clock
    expect(dayDeltaInZone(target, 'Asia/Karachi')).toBe(-1) // yesterday, by Karachi's clock
  })

  it('a task due at that exact instant is due today by UTC but already overdue by Karachi', () => {
    vi.setSystemTime(new Date('2026-01-31T21:00:00.000Z'))
    const task = { dueDate: '2026-01-31T01:00:00.000Z' }

    expect(isTaskDueToday(task, 'UTC')).toBe(true)
    expect(isTaskOverdue(task, 'UTC')).toBe(false)
    expect(isTaskOverdue(task, 'Asia/Karachi')).toBe(true)
    expect(isTaskDueToday(task, 'Asia/Karachi')).toBe(false)
  })

  it('America/New_York (UTC-5 in January, standard time): the same instant disagrees the other way', () => {
    // now = 2026-01-15T02:00:00Z → UTC today is Jan 15; NY local is Jan 14 21:00, so NY's
    // today is Jan 14.
    vi.setSystemTime(new Date('2026-01-15T02:00:00.000Z'))
    const target = '2026-01-14T23:00:00.000Z' // NY local: Jan 14 18:00 → NY's "today"

    expect(dayDeltaInZone(target, 'UTC')).toBe(-1) // yesterday, by UTC's clock
    expect(dayDeltaInZone(target, 'America/New_York')).toBe(0) // today, by NY's clock
  })

  it('a task due at that instant is overdue by UTC but due today by New York', () => {
    vi.setSystemTime(new Date('2026-01-15T02:00:00.000Z'))
    const task = { dueDate: '2026-01-14T23:00:00.000Z' }

    expect(isTaskOverdue(task, 'UTC')).toBe(true)
    expect(isTaskOverdue(task, 'America/New_York')).toBe(false)
    expect(isTaskDueToday(task, 'America/New_York')).toBe(true)
  })
})

describe('isThisMonth / isMonthsAgo — month boundary disagreement', () => {
  it('Asia/Karachi rolls into the next month before UTC does', () => {
    // now = 2026-02-28T20:30:00Z → UTC's current month is Feb; Karachi local is March 1
    // 01:30, so Karachi's current month is already March.
    vi.setSystemTime(new Date('2026-02-28T20:30:00.000Z'))
    const closeDate = '2026-02-27T20:00:00.000Z' // Karachi local: Feb 28 01:00 → still February

    expect(isThisMonth(closeDate, 'UTC')).toBe(true) // Feb, same as UTC's current Feb
    expect(isThisMonth(closeDate, 'Asia/Karachi')).toBe(false) // Karachi is already in March
    expect(isMonthsAgo(closeDate, 1, 'Asia/Karachi')).toBe(true) // "last month" from Karachi's view
  })

  it('America/New_York stays in the previous month after UTC has already rolled over', () => {
    // now = 2026-03-01T02:00:00Z → UTC's current month is March; NY local is Feb 28 21:00,
    // so NY's current month is still February.
    vi.setSystemTime(new Date('2026-03-01T02:00:00.000Z'))
    const closeDate = '2026-02-28T20:00:00.000Z' // UTC: Feb 28 (last month, for UTC); NY local:
    // Feb 28 15:00 — still February, the SAME month NY's own "now" is in.

    expect(isThisMonth(closeDate, 'UTC')).toBe(false) // UTC's current month is already March
    expect(isMonthsAgo(closeDate, 1, 'UTC')).toBe(true) // "last month" by UTC's clock
    expect(isThisMonth(closeDate, 'America/New_York')).toBe(true) // still February for NY
    expect(isMonthsAgo(closeDate, 1, 'America/New_York')).toBe(false) // it's THIS month for NY, not last
  })
})

describe('isInCurrentQuarter — quarter boundary disagreement (also exercises US DST)', () => {
  it('UTC has already rolled into Q2 while New York (daylight time, UTC-4) is still in Q1', () => {
    // now = 2026-04-01T02:00:00Z → UTC's current quarter is Q2 (Apr-Jun); NY local (April =
    // daylight time, UTC-4) is March 31 22:00, so NY's current quarter is still Q1 (Jan-Mar).
    vi.setSystemTime(new Date('2026-04-01T02:00:00.000Z'))
    const closeDate = '2026-03-31T23:00:00.000Z' // NY local: March 31 19:00 → still Q1

    expect(isInCurrentQuarter(closeDate, 'UTC')).toBe(false) // already rolled into Q2 by UTC
    expect(isInCurrentQuarter(closeDate, 'America/New_York')).toBe(true) // still Q1 for NY
  })
})

describe('isClosingSoon — uses the same zone-aware day math as the task boundary tests', () => {
  it('a deal closing right at a Karachi/UTC-disagreeing midnight is counted consistently with dayDeltaInZone', () => {
    vi.setSystemTime(new Date('2026-01-31T21:00:00.000Z'))
    const deal = { closeDate: '2026-01-31T01:00:00.000Z' } // UTC's "today", Karachi's "yesterday"

    // Already-overdue-by-a-day still counts as "closing soon" (isClosingSoon's own rule — see
    // its doc comment); the point here is it's zone-aware, not that it's 0 either way.
    expect(isClosingSoon(deal, 'UTC')).toBe(true)
    expect(isClosingSoon(deal, 'Asia/Karachi')).toBe(true)
    expect(dayDeltaInZone(deal.closeDate, 'UTC')).toBe(0)
    expect(dayDeltaInZone(deal.closeDate, 'Asia/Karachi')).toBe(-1)
  })
})
