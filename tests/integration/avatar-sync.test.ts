/**
 * syncMyAvatarAction: re-syncs the caller's OWN avatarUrl from Clerk's Backend API — never a
 * client-supplied value, never another user's row, and a no-op when nothing changed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const { mockAuth, mockClerkClient } = vi.hoisted(() => ({ mockAuth: vi.fn(), mockClerkClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@clerk/nextjs/server', () => ({ auth: () => mockAuth(), clerkClient: () => mockClerkClient() }))

import { prisma } from '@lib/prisma'
import { syncMyAvatarAction } from '@lib/actions/crm'

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
let orgA: Awaited<ReturnType<typeof prisma.organization.create>>
let orgB: Awaited<ReturnType<typeof prisma.organization.create>>
let ownerA1: Awaited<ReturnType<typeof prisma.owner.create>>
let ownerA2: Awaited<ReturnType<typeof prisma.owner.create>>

beforeAll(async () => {
  orgA = await prisma.organization.create({ data: { clerkOrgId: `test-avatar-a-${RUN}`, name: `Avatar A ${RUN}` } })
  orgB = await prisma.organization.create({ data: { clerkOrgId: `test-avatar-b-${RUN}`, name: `Avatar B ${RUN}` } })
  ownerA1 = await prisma.owner.create({
    data: { orgId: orgA.id, clerkUserId: `test-avatar-a1-${RUN}`, name: 'Owner A1', email: `a1-${RUN}@example.com`, role: 'Member' },
  })
  ownerA2 = await prisma.owner.create({
    data: { orgId: orgA.id, clerkUserId: `test-avatar-a2-${RUN}`, name: 'Owner A2', email: `a2-${RUN}@example.com`, role: 'Member' },
  })
})

afterAll(async () => {
  for (const org of [orgA, orgB]) {
    await prisma.owner.deleteMany({ where: { orgId: org.id } })
    await prisma.organization.delete({ where: { id: org.id } })
  }
  await prisma.$disconnect()
})

afterEach(async () => {
  mockAuth.mockReset()
  mockClerkClient.mockReset()
  await prisma.owner.update({ where: { id: ownerA1.id }, data: { avatarUrl: null } })
  await prisma.owner.update({ where: { id: ownerA2.id }, data: { avatarUrl: null } })
})

function loginAs(owner: { clerkUserId: string | null }, org: { clerkOrgId: string }) {
  mockAuth.mockResolvedValue({ userId: owner.clerkUserId, orgId: org.clerkOrgId, orgRole: 'org:member' })
}

function mockClerkUser(hasImage: boolean, imageUrl: string) {
  mockClerkClient.mockResolvedValue({ users: { getUser: async () => ({ hasImage, imageUrl }) } })
}

describe('syncMyAvatarAction', () => {
  it("updates only the caller's own row with the Backend API's image, ignoring hasImage=false's imageUrl placeholder", async () => {
    loginAs(ownerA1, orgA)
    mockClerkUser(true, 'https://img.clerk.com/real-photo.jpg')
    const result = await syncMyAvatarAction()
    expect(result).toEqual({ ok: true, avatarUrl: 'https://img.clerk.com/real-photo.jpg' })

    const fresh1 = await prisma.owner.findUniqueOrThrow({ where: { id: ownerA1.id } })
    const fresh2 = await prisma.owner.findUniqueOrThrow({ where: { id: ownerA2.id } })
    expect(fresh1.avatarUrl).toBe('https://img.clerk.com/real-photo.jpg')
    expect(fresh2.avatarUrl).toBeNull() // never touched — there is no id parameter to target another owner with
  })

  it('writes null when Clerk reports hasImage=false, even though imageUrl still has a placeholder value', async () => {
    loginAs(ownerA1, orgA)
    mockClerkUser(false, 'https://img.clerk.com/default-placeholder.png')
    const result = await syncMyAvatarAction()
    expect(result).toEqual({ ok: true, avatarUrl: null })
    const fresh = await prisma.owner.findUniqueOrThrow({ where: { id: ownerA1.id } })
    expect(fresh.avatarUrl).toBeNull()
  })

  it('is a no-op (no DB write) when the resolved avatarUrl already matches what is stored', async () => {
    loginAs(ownerA1, orgA)
    mockClerkUser(true, 'https://img.clerk.com/same.jpg')
    await syncMyAvatarAction()
    const afterFirst = await prisma.owner.findUniqueOrThrow({ where: { id: ownerA1.id } })

    await new Promise((r) => setTimeout(r, 20))
    await syncMyAvatarAction()
    const afterSecond = await prisma.owner.findUniqueOrThrow({ where: { id: ownerA1.id } })
    expect(afterSecond.updatedAt.getTime()).toBe(afterFirst.updatedAt.getTime()) // untouched the second time
  })

  it("never lets one user's call affect a different user in the same org", async () => {
    loginAs(ownerA2, orgA)
    mockClerkUser(true, 'https://img.clerk.com/a2-photo.jpg')
    await syncMyAvatarAction()
    const fresh1 = await prisma.owner.findUniqueOrThrow({ where: { id: ownerA1.id } })
    const fresh2 = await prisma.owner.findUniqueOrThrow({ where: { id: ownerA2.id } })
    expect(fresh1.avatarUrl).toBeNull()
    expect(fresh2.avatarUrl).toBe('https://img.clerk.com/a2-photo.jpg')
  })

  it("org isolation: a caller in org B's session can never resolve to an org A owner, by construction (ownerId always comes from the caller's own session)", async () => {
    const ownerB = await prisma.owner.create({
      data: { orgId: orgB.id, clerkUserId: `test-avatar-b1-${RUN}`, name: 'Owner B1', email: `b1-${RUN}@example.com`, role: 'Member' },
    })
    loginAs(ownerB, orgB)
    mockClerkUser(true, 'https://img.clerk.com/b1-photo.jpg')
    const result = await syncMyAvatarAction()
    expect(result).toEqual({ ok: true, avatarUrl: 'https://img.clerk.com/b1-photo.jpg' })

    const freshB = await prisma.owner.findUniqueOrThrow({ where: { id: ownerB.id } })
    const freshA1 = await prisma.owner.findUniqueOrThrow({ where: { id: ownerA1.id } })
    expect(freshB.avatarUrl).toBe('https://img.clerk.com/b1-photo.jpg')
    expect(freshA1.avatarUrl).toBeNull()
    await prisma.owner.delete({ where: { id: ownerB.id } })
  })
})
