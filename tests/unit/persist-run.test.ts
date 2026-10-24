/**
 * Unit coverage for runPersist() and FriendlyActionError (src/store/persistRun.ts) — extracted
 * from persist() (src/store/crm.tsx) specifically so this is testable without a React/DOM
 * harness (this codebase has none — see tests/unit's other files for the same pattern).
 *
 * The property under test is the one every admin-gated client wrapper (updateQuota,
 * updateCurrency, updateOrgTimezone, addStage, renameStage, moveStage, addPayment,
 * updatePayment, markPaymentPaid, cancelPayment) depends on: when the Server Action it calls
 * returns `{ ok: false, error: 'forbidden' }`, the wrapper throws a `FriendlyActionError`, and
 * `rollback` must run (undoing the optimistic update already applied to local state) before
 * `onSuccess` could ever run — so a forbidden result can never leave a stale "it worked" UI
 * state behind. See PROGRESS.md's "Members hitting a raw production error" entry.
 */
import { describe, expect, it, vi } from 'vitest'
import { runPersist, FriendlyActionError } from '@/store/persistRun'

describe('runPersist', () => {
  it('on success: returns true, calls onSuccess, never calls rollback or onFailure', async () => {
    const rollback = vi.fn()
    const onSuccess = vi.fn()
    const onFailure = vi.fn()
    const ok = await runPersist({ run: async () => {}, rollback, onSuccess, onFailure })
    expect(ok).toBe(true)
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(rollback).not.toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('run === null (nothing to persist): still calls onSuccess, same as a successful run', async () => {
    const onSuccess = vi.fn()
    const ok = await runPersist({ run: null, rollback: vi.fn(), onSuccess })
    expect(ok).toBe(true)
    expect(onSuccess).toHaveBeenCalledTimes(1)
  })

  it('a forbidden result (run throws FriendlyActionError): rolls back and reports failure, never reports success — the exact mechanism that stops a stale optimistic UI state from sticking after a Member is rejected', async () => {
    const rollback = vi.fn()
    const onSuccess = vi.fn()
    const onFailure = vi.fn()
    const run = vi.fn(async () => {
      throw new FriendlyActionError('Only admins can set the quarterly quota.')
    })

    const ok = await runPersist({ run, rollback, onSuccess, onFailure })

    expect(ok).toBe(false)
    expect(rollback).toHaveBeenCalledTimes(1) // the optimistic update is undone
    expect(onSuccess).not.toHaveBeenCalled() // never told "it worked"
    expect(onFailure).toHaveBeenCalledTimes(1)
    const reportedErr = onFailure.mock.calls[0]![0]
    expect(reportedErr).toBeInstanceOf(FriendlyActionError)
    expect((reportedErr as Error).message).toBe('Only admins can set the quarterly quota.')
  })

  it('rollback always runs strictly before onSuccess could — ordering, not just call counts', async () => {
    const order: string[] = []
    const rollback = () => order.push('rollback')
    const run = async () => {
      throw new FriendlyActionError('Only admins can change the workspace currency.')
    }
    await runPersist({ run, rollback, onSuccess: () => order.push('onSuccess') })
    expect(order).toEqual(['rollback']) // onSuccess never ran at all
  })

  it('an unrelated thrown error (not FriendlyActionError) still rolls back and reports failure the same way — persist() itself is what decides to show a generic message instead of err.message for this case, not runPersist', async () => {
    const rollback = vi.fn()
    const onFailure = vi.fn()
    const run = async () => {
      throw new Error('some unexpected failure, possibly a redacted production message')
    }
    const ok = await runPersist({ run, rollback, onFailure })
    expect(ok).toBe(false)
    expect(rollback).toHaveBeenCalledTimes(1)
    const reportedErr = onFailure.mock.calls[0]![0]
    expect(reportedErr).not.toBeInstanceOf(FriendlyActionError)
  })
})
