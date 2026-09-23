import 'server-only'

import { auth, clerkClient } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import { getOrgByClerkId, createOrg } from '@lib/data/organizations'
import { getOwnerByClerkUserId, upsertOwnerFromClerk } from '@lib/data/owners'

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
  const { userId, orgId: clerkOrgId } = await auth()

  if (!userId) redirect('/sign-in')
  if (!clerkOrgId) redirect('/create-org')

  // ---- Organization sync (on-demand fallback for webhooks) ----
  let org = await getOrgByClerkId(clerkOrgId)
  if (!org) {
    const client = await clerkClient()
    const clerkOrg = await client.organizations.getOrganization({
      organizationId: clerkOrgId,
    })
    org = await createOrg({
      clerkOrgId,
      name: clerkOrg.name,
    })
  }

  // ---- Owner sync (on-demand fallback for webhooks) ----
  let owner = await getOwnerByClerkUserId(org.id, userId)
  if (!owner) {
    const client = await clerkClient()
    const clerkUser = await client.users.getUser(userId)
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
      role: 'Member',
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

  return { orgId: org.id, ownerId: owner.id }
}
