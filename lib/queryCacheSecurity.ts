/**
 * The decision behind the query-cache security rule (PROGRESS.md's "Cache security" design,
 * point A): clear the *entire* TanStack Query cache — never a targeted subset — on an org switch,
 * a sign-out, or any change in the viewer's role, repVisibility, or payment access. A full clear
 * is the only version of this rule that can't miss a key: "remove all payment queries" and "no
 * out-of-scope data survives a scope change" are both just specific instances of "the cache from
 * before this change is never trustworthy, don't keep any of it."
 *
 * Extracted as a pure function (same reasoning as livePoll.ts's isRefetchStale) so the rule is
 * unit-testable without a QueryClient or a React tree.
 */
export interface CacheSecurityState {
  orgId: string
  role: string
  repVisibility: 'ALL' | 'OWN'
  canAccessPayments: boolean
}

/** `prev` is `null` on the very first render — nothing to clear yet, there's no stale cache from
 *  "before" to distrust. Every subsequent render compares against the last state actually seen. */
export function shouldClearQueryCache(prev: CacheSecurityState | null, next: CacheSecurityState): boolean {
  if (!prev) return false
  return (
    prev.orgId !== next.orgId ||
    prev.role !== next.role ||
    prev.repVisibility !== next.repVisibility ||
    prev.canAccessPayments !== next.canAccessPayments
  )
}
