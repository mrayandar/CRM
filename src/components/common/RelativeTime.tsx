'use client'

import { useEffect, useState } from 'react'
import { formatDate, relativeTime } from '@/lib/utils'

/**
 * `relativeTime` ("Just now", "2m ago", ...) depends on the exact instant it's called at. Every
 * page that renders it is a 'use client' component that still gets server-rendered on first load,
 * so calling `relativeTime` directly during render risks a real hydration mismatch: a timestamp
 * near a minute boundary can tick from "Just now" to "1m ago" in the gap between the server render
 * and the client hydrating, and React's SSR'd text won't match what the client expects.
 *
 * Renders the stable, minute-insensitive `formatDate` on both the server pass and the client's
 * first (hydrating) pass — identical by construction, since `formatDate` has no second/minute-level
 * time dependency — then swaps in the live relative label via a `useEffect`, which only ever runs
 * post-mount, after hydration has already committed and there's nothing left to mismatch against.
 */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const [label, setLabel] = useState<string | null>(null)
  useEffect(() => setLabel(relativeTime(iso)), [iso])
  return <span className={className}>{label ?? formatDate(iso)}</span>
}
