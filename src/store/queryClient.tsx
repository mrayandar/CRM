'use client'

import { useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * Wires TanStack Query into the app — infrastructure only, as of this commit. No screen uses
 * `useQuery`/`useMutation` yet; that starts with Stage 2 (Tasks). See
 * src/store/QueryCacheSecurityGuard.tsx (rendered inside CrmProvider, where org/role/scope/
 * payment-access are actually known) for the cache-clearing rules this cache must respect once
 * real queries exist.
 *
 * Deliberately no persistence (no localStorage/sessionStorage/a persist plugin): a cache that
 * survives a reload or a browser restart is a cache that can leak a demoted admin's payment data,
 * or a Member's own stale out-of-scope rows, to the next person who opens this browser profile.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Each screen's own query sets its own staleTime/refetchInterval once it migrates —
            // no app-wide default masks a screen forgetting to set one.
            staleTime: 0,
          },
        },
      }),
  )

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
