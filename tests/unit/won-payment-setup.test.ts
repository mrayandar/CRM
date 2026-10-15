/**
 * Pure-function coverage for the "set up payments after Won" prompt. This codebase has no
 * component/DOM test harness (vitest here runs in a plain Node environment — see
 * vitest.config.ts), so the actual React trigger (persist()'s onSuccess callback in
 * src/store/crm.tsx, wired from moveDeal/updateDeal/addDeal) is verified live against the real
 * app instead. What's tested here, directly and automatically, are the two decisions that
 * mechanism depends on:
 *
 * 1. shouldPromptWonPaymentSetup — whether the prompt should open at all (Member gating, and the
 *    "doesn't re-prompt once a deal already has payments" rule).
 * 2. runPersist — the exact shared control flow that guarantees `onSuccess` (which is how the
 *    prompt gets triggered) never fires when the underlying save rolled back. This is the real
 *    code persist() calls, not a reimplementation, so it's a genuine guarantee about "the dialog
 *    must not open if the move rolls back" — for all three call sites at once, since all three
 *    go through this same function.
 */
import { describe, expect, it, vi } from 'vitest'
import { shouldPromptWonPaymentSetup } from '@/lib/utils'
import { runPersist } from '@/store/persistRun'

describe('shouldPromptWonPaymentSetup', () => {
  it('is false for anyone without payment access, regardless of payments', () => {
    expect(shouldPromptWonPaymentSetup({ canAccessPayments: false, dealId: 'd1', payments: [] })).toBe(false)
    expect(
      shouldPromptWonPaymentSetup({ canAccessPayments: false, dealId: 'd1', payments: [{ dealId: 'd2' }] }),
    ).toBe(false)
  })

  it('is true for a privileged caller when the deal has no payments yet', () => {
    expect(shouldPromptWonPaymentSetup({ canAccessPayments: true, dealId: 'd1', payments: [] })).toBe(true)
    expect(
      shouldPromptWonPaymentSetup({ canAccessPayments: true, dealId: 'd1', payments: [{ dealId: 'd2' }] }),
    ).toBe(true)
  })

  it('is false once the deal already has any payment — re-winning a reopened deal does not re-prompt', () => {
    expect(
      shouldPromptWonPaymentSetup({
        canAccessPayments: true,
        dealId: 'd1',
        payments: [{ dealId: 'd1' }],
      }),
    ).toBe(false)
  })

  it('a payment on a different deal does not block this deal\'s prompt', () => {
    expect(
      shouldPromptWonPaymentSetup({
        canAccessPayments: true,
        dealId: 'd1',
        payments: [{ dealId: 'd1' }, { dealId: 'd2' }].filter((p) => p.dealId === 'd2'),
      }),
    ).toBe(true)
  })
})

describe('runPersist: the exact guarantee the Won-payment-setup trigger depends on', () => {
  it('calls onSuccess (and never rollback) when run succeeds', async () => {
    const rollback = vi.fn()
    const onSuccess = vi.fn()
    const onFailure = vi.fn()
    const ok = await runPersist({ run: async () => 'ok', rollback, onSuccess, onFailure })
    expect(ok).toBe(true)
    expect(onSuccess).toHaveBeenCalledOnce()
    expect(rollback).not.toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('calls rollback (and never onSuccess) when run throws — the "rolled-back move never opens the dialog" guarantee', async () => {
    const rollback = vi.fn()
    const onSuccess = vi.fn()
    const onFailure = vi.fn()
    const ok = await runPersist({
      run: async () => {
        throw new Error('server rejected it')
      },
      rollback,
      onSuccess,
      onFailure,
    })
    expect(ok).toBe(false)
    expect(rollback).toHaveBeenCalledOnce()
    expect(onFailure).toHaveBeenCalledOnce()
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('a null run (standalone activity log) still calls onSuccess', async () => {
    const onSuccess = vi.fn()
    const ok = await runPersist({ run: null, rollback: vi.fn(), onSuccess })
    expect(ok).toBe(true)
    expect(onSuccess).toHaveBeenCalledOnce()
  })
})
