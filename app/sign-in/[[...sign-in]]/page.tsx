import { SignIn } from '@clerk/nextjs'

export default function SignInPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas">
      {/*
        `routing="path"` is required, not cosmetic. Clerk resolves session
        tasks (e.g. `choose-organization`) by navigating to a sub-route of
        this component. Left to its default the component uses hash routing
        (`/sign-in#/tasks/...`), while the middleware redirects pending
        sessions to the *path* `/sign-in/tasks` — the two conventions then
        redirect into each other forever. Pinning path routing makes the
        task render at `/sign-in/tasks/...`, which this catch-all serves.
      */}
      <SignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        fallbackRedirectUrl="/"
      />
    </div>
  )
}
