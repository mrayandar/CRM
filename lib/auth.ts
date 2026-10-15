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
  const { userId, orgId: clerkOrgId, orgRole } = await auth()
  if (!userId || !clerkOrgId) throw new Error('Unauthorized')

  const org = await getOrgByClerkId(clerkOrgId)
  if (!org) throw new Error('Organization not found')

  const owner = await getOwnerByClerkUserId(org.id, userId)
  if (!owner) throw new Error('Owner record not found')

  return {
    orgId: org.id,
    ownerId: owner.id,
    role: owner.role,
    active: owner.active,
    // The live Clerk session's own role claim, alongside our DB's (possibly stale) Owner.role —
    // requirePaymentAccess() checks both agree; nothing else currently reads this.
    sessionOrgRole: orgRole,
    clerkUserId: userId,
    clerkOrgId,
  }
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
 * For payment READS (the Payments route, the data loader, command palette indexing, CSV export).
 * Stricter than `requireAdmin()` — do not reuse `requireAdmin()` as-is for payment actions.
 *
 * `requireAdmin()`'s `role` check reads `Owner.role` from our own DB, which is only ever updated
 * by the `organizationMembership.updated` webhook (see `lib/data/owners.ts`'s
 * `upsertOwnerFromClerk` and the webhook route's `handleMemberUpdated`) — never re-synced on an
 * existing row by `resolveAuth()`'s on-demand path, which only sets role the first time an Owner
 * row is created. So between a demotion in Clerk and that webhook actually landing, `Owner.role`
 * can be stale for an *unbounded* amount of time (however long webhook delivery takes, including
 * retries) and `requireAdmin()` alone would still grant access on the old value.
 *
 * This checks two independent sources and fails closed if they disagree, in either direction:
 * 1. `Owner.role === 'Admin'` and `Owner.active` (via `requireAdmin()`) — our DB.
 * 2. `auth()`'s own `orgRole` claim === `'org:admin'` — Clerk's session JWT, which Clerk refreshes
 *    roughly every minute, bounding *this* source's staleness to about a minute (vs. the DB's
 *    unbounded webhook-delivery window).
 * Neither source alone is trustworthy enough for money data; requiring agreement means an attacker
 * (or a demoted admin) needs *both* a stale DB row *and* a stale session to slip through, and the
 * session is the one that self-corrects quickly.
 */
export async function requirePaymentAccess() {
  const session = await requireAdmin()
  if (!session.active) throw new Error('Forbidden')
  if (session.sessionOrgRole !== 'org:admin') throw new Error('Forbidden')
  return session
}

/**
 * Non-throwing version of `requirePaymentAccess()`, for call sites that serve every caller
 * regardless of role (the (app) layout, which loads CRM data for Admins and Members alike) and
 * need a boolean rather than a thrown error. Same two-source check, same session — just reports
 * the result instead of rejecting the request. Used to decide whether `loadCrmData` includes
 * Payment rows and payment-kind activities at all; nothing downstream (command palette, CSV
 * export, the per-deal view) re-checks this, because none of them ever receive the data to begin
 * with when this is false. See the "Activity leak" fix in PROGRESS.md for why that one check,
 * here, is enough.
 */
export async function canAccessPayments(): Promise<boolean> {
  try {
    await requirePaymentAccess()
    return true
  } catch {
    return false
  }
}

/**
 * For payment WRITES (create, edit, mark paid, cancel, delete) — stricter still than
 * `requirePaymentAccess()`. The session-JWT check above bounds staleness to Clerk's refresh
 * interval (~1 minute), which is an acceptable read-path tradeoff but too slow for a mutation: a
 * demotion should block a write *immediately*, not after up to a minute. Confirms the caller's
 * role live against Clerk's Backend API — the same "current state, not the webhook payload"
 * pattern already used by the webhook route's `handleMemberCreated` — which has no such window.
 *
 * Pages through *every* membership the Backend API has for this user rather than trusting a
 * single 100-row page: a real admin who belongs to more than 100 Clerk organizations would
 * otherwise have their own org's membership silently missing from page one, and get wrongly
 * rejected as "not found" even though they really are org:admin here. `totalCount` (returned by
 * every page) tells us when to stop.
 */
export async function requirePaymentWriteAccess() {
  const session = await requirePaymentAccess()
  const clerk = await clerkClient()

  const pageSize = 100
  let offset = 0
  for (;;) {
    const page = await clerk.users.getOrganizationMembershipList({
      userId: session.clerkUserId,
      limit: pageSize,
      offset,
    })
    const current = page.data.find((m) => m.organization.id === session.clerkOrgId)
    if (current) {
      if (current.role !== 'org:admin') throw new Error('Forbidden')
      return session
    }
    offset += page.data.length
    if (page.data.length < pageSize || offset >= page.totalCount) break
  }
  throw new Error('Forbidden')
}
