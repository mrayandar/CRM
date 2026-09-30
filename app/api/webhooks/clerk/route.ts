import { headers } from 'next/headers'
import { clerkClient } from '@clerk/nextjs/server'
import { Webhook } from 'svix'
import { upsertOrg, updateOrg, deleteOrg, getOrgByClerkId } from '@lib/data/organizations'
import { upsertOwnerFromClerk, deactivateOwner } from '@lib/data/owners'
import { ensureDefaultStages } from '@lib/data/stages'
import { ownerRoleFromClerk } from '@lib/roles'

interface WebhookEvent {
  type: string
  data: Record<string, unknown>
}

export async function POST(request: Request) {
  const SIGNING_SECRET = process.env.CLERK_WEBHOOK_SECRET

  if (!SIGNING_SECRET) {
    console.error('CLERK_WEBHOOK_SECRET is not set')
    return new Response('Webhook secret not configured', { status: 500 })
  }

  const wh = new Webhook(SIGNING_SECRET)
  const headerPayload = await headers()
  const svixId = headerPayload.get('svix-id')
  const svixTimestamp = headerPayload.get('svix-timestamp')
  const svixSignature = headerPayload.get('svix-signature')

  if (!svixId || !svixTimestamp || !svixSignature) {
    return new Response('Missing svix headers', { status: 400 })
  }

  const body = await request.text()

  let event: WebhookEvent
  try {
    // svix v2's verify() only validates (it throws on failure) and returns undefined, so parse the body ourselves.
    wh.verify(body, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    })
    event = JSON.parse(body) as WebhookEvent
  } catch (err) {
    console.error('Webhook verification failed:', err)
    return new Response('Invalid signature', { status: 400 })
  }

  try {
    switch (event.type) {
      case 'organization.created':
        await handleOrgCreated(event.data)
        break
      case 'organization.updated':
        await handleOrgUpdated(event.data)
        break
      case 'organization.deleted':
        await handleOrgDeleted(event.data)
        break
      case 'organizationMembership.created':
        await handleMemberCreated(event.data)
        break
      case 'organizationMembership.updated':
        await handleMemberUpdated(event.data)
        break
      case 'organizationMembership.deleted':
        await handleMemberDeleted(event.data)
        break
      default:
        // Ignored event type
        break
    }
  } catch (err) {
    console.error(`Webhook handler error for ${event.type}:`, err)
    return new Response('Webhook handler error', { status: 500 })
  }

  return new Response('OK', { status: 200 })
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleOrgCreated(data: Record<string, unknown>) {
  const clerkOrgId = data.id as string
  const name = (data.name as string) ?? 'Untitled organization'

  // upsertOrg is atomic: if resolveAuth() already created the row, this is
  // a no-op (update: {} leaves the existing row unchanged). A plain
  // check-then-create would race and throw P2002 when both paths try to
  // INSERT concurrently.
  const org = await upsertOrg({ clerkOrgId, name })
  await ensureDefaultStages(org.id)
}

/**
 * Svix retries and replays can deliver an older event after a newer one, so the payload is not a
 * reliable "latest state". For update events we read the current state from Clerk instead; that makes
 * a redelivery harmless. Failures other than "not found" throw, so Svix retries the event.
 */
async function handleOrgUpdated(data: Record<string, unknown>) {
  const clerkOrgId = data.id as string
  if (!clerkOrgId) return

  const clerk = await clerkClient()
  let name: string | undefined
  try {
    name = (await clerk.organizations.getOrganization({ organizationId: clerkOrgId })).name
  } catch (err) {
    if ((err as { status?: number }).status === 404) return // deleted since the event was sent
    throw err
  }
  if (!name) return

  await updateOrg(clerkOrgId, { name }).catch(() => {
    // Org might not exist yet if created on-demand hasn't run
  })
}

async function handleOrgDeleted(data: Record<string, unknown>) {
  const clerkOrgId = data.id as string
  await deleteOrg(clerkOrgId).catch(() => {
    // Already deleted or never existed
  })
}

async function handleMemberCreated(data: Record<string, unknown>) {
  const publicUserData = data.public_user_data as Record<string, unknown> | undefined
  const clerkOrgId = (data.organization as Record<string, unknown>)?.id as string
  const clerkUserId = publicUserData?.user_id as string

  if (!clerkOrgId || !clerkUserId) return

  const org = await getOrgByClerkId(clerkOrgId)
  if (!org) return // org not synced yet; on-demand auth will handle it

  // Current membership from Clerk, not the (possibly stale) payload — see handleOrgUpdated.
  const clerk = await clerkClient()
  const memberships = await clerk.users.getOrganizationMembershipList({ userId: clerkUserId, limit: 100 })
  const current = memberships.data.find((m) => m.organization.id === clerkOrgId)
  // No longer a member: a stale event must not (re)create their Owner row.
  if (!current) return

  const person = current.publicUserData
  const name =
    [person?.firstName, person?.lastName].filter(Boolean).join(' ') || person?.identifier || 'Team Member'

  await upsertOwnerFromClerk(org.id, clerkUserId, {
    name,
    email: person?.identifier ?? '',
    role: ownerRoleFromClerk(current.role),
    avatarUrl: person?.imageUrl ?? null,
  })
}

async function handleMemberUpdated(data: Record<string, unknown>) {
  // Same logic as created — upsert handles both
  await handleMemberCreated(data)
}

/**
 * Soft-deletes the Owner row (see deactivateOwner) when a member is removed from the org in
 * Clerk. Same order-proofing as handleMemberCreated: a stale/out-of-order redelivery of this
 * event must not deactivate someone who has since rejoined, so this checks Clerk's *current*
 * membership list rather than trusting that the deletion is still in effect.
 */
async function handleMemberDeleted(data: Record<string, unknown>) {
  const publicUserData = data.public_user_data as Record<string, unknown> | undefined
  const clerkOrgId = (data.organization as Record<string, unknown>)?.id as string
  const clerkUserId = publicUserData?.user_id as string

  if (!clerkOrgId || !clerkUserId) return

  const org = await getOrgByClerkId(clerkOrgId)
  if (!org) return // org not synced; nothing to deactivate

  let stillMember = false
  try {
    const clerk = await clerkClient()
    const memberships = await clerk.users.getOrganizationMembershipList({ userId: clerkUserId, limit: 100 })
    stillMember = memberships.data.some((m) => m.organization.id === clerkOrgId)
  } catch {
    // User may have been deleted from Clerk entirely — treat as "not a member" and proceed.
  }
  if (stillMember) return

  await deactivateOwner(org.id, clerkUserId)
}
