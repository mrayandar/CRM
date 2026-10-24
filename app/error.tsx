'use client'

import { useEffect } from 'react'

/**
 * Catches a render/server-action error anywhere inside the (app) route tree so the user sees a
 * friendly retry screen instead of Next's default stack-trace overlay (dev) or blank screen
 * (prod). `error.tsx` only catches errors inside `<body>` — a crash in the root layout itself
 * needs global-error.tsx, which supplies its own <html>/<body>.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Server-side detail only — no user-entered content, no personal data, no payment amounts.
    console.error('Unhandled render error:', error.digest ?? error.message)
  }, [error])

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-canvas px-6 text-center">
      <p className="text-[13px] font-medium uppercase tracking-wide text-ink-500">Error</p>
      <h1 className="text-xl font-semibold text-ink-900">Something went wrong</h1>
      <p className="max-w-sm text-[13.5px] text-ink-600">
        This page ran into a problem. Try again, or head back to the dashboard.
      </p>
      <div className="mt-2 flex gap-2">
        <button
          onClick={() => reset()}
          className="inline-flex h-9 items-center rounded-[8px] border border-brand-600 bg-brand-600 px-3.5 text-[13.5px] font-medium text-white shadow-hairline hover:bg-brand-700 hover:border-brand-700"
        >
          Try again
        </button>
        <a
          href="/"
          className="inline-flex h-9 items-center rounded-[8px] border border-line-strong bg-surface px-3.5 text-[13.5px] font-medium text-ink-700 shadow-hairline hover:bg-subtle hover:text-ink-900"
        >
          Back to dashboard
        </a>
      </div>
    </main>
  )
}
