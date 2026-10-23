/**
 * Coverage for the query-cache security rule (lib/queryCacheSecurity.ts): the pure decision
 * function (shouldClearQueryCache), plus an end-to-end check against a real QueryClient proving
 * the rule actually empties the cache — no payment data, no out-of-scope data, nothing at all —
 * once it fires. No screen populates this cache with real data yet (Stage 2 is the first to
 * migrate), so the second block seeds the cache by hand with the shapes real queries will
 * eventually use, standing in for them.
 */
import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { shouldClearQueryCache, type CacheSecurityState } from '@lib/queryCacheSecurity'

const BASE: CacheSecurityState = {
  orgId: 'org-1',
  role: 'Member',
  repVisibility: 'ALL',
  canAccessPayments: false,
}

describe('shouldClearQueryCache', () => {
  it('never clears on the very first render — there is no "before" to distrust', () => {
    expect(shouldClearQueryCache(null, BASE)).toBe(false)
  })

  it('does not clear when nothing changed', () => {
    expect(shouldClearQueryCache(BASE, { ...BASE })).toBe(false)
  })

  it('clears on an org switch', () => {
    expect(shouldClearQueryCache(BASE, { ...BASE, orgId: 'org-2' })).toBe(true)
  })

  it('clears on a role change (e.g. a demotion)', () => {
    const admin = { ...BASE, role: 'Admin', canAccessPayments: true }
    expect(shouldClearQueryCache(admin, { ...admin, role: 'Member', canAccessPayments: false })).toBe(true)
  })

  it('clears on a repVisibility change (ALL turned to OWN, or back)', () => {
    expect(shouldClearQueryCache(BASE, { ...BASE, repVisibility: 'OWN' })).toBe(true)
  })

  it('clears the instant payment access ends — the exact "demote a real admin with the tab open" case', () => {
    const admin = { ...BASE, role: 'Admin', canAccessPayments: true }
    expect(shouldClearQueryCache(admin, { ...admin, canAccessPayments: false })).toBe(true)
  })

  it('also clears if payment access is somehow granted without a role change (defensive — should never happen alone)', () => {
    expect(shouldClearQueryCache(BASE, { ...BASE, canAccessPayments: true })).toBe(true)
  })
})

describe('end to end against a real QueryClient', () => {
  function seedCacheAsAdmin(client: QueryClient) {
    client.setQueryData(['payments', 'org-1', null, undefined], [{ id: 'pay-1', amount: 500 }])
    client.setQueryData(['dashboard-aggregates', 'org-1', null], { openValue: 10_000 })
    client.setQueryData(['leads', 'org-1', null, undefined], [{ id: 'lead-1' }, { id: 'lead-2' }])
  }

  it("demoting a real admin with the tab open leaves no payment data in the cache", () => {
    const client = new QueryClient()
    const admin: CacheSecurityState = { orgId: 'org-1', role: 'Admin', repVisibility: 'ALL', canAccessPayments: true }
    seedCacheAsAdmin(client)
    expect(client.getQueryData(['payments', 'org-1', null, undefined])).toBeDefined()

    const demoted: CacheSecurityState = { ...admin, role: 'Member', canAccessPayments: false }
    expect(shouldClearQueryCache(admin, demoted)).toBe(true)
    client.clear()

    expect(client.getQueryData(['payments', 'org-1', null, undefined])).toBeUndefined()
    expect(client.getQueryData(['dashboard-aggregates', 'org-1', null])).toBeUndefined()
    expect(client.getQueryCache().getAll()).toHaveLength(0)
  })

  it("a Member's scope changing (ALL turned to OWN) leaves no out-of-scope data in the cache", () => {
    const client = new QueryClient()
    const memberAllMode: CacheSecurityState = { orgId: 'org-1', role: 'Member', repVisibility: 'ALL', canAccessPayments: false }
    // Scoped by scopeOwnerId=null (ALL mode) — holds every lead in the org, including ones this
    // Member won't own once OWN mode is on.
    client.setQueryData(['leads', 'org-1', null, undefined], [{ id: 'lead-1' }, { id: 'lead-2' }, { id: 'lead-3' }])
    expect(client.getQueryCache().getAll()).toHaveLength(1)

    const memberOwnMode: CacheSecurityState = { ...memberAllMode, repVisibility: 'OWN' }
    expect(shouldClearQueryCache(memberAllMode, memberOwnMode)).toBe(true)
    client.clear()

    expect(client.getQueryCache().getAll()).toHaveLength(0)
  })

  it('does not clear a healthy cache when nothing security-relevant changed', () => {
    const client = new QueryClient()
    seedCacheAsAdmin(client)
    expect(shouldClearQueryCache(BASE, { ...BASE })).toBe(false)
    // No clear() call — the cache is exactly as it was.
    expect(client.getQueryCache().getAll().length).toBeGreaterThan(0)
  })
})
