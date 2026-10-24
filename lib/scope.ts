/**
 * Per-org record visibility for Members (RepVisibility.OWN) — see prisma/schema.prisma's
 * RepVisibility enum doc comment. Nothing reads or writes a `Scope` yet: `requireAuth()` computes
 * `scopeOwnerId` on every request, but it is always `null` today because every org defaults to
 * ALL and no Settings switch exists yet to change that. The data layer starts actually enforcing
 * it in Stage 1.
 */
export interface Scope {
  orgId: string
  /** null = unrestricted within the org (a real Admin, or the org is in ALL mode). Non-null is a
   *  hard floor once Stage 1 wires it in: every query for a scoped entity ANDs `ownerId` (or
   *  `ownerId`/`createdById` for tasks) against this value — never a client-chosen filter. */
  scopeOwnerId: string | null
}

/**
 * Fail-closed, two-source check — same shape as `requirePaymentAccess()` in lib/auth.ts: `null`
 * (unrestricted) only when the org is in ALL mode, or the caller is an Admin by BOTH sources at
 * once (our DB's `Owner.role` AND the live Clerk session's own `org:admin` claim). Either source
 * alone saying "Admin" is not enough — a stale DB row after a live demotion, or a stale session
 * claim after a live promotion, both resolve to "scoped," never to "unrestricted." Uses the
 * session JWT's own role claim (bounded ~1 minute staleness via Clerk's own refresh), not a live
 * Backend API call — this runs on every read, so no extra round trip per request.
 */
export function computeScopeOwnerId(input: {
  repVisibility: 'ALL' | 'OWN'
  ownerId: string
  ownerRole: string
  sessionOrgRole: string | null | undefined
}): string | null {
  if (input.repVisibility === 'ALL') return null
  const isRealAdmin = input.ownerRole === 'Admin' && input.sessionOrgRole === 'org:admin'
  return isRealAdmin ? null : input.ownerId
}

/** A scoped Member may only create/convert/import a record owned by themselves — `ownerId` on a
 *  create/convert/import is otherwise a free client-chosen value (any teammate), same as an Admin
 *  or an ALL-mode org's Member. Reassignment (editing an existing record's owner away from the
 *  caller) is NOT restricted by this — only creation. Shared by lib/actions/crm.ts and the CSV-
 *  import feature (lib/data/import.ts) so the one rule can't drift between the two. */
export function assertOwnerInScope(scope: Scope, ownerId: string) {
  if (scope.scopeOwnerId && ownerId !== scope.scopeOwnerId) {
    throw new Error('Owner not found')
  }
}
