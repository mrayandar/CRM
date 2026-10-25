/**
 * updateAiAssistEnabledAction: admin-only via requireLiveAdminAccess (live Clerk role check, not
 * just the DB's own Owner.role — same reasoning as updateRepVisibilityAction), plus the
 * AI_ASSIST_ALLOWED_ORG_IDS env allowlist, enforced here independent of the generate route's own
 * copy of the same check.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const { mockAuth, mockClerkClient } = vi.hoisted(() => ({ mockAuth: vi.fn(), mockClerkClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@clerk/nextjs/server', () => ({ auth: () => mockAuth(), clerkClient: () => mockClerkClient() }))

import { prisma } from '@lib/prisma'
import { updateAiAssistEnabledAction } from '@lib/actions/ai'

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const ORIGINAL_ALLOWLIST = process.env.AI_ASSIST_ALLOWED_ORG_IDS

let org: Awaited<ReturnType<typeof prisma.organization.create>>
let admin: Awaited<ReturnType<typeof prisma.owner.create>>
let member: Awaited<ReturnType<typeof prisma.owner.create>>

beforeAll(async () => {
  org = await prisma.organization.create({ data: { clerkOrgId: `test-ai-settings-${RUN}`, name: `AI Settings ${RUN}` } })
  admin = await prisma.owner.create({
    data: { orgId: org.id, clerkUserId: `test-ai-settings-admin-${RUN}`, name: 'Admin', email: `admin-${RUN}@example.com`, role: 'Admin' },
  })
  member = await prisma.owner.create({
    data: { orgId: org.id, clerkUserId: `test-ai-settings-member-${RUN}`, name: 'Member', email: `member-${RUN}@example.com`, role: 'Member' },
  })
})

afterAll(async () => {
  process.env.AI_ASSIST_ALLOWED_ORG_IDS = ORIGINAL_ALLOWLIST
  await prisma.owner.deleteMany({ where: { orgId: org.id } })
  await prisma.organization.delete({ where: { id: org.id } })
  await prisma.$disconnect()
})

afterEach(async () => {
  mockAuth.mockReset()
  mockClerkClient.mockReset()
  await prisma.organization.update({
    where: { id: org.id },
    data: { aiAssistEnabled: false, aiAssistEnabledChangedBy: null, aiAssistEnabledChangedAt: null },
  })
})

function loginAsAdmin() {
  mockAuth.mockResolvedValue({ userId: admin.clerkUserId, orgId: org.clerkOrgId, orgRole: 'org:admin' })
  mockClerkClient.mockResolvedValue({
    users: { getOrganizationMembershipList: async () => ({ data: [{ organization: { id: org.clerkOrgId }, role: 'org:admin' }], totalCount: 1 }) },
  })
}

function loginAsMember() {
  mockAuth.mockResolvedValue({ userId: member.clerkUserId, orgId: org.clerkOrgId, orgRole: 'org:member' })
}

describe('updateAiAssistEnabledAction', () => {
  it('rejects a Member outright, before any live Clerk call', async () => {
    loginAsMember()
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = org.id
    const result = await updateAiAssistEnabledAction(true)
    expect(result).toEqual({ ok: false, error: 'forbidden' })
    expect(mockClerkClient).not.toHaveBeenCalled()
  })

  it('rejects enabling when the org is not on the allowlist, even for a real admin', async () => {
    loginAsAdmin()
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = '' // org not listed
    const result = await updateAiAssistEnabledAction(true)
    expect(result).toEqual({ ok: false, error: 'not_allowlisted' })
    const fresh = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })
    expect(fresh.aiAssistEnabled).toBe(false)
  })

  it('a real admin can enable AI assist once the org is allowlisted, and it stamps who/when', async () => {
    loginAsAdmin()
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = org.id
    const result = await updateAiAssistEnabledAction(true)
    expect(result).toEqual({ ok: true, aiAssistEnabled: true, changedAt: expect.any(String) })
    const fresh = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })
    expect(fresh.aiAssistEnabled).toBe(true)
    expect(fresh.aiAssistEnabledChangedBy).toBe(admin.id)
    expect(fresh.aiAssistEnabledChangedAt).not.toBeNull()
  })

  it('disabling never needs the allowlist (turning it off is always allowed for a real admin)', async () => {
    loginAsAdmin()
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = org.id
    await updateAiAssistEnabledAction(true)
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = '' // org drops off the allowlist
    const result = await updateAiAssistEnabledAction(false)
    expect(result).toEqual({ ok: true, aiAssistEnabled: false, changedAt: expect.any(String) })
  })

  it('rejects immediately after a live Clerk demotion, even while Owner.role is still stale "Admin" in our DB', async () => {
    loginAsAdmin()
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = org.id
    mockClerkClient.mockResolvedValue({
      users: { getOrganizationMembershipList: async () => ({ data: [{ organization: { id: org.clerkOrgId }, role: 'org:member' }], totalCount: 1 }) },
    })
    const result = await updateAiAssistEnabledAction(true)
    expect(result).toEqual({ ok: false, error: 'forbidden' })
  })
})
