'use client'

import { useEffect } from 'react'

/**
 * Catches a crash in the root layout itself (e.g. ClerkProvider failing to initialize) — the one
 * case app/error.tsx can't catch, since that boundary lives inside the layout it would need to
 * replace. Must render its own <html>/<body>: there is no guarantee the root layout that would
 * normally provide them ran at all.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('Unhandled root layout error:', error.digest ?? error.message)
  }, [error])

  return (
    <html lang="en">
      <body>
        <main
          style={{
            display: 'flex',
            minHeight: '100vh',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '1rem',
            padding: '0 1.5rem',
            textAlign: 'center',
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          <p style={{ fontSize: 13, fontWeight: 500, textTransform: 'uppercase', color: '#74747f' }}>Error</p>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: '#16161a' }}>Something went wrong</h1>
          <p style={{ maxWidth: 360, fontSize: 13.5, color: '#5c5c66' }}>
            The app ran into a problem loading. Try again, or reload the page.
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              onClick={() => reset()}
              style={{
                height: 36,
                padding: '0 14px',
                borderRadius: 8,
                border: '1px solid #4f46e5',
                background: '#4f46e5',
                color: '#fff',
                fontSize: 13.5,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
            <a
              href="/"
              style={{
                height: 36,
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0 14px',
                borderRadius: 8,
                border: '1px solid #e4e4e8',
                background: '#fff',
                color: '#3f3f46',
                fontSize: 13.5,
                fontWeight: 500,
                textDecoration: 'none',
              }}
            >
              Back to dashboard
            </a>
          </div>
        </main>
      </body>
    </html>
  )
}
