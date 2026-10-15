/**
 * The scheduling logic behind CrmProvider's live-update refetch, extracted so it's unit-testable
 * without a real browser (this repo has no DOM/jsdom test harness — vitest runs in plain Node).
 * Every browser API it needs (visibility, focus, timers) comes in through `env`, which tests
 * inject a fake version of; production code never has to think about that, it just calls
 * `startLivePoll(options)` and gets the real browser wired in automatically.
 *
 * What this module does NOT know about: React state, the actual fetch, or how "is a mutation
 * pending" is tracked — those stay in src/store/crm.tsx, which is what makes this piece testable
 * in isolation. All this module decides is *when* to call the caller's `refetch`.
 */

export interface LivePollEnv {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  isVisible: () => boolean
  /** Returns an unsubscribe function. */
  onVisibilityChange: (fn: () => void) => () => void
  onFocus: (fn: () => void) => () => void
}

export type RefetchOutcome = 'applied' | 'discarded'

export interface LivePollOptions {
  /** Steady-state poll interval while the tab is visible. Default 60s. */
  intervalMs?: number
  /** Cap for exponential backoff after repeated failures. Default 5 minutes. */
  maxBackoffMs?: number
  /** How soon to retry after a mutation-pending skip/discard — short, not a full backoff. */
  retrySoonMs?: number
  /** True while this tab has a mutation in flight — a tick skips the fetch entirely when true. */
  isMutationPending: () => boolean
  /**
   * Performs one fetch-and-apply attempt. Resolves 'applied' on success, 'discarded' when the
   * caller decided the result was stale relative to a mutation that started mid-fetch (not an
   * error — no backoff for this), or rejects on a real failure (triggers backoff).
   */
  refetch: () => Promise<RefetchOutcome>
  env?: LivePollEnv
}

/**
 * Whether a refetch response that was in flight should be discarded instead of applied. True if
 * a mutation started *after* the request was sent (generation moved — the response can't be
 * trusted to reflect it) or if one happens to be in flight right now (applying would fight with
 * an optimistic update still showing). This is the exact rule that keeps a live refetch from
 * reverting a pending change or resurrecting a row a concurrent delete just removed.
 */
export function isRefetchStale({
  generationAtStart,
  generationNow,
  pendingCount,
}: {
  generationAtStart: number
  generationNow: number
  pendingCount: number
}): boolean {
  return generationNow !== generationAtStart || pendingCount > 0
}

function createBrowserEnv(): LivePollEnv {
  return {
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    isVisible: () => document.visibilityState === 'visible',
    onVisibilityChange: (fn) => {
      document.addEventListener('visibilitychange', fn)
      return () => document.removeEventListener('visibilitychange', fn)
    },
    onFocus: (fn) => {
      window.addEventListener('focus', fn)
      return () => window.removeEventListener('focus', fn)
    },
  }
}

/** Starts the poll/visibility/focus loop. Returns a disposer that stops everything. */
export function startLivePoll({
  intervalMs = 60_000,
  maxBackoffMs = 5 * 60_000,
  retrySoonMs = 2_000,
  isMutationPending,
  refetch,
  env,
}: LivePollOptions): () => void {
  const e = env ?? createBrowserEnv()
  let timer: unknown = null
  let backoff = intervalMs
  let disposed = false
  let inFlight = false

  const clear = () => {
    if (timer !== null) {
      e.clearTimeout(timer)
      timer = null
    }
  }

  const schedule = (ms: number) => {
    clear()
    if (disposed) return
    timer = e.setTimeout(tick, ms)
  }

  async function tick() {
    if (disposed || inFlight) return
    if (!e.isVisible()) return // paused — the visibility handler restarts the loop on resume
    if (isMutationPending()) {
      schedule(retrySoonMs)
      return
    }
    inFlight = true
    try {
      const outcome = await refetch()
      inFlight = false
      if (disposed) return
      if (outcome === 'discarded') {
        schedule(retrySoonMs)
      } else {
        backoff = intervalMs
        schedule(backoff)
      }
    } catch {
      inFlight = false
      if (disposed) return
      backoff = Math.min(backoff * 2, maxBackoffMs)
      schedule(backoff)
    }
  }

  const kick = () => {
    if (disposed || !e.isVisible()) return
    clear()
    void tick()
  }

  const offVisibility = e.onVisibilityChange(() => {
    if (e.isVisible()) kick()
    else clear() // pause while hidden
  })
  const offFocus = e.onFocus(kick)

  if (e.isVisible()) schedule(intervalMs)

  return () => {
    disposed = true
    clear()
    offVisibility()
    offFocus()
  }
}
