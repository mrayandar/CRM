import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

// Routes that must stay reachable while the Clerk session is still
// `pending` — i.e. signed in, but with an unresolved session task such as
// `choose-organization`. `auth.protect()` treats a pending session as
// unauthenticated, so protecting any of these would bounce the user back
// into the sign-in flow they are currently trying to complete.
const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/create-org(.*)',
  '/api/webhooks(.*)',
])

export default clerkMiddleware(
  async (auth, request) => {
    if (!isPublicRoute(request)) {
      await auth.protect()
    }
  },
  {
    // Without these, Clerk builds its redirect targets from the hosted
    // Account Portal origin (<slug>.accounts.dev) instead of this app.
    // For a session with a pending task that means bouncing cross-origin
    // to `<slug>.accounts.dev/sign-in/tasks`, which then hands control
    // back here — an infinite handoff. Pinning them keeps the whole task
    // flow on this origin, where the `[[...sign-in]]` catch-all renders it.
    signInUrl: '/sign-in',
    signUpUrl: '/sign-up',
  },
)

export const config = {
  matcher: [
    // Skip Next.js internals and static files
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
}
