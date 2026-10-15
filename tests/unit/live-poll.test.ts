/**
 * Unit coverage for CrmProvider's live-update scheduling (src/store/livePoll.ts) and the
 * stale-refetch guard it's paired with. No DOM/jsdom harness exists in this repo (vitest runs in
 * plain Node — see vitest.config.ts), so startLivePoll takes every browser API through an
 * injected `env`; these tests supply a fully-controlled fake one instead of a real browser.
 */
import { describe, expect, it } from 'vitest'
import { isRefetchStale, startLivePoll, type LivePollEnv } from '@/store/livePoll'

function makeFakeEnv(initialVisible = true) {
  let visible = initialVisible
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let nextId = 1
  let visibilityHandlers: Array<() => void> = []
  let focusHandlers: Array<() => void> = []

  const env: LivePollEnv = {
    setTimeout: (fn, ms) => {
      const id = nextId++
      timers.set(id, { fn, ms })
      return id
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number)
    },
    isVisible: () => visible,
    onVisibilityChange: (fn) => {
      visibilityHandlers.push(fn)
      return () => { visibilityHandlers = visibilityHandlers.filter((h) => h !== fn) }
    },
    onFocus: (fn) => {
      focusHandlers.push(fn)
      return () => { focusHandlers = focusHandlers.filter((h) => h !== fn) }
    },
  }

  return {
    env,
    setVisible: (v: boolean) => {
      visible = v
      for (const h of visibilityHandlers) h()
    },
    fireFocus: () => {
      for (const h of focusHandlers) h()
    },
    /** Fires the single most-recently-scheduled timer immediately, as if its delay elapsed. */
    async fireNextTimer() {
      const entries = [...timers.entries()]
      if (entries.length === 0) throw new Error('no timer scheduled')
      const [id, { fn }] = entries[entries.length - 1]!
      timers.delete(id)
      fn()
      await Promise.resolve() // let the async tick() body run past its first await
      await Promise.resolve()
    },
    pendingDelays: () => [...timers.values()].map((t) => t.ms),
    timerCount: () => timers.size,
  }
}

describe('startLivePoll', () => {
  it('schedules a tick at the steady interval when starting visible', () => {
    const fake = makeFakeEnv(true)
    const stop = startLivePoll({
      intervalMs: 60_000,
      isMutationPending: () => false,
      refetch: async () => 'applied',
      env: fake.env,
    })
    expect(fake.pendingDelays()).toEqual([60_000])
    stop()
  })

  it('pauses (no timer) while hidden, and resumes on becoming visible', async () => {
    const fake = makeFakeEnv(false)
    const stop = startLivePoll({
      intervalMs: 60_000,
      isMutationPending: () => false,
      refetch: async () => 'applied',
      env: fake.env,
    })
    expect(fake.timerCount()).toBe(0) // never scheduled anything while hidden

    fake.setVisible(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(fake.timerCount()).toBe(1) // visibility handler kicked off a fetch, which rescheduled
    stop()
  })

  it('a tick skips the fetch entirely and retries soon when a mutation is pending', async () => {
    const fake = makeFakeEnv(true)
    let refetchCalls = 0
    const stop = startLivePoll({
      intervalMs: 60_000,
      retrySoonMs: 2_000,
      isMutationPending: () => true,
      refetch: async () => {
        refetchCalls += 1
        return 'applied'
      },
      env: fake.env,
    })
    await fake.fireNextTimer()
    expect(refetchCalls).toBe(0) // never even called refetch
    expect(fake.pendingDelays()).toEqual([2_000]) // short retry, not a full interval
    stop()
  })

  it('retries soon (no backoff) when refetch reports the response was discarded as stale', async () => {
    const fake = makeFakeEnv(true)
    const stop = startLivePoll({
      intervalMs: 60_000,
      retrySoonMs: 2_000,
      isMutationPending: () => false,
      refetch: async () => 'discarded',
      env: fake.env,
    })
    await fake.fireNextTimer()
    expect(fake.pendingDelays()).toEqual([2_000])
    stop()
  })

  it('backs off exponentially on repeated real failures, capped at maxBackoffMs', async () => {
    const fake = makeFakeEnv(true)
    const stop = startLivePoll({
      intervalMs: 10_000,
      maxBackoffMs: 40_000,
      isMutationPending: () => false,
      refetch: async () => {
        throw new Error('network down')
      },
      env: fake.env,
    })
    await fake.fireNextTimer() // 1st failure
    expect(fake.pendingDelays()).toEqual([20_000])
    await fake.fireNextTimer() // 2nd failure
    expect(fake.pendingDelays()).toEqual([40_000])
    await fake.fireNextTimer() // 3rd failure — capped, not 80_000
    expect(fake.pendingDelays()).toEqual([40_000])
    stop()
  })

  it('resets backoff to the steady interval after a success', async () => {
    const fake = makeFakeEnv(true)
    let shouldFail = true
    const stop = startLivePoll({
      intervalMs: 10_000,
      maxBackoffMs: 40_000,
      isMutationPending: () => false,
      refetch: async () => {
        if (shouldFail) throw new Error('down')
        return 'applied'
      },
      env: fake.env,
    })
    await fake.fireNextTimer() // fails -> 20_000
    expect(fake.pendingDelays()).toEqual([20_000])
    shouldFail = false
    await fake.fireNextTimer() // succeeds -> back to 10_000
    expect(fake.pendingDelays()).toEqual([10_000])
    stop()
  })

  it('focus triggers an immediate refetch, bypassing whatever timer was pending', async () => {
    const fake = makeFakeEnv(true)
    let refetchCalls = 0
    const stop = startLivePoll({
      intervalMs: 60_000,
      isMutationPending: () => false,
      refetch: async () => {
        refetchCalls += 1
        return 'applied'
      },
      env: fake.env,
    })
    fake.fireFocus()
    await Promise.resolve()
    await Promise.resolve()
    expect(refetchCalls).toBe(1)
    stop()
  })

  it('stop() disposes — no further ticks, even if a timer was pending', async () => {
    const fake = makeFakeEnv(true)
    let refetchCalls = 0
    const stop = startLivePoll({
      intervalMs: 60_000,
      isMutationPending: () => false,
      refetch: async () => {
        refetchCalls += 1
        return 'applied'
      },
      env: fake.env,
    })
    stop()
    expect(fake.timerCount()).toBe(0)
    fake.fireFocus() // should be a no-op post-dispose
    expect(refetchCalls).toBe(0)
  })
})

describe('isRefetchStale', () => {
  it('is false when nothing changed and nothing is pending', () => {
    expect(isRefetchStale({ generationAtStart: 3, generationNow: 3, pendingCount: 0 })).toBe(false)
  })

  it('is true when a mutation started during the fetch (generation moved)', () => {
    expect(isRefetchStale({ generationAtStart: 3, generationNow: 4, pendingCount: 0 })).toBe(true)
  })

  it('is true when a mutation is in flight at apply time, even with no generation change', () => {
    expect(isRefetchStale({ generationAtStart: 3, generationNow: 3, pendingCount: 1 })).toBe(true)
  })
})
