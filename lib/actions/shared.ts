/**
 * A Server Action must never let an auth-check's throw escape uncaught. Next.js redacts a thrown
 * Server Action error's message in production to a generic "An error occurred in the Server
 * Components render" — useless to the user, and exactly the bug this exists to prevent: a Member
 * clicking "Invite" got that message instead of "Only admins can invite teammates" (see
 * PROGRESS.md's Stage 1c follow-up). Every admin-only action in `lib/actions/crm.ts` and
 * `lib/actions/payments.ts` wraps its own `requireAdmin`/`requireLiveAdminAccess`/
 * `requirePaymentWriteAccess` call with `tryAdminSession` and returns `FORBIDDEN` instead of
 * letting the throw propagate — a typed `{ ok: false, error: 'forbidden' }` the client can map to
 * a specific, friendly message per action, rather than catching an opaque error.
 *
 * This deliberately only catches the AUTH check itself, not the rest of the action — a later
 * validation error (e.g. "Invalid email") still throws normally and is handled wherever it
 * already was, unchanged. Permission and validation failures are different kinds of failure and
 * stay on their existing, different paths.
 */
export async function tryAdminSession<T>(check: () => Promise<T>): Promise<T | null> {
  try {
    return await check()
  } catch {
    return null
  }
}

export type ForbiddenResult = { ok: false; error: 'forbidden' }
export const FORBIDDEN: ForbiddenResult = { ok: false, error: 'forbidden' }
