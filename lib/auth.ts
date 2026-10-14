import 'server-only'

import { auth, clerkClient } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import { upsertOrg, getOrgByClerkId } from '@lib/data/organizations'
import { getOwnerByClerkUserId, upsertOwnerFromClerk } from '@lib/data/owners'
import { ensureDefaultStages } from '@lib/data/stages'
import { ownerRoleFromClerk } from '@lib/roles'

/**
 * Resolves the current request's Clerk auth into our internal
 * Organization + Owner records. If either record is missing (e.g. on
 * first request before the webhook arrives), it's created on-demand
 * from Clerk's API.
 *
 * Redirects to /sign-in if the user is unauthenticated, and to a
 * create-org page flow if no Clerk organization is active.
 */
export async function resolveAuth() {
  const { userId, orgId: clerkOrgId, orgRole } = await auth()

  if (!userId) redirect('/sign-in')
  if (!clerkOrgId) redirect('/create-org')

  // ---- Organization sync (on-demand fallback for webhooks) ----
  //
  // upsertOrg uses prisma.organization.upsert (not create), so it is
  // atomic even when resolveAuth() and the organization.created webhook
  // fire concurrently. A plain check-then-create would race: both read
  // null, both attempt INSERT, one throws P2002 and the user sees a 500.
  const clerk = await clerkClient()
  const clerkOrg = await clerk.organizations.getOrganization({
    organizationId: clerkOrgId,
  })
  const org = await upsertOrg({ clerkOrgId, name: clerkOrg.name })
  await ensureDefaultStages(org.id)

  // ---- Owner sync (on-demand fallback for webhooks) ----
  let owner = await getOwnerByClerkUserId(org.id, userId)
  if (!owner) {
    const clerkUser = await clerk.users.getUser(userId)
    const primaryEmail =
      clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)
        ?.emailAddress ?? clerkUser.emailAddresses[0]?.emailAddress ?? ''
    const name =
      [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') ||
      primaryEmail.split('@')[0] ||
      'Team Member'

    owner = await upsertOwnerFromClerk(org.id, userId, {
      name,
      email: primaryEmail,
      // The session's org role ("org:admin" / "org:member"), not a hardcoded default.
      role: ownerRoleFromClerk(orgRole),
      avatarUrl: clerkUser.imageUrl,
    })
  }

  return { orgId: org.id, owner, clerkOrgId, clerkUserId: userId }
}

/**
 * Lightweight version that just returns orgId + ownerId without
 * on-demand syncing. Use in server actions where the auth data is
 * expected to already exist (since the user navigated through the
 * layout first, which runs resolveAuth).
 */
export async function requireAuth() {
  const { userId, orgId: clerkOrgId } = await auth()
  if (!userId || !clerkOrgId) throw new Error('Unauthorized')

  const org = await getOrgByClerkId(clerkOrgId)
  if (!org) throw new Error('Organization not found')

  const owner = await getOwnerByClerkUserId(org.id, userId)
  if (!owner) throw new Error('Owner record not found')

  return { orgId: org.id, ownerId: owner.id, role: owner.role, active: owner.active }
}

/**
 * Same as `requireAuth()`, plus rejects unless the caller's own `Owner.role` (never a
 * client-supplied value) is "Admin". Use for actions that must stay admin-only — e.g. changing
 * the org's currency. `role` comes from the same DB row `requireAuth()` already fetched, so this
 * adds no extra query.
 */
export async function requireAdmin() {
  const session = await requireAuth()
  if (session.role !== 'Admin') throw new Error('Admins only')
  return session
}

/**
 * Stricter than `requireAdmin()` — do not reuse `requireAdmin()` as-is for payment actions.
 * `requireAdmin()`'s `role` check reads `Owner.role` from our own DB, which is only ever updated
 * by the `organizationMembership.updated` webhook (see `lib/data/owners.ts`'s
 * `upsertOwnerFromClerk` and the webhook route's `handleMemberUpdated`) — never re-synced on an
 * existing row by `resolveAuth()`'s on-demand path, which only sets role the first time an
 * Owner row is created. So between a demotion in Clerk and that webhook actually landing,
 * `Owner.role` is stale and `requireAdmin()` would still grant access on the old value — there is
 * no other point where this app re-validates role against Clerk's live state mid-request. Adding
 * the `active` check here does not close that specific window (a demoted admin is still
 * `active: true` — demotion isn't removal); it guards the separate case where someone was removed
 * from the org (soft-deleted via `organizationMembership.deleted`, see `deactivateOwner`) and that
 * webhook is itself still in flight. Payments gets both checks explicitly, on top of
 * `requireAdmin()`, rather than assuming `requireAdmin()` alone is strict enough for money data.
 */
export async function requirePaymentAccess() {
  const session = await requireAdmin()
  if (!session.active) throw new Error('Forbidden')
  return session
}
