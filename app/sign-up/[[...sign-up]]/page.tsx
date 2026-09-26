import { SignUp } from '@clerk/nextjs'

export default function SignUpPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas">
      {/* See the note in the sign-in page — path routing keeps Clerk's
          session-task sub-routes on real paths the catch-all can serve. */}
      <SignUp
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        fallbackRedirectUrl="/"
      />
    </div>
  )
}
