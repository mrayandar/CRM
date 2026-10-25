/**
 * The Calendar screen's task-creation prefill passes the clicked day cell's own "YYYY-MM-DD"
 * straight into NewTaskModal's `defaultDueDate` — see Calendar.tsx and NewTaskModal.tsx's own doc
 * comments. This covers the piece that actually produces that string: `calendarYmd`/
 * `calendarMonthGrid` (src/lib/utils.ts), both built entirely from `Date.UTC`/`getUTC*` — never a
 * local-time method — so the exact same cell produces the exact same "YYYY-MM-DD" no matter what
 * timezone the process (or a real viewer's browser) happens to be in. Verified directly under
 * both Asia/Karachi and America/Los_Angeles via Node's own `TZ` env var, not just asserted by
 * code-reading.
 */
import { describe, expect, it } from 'vitest'
import { calendarMonthGrid, calendarYmd } from '@/lib/utils'

function withTz<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ
  process.env.TZ = tz
  try {
    return fn()
  } finally {
    process.env.TZ = prev
  }
}

describe('calendarYmd / calendarMonthGrid: timezone-independent by construction', () => {
  it('a November day cell round-trips to the exact same "YYYY-MM-DD" under Asia/Karachi and America/Los_Angeles', () => {
    const novemberStart = new Date(Date.UTC(2026, 10, 1)) // month is 0-indexed: 10 = November
    const dayFromKarachi = withTz('Asia/Karachi', () => {
      const grid = calendarMonthGrid(novemberStart)
      const cell = grid.find((d) => d.getUTCDate() === 15 && d.getUTCMonth() === 10)!
      return calendarYmd(cell)
    })
    const dayFromLA = withTz('America/Los_Angeles', () => {
      const grid = calendarMonthGrid(novemberStart)
      const cell = grid.find((d) => d.getUTCDate() === 15 && d.getUTCMonth() === 10)!
      return calendarYmd(cell)
    })
    expect(dayFromKarachi).toBe('2026-11-15')
    expect(dayFromLA).toBe('2026-11-15')
    expect(dayFromKarachi).toBe(dayFromLA)
  })

  it('the grid always starts on a Monday, regardless of timezone', () => {
    const novemberStart = new Date(Date.UTC(2026, 10, 1))
    for (const tz of ['Asia/Karachi', 'America/Los_Angeles']) {
      withTz(tz, () => {
        const grid = calendarMonthGrid(novemberStart)
        expect(grid[0].getUTCDay()).toBe(1) // Monday
        expect(grid.length).toBe(42)
      })
    }
  })
})
