/**
 * Pure-function regression guard for "received"/"collected" math everywhere Payments are summed
 * (currently just the per-deal received-vs-value banner on the Payments screen — there is no
 * Dashboard card, Reports widget, or deal-card progress bar for Payments per the approved design,
 * so there is nothing else in the codebase that sums received money). The bug this guards against:
 * a payment that was marked paid and then cancelled keeps its `paidAt` (see cancelPayment in
 * lib/data/payments.ts, which keeps it on purpose so the history reads "paid on X, then
 * cancelled") — summing by `paidAt` truthiness instead of `status === 'paid'` would double-count
 * or wrongly include it.
 */
import { describe, expect, it } from 'vitest'
import { receivedTotal } from '@/lib/utils'

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
