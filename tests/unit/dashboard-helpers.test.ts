/**
 * Unit coverage for the helpers extracted off Dashboard.tsx/Sidebar.tsx/Pipeline.tsx's previously
 * inline, duplicated math — weightedValue (src/lib/utils.ts, no timezone sensitivity) and
 * isTaskOverdue/isTaskDueToday/isClosingSoon (lib/timePeriods.ts, now timezone-parameterized —
 * see tests/unit/time-periods.test.ts for the timezone-specific coverage; these use 'UTC' since
 * they're only testing the day-window logic, not zone handling).
 */
import { describe, expect, it } from 'vitest'
import { weightedValue } from '@/lib/utils'
import { isClosingSoon, isTaskDueToday, isTaskOverdue } from '@lib/timePeriods'

const DAY = 86_400_000
const isoDaysFromNow = (days: number) => new Date(Date.now() + days * DAY).toISOString()

describe('weightedValue', () => {
  it('is value * probability / 100', () => {
    expect(weightedValue({ value: 10_000, probability: 30 })).toBe(3_000)
  })
  it('is 0 at 0% probability, and the full value at 100%', () => {
    expect(weightedValue({ value: 5_000, probability: 0 })).toBe(0)
    expect(weightedValue({ value: 5_000, probability: 100 })).toBe(5_000)
  })
})

describe('isTaskOverdue', () => {
  it('is true for yesterday, false for today and tomorrow', () => {
    expect(isTaskOverdue({ dueDate: isoDaysFromNow(-1) }, 'UTC')).toBe(true)
    expect(isTaskOverdue({ dueDate: isoDaysFromNow(0) }, 'UTC')).toBe(false)
    expect(isTaskOverdue({ dueDate: isoDaysFromNow(1) }, 'UTC')).toBe(false)
  })
})

describe('isTaskDueToday', () => {
  it('is true only for today', () => {
    expect(isTaskDueToday({ dueDate: isoDaysFromNow(0) }, 'UTC')).toBe(true)
    expect(isTaskDueToday({ dueDate: isoDaysFromNow(-1) }, 'UTC')).toBe(false)
    expect(isTaskDueToday({ dueDate: isoDaysFromNow(1) }, 'UTC')).toBe(false)
  })
})

describe('isClosingSoon', () => {
  it('defaults to a 30-day window', () => {
    expect(isClosingSoon({ closeDate: isoDaysFromNow(29) }, 'UTC')).toBe(true)
    expect(isClosingSoon({ closeDate: isoDaysFromNow(30) }, 'UTC')).toBe(true)
    expect(isClosingSoon({ closeDate: isoDaysFromNow(31) }, 'UTC')).toBe(false)
  })
  it('counts an already-overdue close date as "closing soon" too, same as Dashboard\'s card', () => {
    expect(isClosingSoon({ closeDate: isoDaysFromNow(-5) }, 'UTC')).toBe(true)
  })
  it('respects a custom window', () => {
    expect(isClosingSoon({ closeDate: isoDaysFromNow(10) }, 'UTC', 7)).toBe(false)
    expect(isClosingSoon({ closeDate: isoDaysFromNow(5) }, 'UTC', 7)).toBe(true)
  })
})
