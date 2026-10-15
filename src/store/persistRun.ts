/**
 * The core success/rollback control flow persist() (src/store/crm.tsx) runs on every optimistic
 * mutation, extracted so it's unit-testable without rendering a React provider (this codebase has
 * no component/DOM test harness — see tests/unit for what's actually testable here).
 *
 * The one guarantee everything built on top of persist() depends on: if `run` throws, `rollback`
 * runs and `onSuccess` never does. That guarantee is what makes it safe to hand persist() an
 * `onSuccess` callback for something consequential — e.g. the "set up payments" prompt that
 * fires after a deal is confirmed moved into a Won stage (src/store/crm.tsx's moveDeal/
 * updateDeal/addDeal) — without worrying it'll fire on a rolled-back change.
 */
export interface RunPersistArgs {
  /** Null means "nothing to persist" (mirrors persist()'s own convention for a standalone activity log) — `onSuccess` still runs. */
  run: (() => Promise<unknown>) | null
  rollback: () => void
  onSuccess?: () => void
  onFailure?: () => void
}

/** Returns true if `run` succeeded (or was null), false if it threw and rollback ran. */
export async function runPersist({ run, rollback, onSuccess, onFailure }: RunPersistArgs): Promise<boolean> {
  if (run) {
    try {
      await run()
    } catch {
      rollback()
      onFailure?.()
      return false
    }
  }
  onSuccess?.()
  return true
}
