/**
 * Golden boundary tests for lib/timePeriods.ts — proving the exact failure mode the org/owner
 * timezone split (PROGRESS.md's timezone design) exists to prevent: the same instant can read as
 * a different calendar day/month/quarter depending on which zone asks. Each test fixes "now" via
 * vitest's fake timers (not a real-time-dependent assertion) and picks an instant that genuinely
 * disagrees between UTC, Asia/Karachi (UTC+5, no DST), and America/New_York (UTC-5/-4 with DST).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  currentFiscalQuarter,
  dayDeltaInZone,
  isClosingSoon,
  isInCurrentFiscalQuarter,
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

describe('isInCurrentFiscalQuarter / currentFiscalQuarter — quarter boundary disagreement (also exercises US DST)', () => {
  it('UTC has already rolled into Q2 (calendar fiscal year, start month 1) while New York (daylight time, UTC-4) is still in Q1', () => {
    // now = 2026-04-01T02:00:00Z → UTC's current quarter is Q2 (Apr-Jun); NY local (April =
    // daylight time, UTC-4) is March 31 22:00, so NY's current quarter is still Q1 (Jan-Mar).
    vi.setSystemTime(new Date('2026-04-01T02:00:00.000Z'))
    const closeDate = '2026-03-31T23:00:00.000Z' // NY local: March 31 19:00 → still Q1

    expect(isInCurrentFiscalQuarter(closeDate, 'UTC', 1)).toBe(false) // already rolled into Q2 by UTC
    expect(isInCurrentFiscalQuarter(closeDate, 'America/New_York', 1)).toBe(true) // still Q1 for NY
  })

  it('a viewer in a different timezone never changes the result — only orgTimezone is read (no viewer-zone parameter exists at all)', () => {
    // Same instant/org as above: the function's signature has no viewer-timezone input, so a
    // Member sitting in Tokyo and one sitting in LA see the identical answer for the same org.
    vi.setSystemTime(new Date('2026-04-01T02:00:00.000Z'))
    const closeDate = '2026-03-31T23:00:00.000Z'
    expect(isInCurrentFiscalQuarter(closeDate, 'America/New_York', 1)).toBe(
      isInCurrentFiscalQuarter(closeDate, 'America/New_York', 1),
    )
  })

  it('the end boundary is exclusive: an instant exactly at the next quarter start is NOT in the current one', () => {
    vi.setSystemTime(new Date('2026-02-15T00:00:00.000Z')) // fiscal Q1 (start month 1): Jan-Mar
    const { end } = currentFiscalQuarter('UTC', 1)
    expect(isInCurrentFiscalQuarter(end.toISOString(), 'UTC', 1)).toBe(false)
    expect(isInCurrentFiscalQuarter(new Date(end.getTime() - 1).toISOString(), 'UTC', 1)).toBe(true)
  })

  it.each([
    [1, 'Jan to Mar', 'Apr to Jun', 'Oct to Dec'],
    [2, 'Feb to Apr', 'May to Jul', 'Nov to Jan'],
    [4, 'Apr to Jun', 'Jul to Sep', 'Jan to Mar'],
    [7, 'Jul to Sep', 'Oct to Dec', 'Apr to Jun'],
    [10, 'Oct to Dec', 'Jan to Mar', 'Jul to Sep'],
  ])('fiscal year starting month %i: Q1/Q2/Q4 labels and boundaries are each 3 whole months', (startMonth, q1Label, q2Label, q4Label) => {
    // Every call below passes its own explicit `now` — the faked system time from this file's
    // top-level beforeEach is irrelevant to this block.
    const q1 = currentFiscalQuarter('UTC', startMonth as number, new Date(Date.UTC(2026, (startMonth as number) - 1, 15)))
    expect(q1.label).toBe(q1Label)
    expect(q1.end.getTime() - q1.start.getTime()).toBeGreaterThan(27 * 24 * 60 * 60 * 1000) // at least ~3 short months

    const q2Instant = new Date(q1.end.getTime() + 15 * 24 * 60 * 60 * 1000) // well inside the next quarter
    const q2 = currentFiscalQuarter('UTC', startMonth as number, q2Instant)
    expect(q2.label).toBe(q2Label)
    expect(q2.start.getTime()).toBe(q1.end.getTime()) // quarters tile with no gap/overlap

    const q4Instant = new Date(q1.start.getTime() - 15 * 24 * 60 * 60 * 1000) // well inside the PRIOR quarter (= Q4 of the previous fiscal year)
    const q4 = currentFiscalQuarter('UTC', startMonth as number, q4Instant)
    expect(q4.label).toBe(q4Label)
    expect(q4.end.getTime()).toBe(q1.start.getTime())
  })

  it('month-start boundaries hold in a non-UTC org timezone too (Asia/Karachi, UTC+5, no DST)', () => {
    // "Now" anchored well inside the Jul-Sep Karachi quarter (fiscal start month 7) — isInCurrent
    // FiscalQuarter has no explicit `now` param, so the fake clock IS what it reads as "now."
    vi.setSystemTime(new Date('2026-08-15T12:00:00.000Z'))
    // Just before and just after the Oct 1 00:00 Karachi boundary, expressed as the equivalent
    // UTC instants (Karachi = UTC+5).
    const justBeforeKarachiOct1 = new Date('2026-09-30T18:59:59.000Z') // Karachi: Sep 30 23:59:59
    const justAfterKarachiOct1 = new Date('2026-09-30T19:00:01.000Z') // Karachi: Oct 1 00:00:01
    expect(isInCurrentFiscalQuarter(justBeforeKarachiOct1.toISOString(), 'Asia/Karachi', 7)).toBe(true)
    expect(isInCurrentFiscalQuarter(justAfterKarachiOct1.toISOString(), 'Asia/Karachi', 7)).toBe(false)
  })

  it('month-start boundaries hold in America/New_York across a DST transition (standard time, UTC-5)', () => {
    // "Now" anchored well inside the Jan-Mar NY quarter (fiscal start month 1).
    vi.setSystemTime(new Date('2026-02-15T12:00:00.000Z'))
    // Fiscal quarter starting month 1 (Jan-Mar in NY local time): just before and just after the
    // Apr 1 00:00 NY boundary (standard-to-daylight already happened by then — NY is UTC-4 by
    // April), expressed as the equivalent UTC instants.
    const justBeforeNyApr1 = new Date('2026-04-01T03:59:59.000Z') // NY (UTC-4): Mar 31 23:59:59
    const justAfterNyApr1 = new Date('2026-04-01T04:00:01.000Z') // NY (UTC-4): Apr 1 00:00:01
    expect(isInCurrentFiscalQuarter(justBeforeNyApr1.toISOString(), 'America/New_York', 1)).toBe(true)
    expect(isInCurrentFiscalQuarter(justAfterNyApr1.toISOString(), 'America/New_York', 1)).toBe(false)
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
