import { headers } from 'next/headers'
import { Webhook } from 'svix'
import { upsertOrg, updateOrg, deleteOrg, getOrgByClerkId } from '@lib/data/organizations'
import { upsertOwnerFromClerk } from '@lib/data/owners'

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
    event = wh.verify(body, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    }) as unknown as WebhookEvent
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
  await upsertOrg({ clerkOrgId, name })
}

async function handleOrgUpdated(data: Record<string, unknown>) {
  const clerkOrgId = data.id as string
  const name = data.name as string | undefined
  if (name) {
    await updateOrg(clerkOrgId, { name }).catch(() => {
      // Org might not exist yet if created on-demand hasn't run
    })
  }
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

  const name = [
    publicUserData?.first_name,
    publicUserData?.last_name,
  ].filter(Boolean).join(' ') || (publicUserData?.identifier as string) || 'Team Member'

  const email = (publicUserData?.identifier as string) ?? ''
  const role = (data.role as string) === 'admin' ? 'Admin' : 'Member'
  const avatarUrl = publicUserData?.image_url as string | undefined

  await upsertOwnerFromClerk(org.id, clerkUserId, {
    name,
    email,
    role,
    avatarUrl: avatarUrl ?? null,
  })
}

async function handleMemberUpdated(data: Record<string, unknown>) {
  // Same logic as created — upsert handles both
  await handleMemberCreated(data)
}
