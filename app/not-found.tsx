import Link from 'next/link'

/**
 * A real "page doesn't exist" screen, not a silent redirect — a silent redirect() here used to
 * hide every 404 (a stale bookmark, a typo, a deep-link to a now-deleted record) behind an
 * unexplained bounce to the dashboard, giving no signal that anything went wrong.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-canvas px-6 text-center">
      <p className="text-[13px] font-medium uppercase tracking-wide text-ink-500">404</p>
      <h1 className="text-xl font-semibold text-ink-900">Page not found</h1>
      <p className="max-w-sm text-[13.5px] text-ink-600">
        This page doesn&apos;t exist, or you may not have access to it.
      </p>
      <Link
        href="/"
        className="mt-2 inline-flex h-9 items-center rounded-[8px] border border-brand-600 bg-brand-600 px-3.5 text-[13.5px] font-medium text-white shadow-hairline hover:bg-brand-700 hover:border-brand-700"
      >
        Back to dashboard
      </Link>
    </main>
  )
}
