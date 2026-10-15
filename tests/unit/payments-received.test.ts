/**
 * Pure-function regression guard for Payments math: "received"/"collected" totals (the per-deal
 * banner, the Dashboard card, and the Pipeline deal-card progress bar all call receivedTotal() —
 * there is no separate implementation anywhere to re-test), overdue/awaiting-milestone
 * classification, and installment-split rounding.
 *
 * The receivedTotal bug this guards against: a payment that was marked paid and then cancelled
 * keeps its `paidAt` (see cancelPayment in lib/data/payments.ts, which keeps it on purpose so the
 * history reads "paid on X, then cancelled") — summing by `paidAt` truthiness instead of
 * `status === 'paid'` would double-count or wrongly include it.
 */
import { describe, expect, it } from 'vitest'
import { isAwaitingMilestone, isPaymentOverdue, receivedTotal, splitAmounts } from '@/lib/utils'

describe('receivedTotal', () => {
  it('sums only status === "paid" rows', () => {
    const payments = [
      { status: 'paid', amount: 100 },
      { status: 'pending', amount: 200 },
      { status: 'cancelled', amount: 300 },
    ]
    expect(receivedTotal(payments)).toBe(100)
  })

  it('excludes a paid-then-cancelled payment even though it still has paidAt set', () => {
    // amount/status are all receivedTotal looks at; paidAt isn't part of its input at all —
    // this test documents that a cancelled row is excluded regardless of its paidAt history.
    const payments = [
      { status: 'cancelled', amount: 500 }, // was paid, then cancelled — paidAt still set upstream
      { status: 'paid', amount: 150 },
    ]
    expect(receivedTotal(payments)).toBe(150)
  })

  it('returns 0 for no payments, or none paid', () => {
    expect(receivedTotal([])).toBe(0)
    expect(receivedTotal([{ status: 'pending', amount: 999 }])).toBe(0)
  })
})

describe('isPaymentOverdue / isAwaitingMilestone', () => {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString()
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString()

  it('a pending payment with no dueDate is awaiting milestone, never overdue', () => {
    const payment = { status: 'pending', dueDate: undefined }
    expect(isAwaitingMilestone(payment)).toBe(true)
    expect(isPaymentOverdue(payment)).toBe(false)
  })

  it('a pending payment with a past dueDate is overdue, not awaiting milestone', () => {
    const payment = { status: 'pending', dueDate: yesterday }
    expect(isPaymentOverdue(payment)).toBe(true)
    expect(isAwaitingMilestone(payment)).toBe(false)
  })

  it('a pending payment with a future dueDate is neither', () => {
    const payment = { status: 'pending', dueDate: tomorrow }
    expect(isPaymentOverdue(payment)).toBe(false)
    expect(isAwaitingMilestone(payment)).toBe(false)
  })

  it('a paid or cancelled payment is never overdue or awaiting milestone, regardless of dueDate', () => {
    for (const status of ['paid', 'cancelled']) {
      expect(isPaymentOverdue({ status, dueDate: yesterday })).toBe(false)
      expect(isAwaitingMilestone({ status, dueDate: undefined })).toBe(false)
    }
  })
})

describe('splitAmounts', () => {
  it('splits evenly when it divides exactly', () => {
    expect(splitAmounts(1000, [50, 50])).toEqual([500, 500])
    expect(splitAmounts(1000, [50, 50]).reduce((a, b) => a + b)).toBe(1000)
  })

  it('30/40/30 of a value not evenly divisible — the last part absorbs the rounding remainder', () => {
    const parts = splitAmounts(1000, [30, 40, 30])
    // floor(1000*0.3)=300, floor(1000*0.4)=400, last = 1000-300-400=300
    expect(parts).toEqual([300, 400, 300])
    expect(parts.reduce((a, b) => a + b)).toBe(1000)
  })

  it('always sums to exactly the total, even with a value that does not divide cleanly', () => {
    const parts = splitAmounts(1_000_001, [33, 33, 34])
    expect(parts.reduce((a, b) => a + b)).toBe(1_000_001)
  })

  it('returns an empty array for no percentages', () => {
    expect(splitAmounts(1000, [])).toEqual([])
  })

  // Regression guard for a real reporting mistake: an earlier live-verification script sorted
  // the resulting amounts descending before comparing them, which can't tell "right amounts in
  // the right order" apart from "right amounts, scrambled order" — it was reported as proof of
  // correct output when it wasn't. Every test below compares the exact, unsorted, ordered array.
  it('30/40/30 of $18,500 (the real deal value this was reported against) — exact order', () => {
    // floor(18500*0.3)=5550, floor(18500*0.4)=7400, last = 18500-5550-7400=5550.
    // Order-sensitive: index 0 is Advance (30%), index 1 is Milestone (40%), index 2 is Final (30%).
    expect(splitAmounts(18500, [30, 40, 30])).toEqual([5550, 7400, 5550])
  })

  it('a value that leaves a remainder on 50/50 — the last (second) part absorbs it', () => {
    // floor(10001*0.5)=5000, last = 10001-5000=5001.
    expect(splitAmounts(10001, [50, 50])).toEqual([5000, 5001])
  })

  it('a value that leaves a remainder on 33/33/34 — the last (third) part absorbs it', () => {
    // floor(10001*0.33)=3300, floor(10001*0.33)=3300, last = 10001-3300-3300=3401.
    expect(splitAmounts(10001, [33, 33, 34])).toEqual([3300, 3300, 3401])
  })
})
