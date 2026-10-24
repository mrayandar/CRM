/**
 * Shown while AuthenticatedLayout's resolveAuth()+loadCrmData() await resolves — the one async
 * gap that runs on every navigation into this segment (see next.config.ts/PROGRESS.md on why
 * Clerk's dynamic auth() forces the whole (app) layout to re-render per-navigation, not just on
 * a hard reload). Without this, that gap was a blank screen.
 */
export default function AppSegmentLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas">
      <div
        className="size-6 animate-spin rounded-full border-2 border-line-strong border-t-brand-600"
        role="status"
        aria-label="Loading"
      />
    </div>
  )
}
