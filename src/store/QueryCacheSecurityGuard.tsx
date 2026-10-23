'use client'

import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@clerk/nextjs'
import { useCrm } from '@/store/crm'
import { shouldClearQueryCache, type CacheSecurityState } from '@lib/queryCacheSecurity'

/**
 * Clears the entire TanStack Query cache on an org switch, a sign-out, or any change in the
 * viewer's role, repVisibility, or payment access — see lib/queryCacheSecurity.ts for why it's a
 * full clear, never a targeted one. No queries exist yet (nothing has migrated off CrmProvider's
 * arrays as of this commit), so this has nothing to clear today — it's wired in now so Stage 2
 * onward never has to touch this again.
 *
 * Rendered inside CrmProvider (where orgId/role/canAccessPayments are already known) and inside
 * QueryProvider (where the QueryClient instance is already known) — see app/(app)/layout.tsx.
 */
export function QueryCacheSecurityGuard({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient()
  const { orgId, currentUser, repVisibility, canAccessPayments } = useCrm()
  const { isSignedIn } = useAuth()
  const prevRef = useRef<CacheSecurityState | null>(null)
  const wasSignedInRef = useRef(isSignedIn)

  useEffect(() => {
    const next: CacheSecurityState = {
      orgId,
      role: currentUser.role,
      repVisibility,
      canAccessPayments,
    }
    if (shouldClearQueryCache(prevRef.current, next)) {
      queryClient.clear()
    }
    prevRef.current = next
  }, [orgId, currentUser.role, repVisibility, canAccessPayments, queryClient])

  useEffect(() => {
    if (wasSignedInRef.current && isSignedIn === false) {
      queryClient.clear()
    }
    wasSignedInRef.current = isSignedIn
  }, [isSignedIn, queryClient])

  return <>{children}</>
}
