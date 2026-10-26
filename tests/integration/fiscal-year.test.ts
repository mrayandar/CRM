/**
 * updateFiscalYearStartMonthAction: admin-only (plain requireAdmin — not the live-Clerk-role
 * check RepVisibility/AI-assist use, since this only changes display math, never who can see
 * what), validates the month range, and never lets one org affect another's setting.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@clerk/nextjs/server', () => ({ auth: () => mockAuth(), clerkClient: () => ({}) }))

import { prisma } from '@lib/prisma'
import * as actions from '@lib/actions/crm'

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
let orgA: Awaited<ReturnType<typeof prisma.organization.create>>
let orgB: Awaited<ReturnType<typeof prisma.organization.create>>
let adminA: Awaited<ReturnType<typeof prisma.owner.create>>
let memberA: Awaited<ReturnType<typeof prisma.owner.create>>

beforeAll(async () => {
  orgA = await prisma.organization.create({ data: { clerkOrgId: `test-fy-a-${RUN}`, name: `FY A ${RUN}` } })
  orgB = await prisma.organization.create({ data: { clerkOrgId: `test-fy-b-${RUN}`, name: `FY B ${RUN}` } })
  adminA = await prisma.owner.create({
    data: { orgId: orgA.id, clerkUserId: `test-fy-admin-${RUN}`, name: 'Admin', email: `admin-${RUN}@example.com`, role: 'Admin' },
  })
  memberA = await prisma.owner.create({
    data: { orgId: orgA.id, clerkUserId: `test-fy-member-${RUN}`, name: 'Member', email: `member-${RUN}@example.com`, role: 'Member' },
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
  await prisma.organization.update({ where: { id: orgA.id }, data: { fiscalYearStartMonth: 1 } })
  await prisma.organization.update({ where: { id: orgB.id }, data: { fiscalYearStartMonth: 1 } })
})

function loginAsAdminA() {
  mockAuth.mockResolvedValue({ userId: adminA.clerkUserId, orgId: orgA.clerkOrgId, orgRole: 'org:admin' })
}
function loginAsMemberA() {
  mockAuth.mockResolvedValue({ userId: memberA.clerkUserId, orgId: orgA.clerkOrgId, orgRole: 'org:member' })
}

describe('updateFiscalYearStartMonthAction', () => {
  it('rejects a Member with a typed forbidden result, and writes nothing', async () => {
    loginAsMemberA()
    const result = await actions.updateFiscalYearStartMonthAction({ fiscalYearStartMonth: 7 })
    expect(result).toEqual({ ok: false, error: 'forbidden' })
    const fresh = await prisma.organization.findUniqueOrThrow({ where: { id: orgA.id } })
    expect(fresh.fiscalYearStartMonth).toBe(1)
  })

  it('a real admin can change it', async () => {
    loginAsAdminA()
    const result = await actions.updateFiscalYearStartMonthAction({ fiscalYearStartMonth: 7 })
    expect(result).toEqual({ ok: true })
    const fresh = await prisma.organization.findUniqueOrThrow({ where: { id: orgA.id } })
    expect(fresh.fiscalYearStartMonth).toBe(7)
  })

  it.each([0, 13, -1, 1.5, NaN])('rejects an invalid month (%s) even for a real admin', async (month) => {
    loginAsAdminA()
    await expect(actions.updateFiscalYearStartMonthAction({ fiscalYearStartMonth: month })).rejects.toThrow(/Invalid month/)
  })

  it("org A's admin can never change org B's fiscal year start month", async () => {
    loginAsAdminA()
    await actions.updateFiscalYearStartMonthAction({ fiscalYearStartMonth: 10 })
    const freshA = await prisma.organization.findUniqueOrThrow({ where: { id: orgA.id } })
    const freshB = await prisma.organization.findUniqueOrThrow({ where: { id: orgB.id } })
    expect(freshA.fiscalYearStartMonth).toBe(10)
    expect(freshB.fiscalYearStartMonth).toBe(1) // never touched — the action has no orgId param to target another org with
  })
})
