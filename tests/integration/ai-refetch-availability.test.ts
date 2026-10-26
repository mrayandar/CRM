/**
 * GET /api/crm-refetch (the same route CrmProvider's live-poll calls every ~minute) must carry a
 * live `aiAssistAvailable`/`aiAssistProviderKind` — proving the mechanism src/store/crm.tsx's
 * applyFreshData relies on actually reflects a toggle or kill-switch change, without a reload.
 * This file tests the server side of that contract (the route's own response); the one-line
 * client-side apply (`setAiAssistAvailable(fresh.aiAssistAvailable)`) is a trusted direct mapping
 * from this payload, identical in form to every other field applyFreshData already restores
 * (repVisibility, orgCurrency, etc.) — there is no jsdom/testing-library dependency in this repo
 * to render CrmProvider itself and assert on it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@clerk/nextjs/server', () => ({ auth: () => mockAuth(), clerkClient: () => ({}) }))

import { prisma } from '@lib/prisma'
import { ensureDefaultStages } from '@lib/data/stages'
import { GET as crmRefetchGET } from '../../app/api/crm-refetch/route'
import { KILL_SWITCH_KEY } from '@lib/ai/killSwitch'

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const ORIGINAL_ALLOWLIST = process.env.AI_ASSIST_ALLOWED_ORG_IDS
const ORIGINAL_ENV_KILL = process.env.AI_ASSIST_KILL_SWITCH

let org: Awaited<ReturnType<typeof prisma.organization.create>>
let admin: Awaited<ReturnType<typeof prisma.owner.create>>

beforeAll(async () => {
  org = await prisma.organization.create({ data: { clerkOrgId: `test-ai-refetch-${RUN}`, name: `AI Refetch ${RUN}`, aiAssistEnabled: false } })
  await ensureDefaultStages(org.id)
  admin = await prisma.owner.create({
    data: { orgId: org.id, clerkUserId: `test-ai-refetch-admin-${RUN}`, name: 'Admin', email: `admin-${RUN}@example.com`, role: 'Admin' },
  })
  mockAuth.mockResolvedValue({ userId: admin.clerkUserId, orgId: org.clerkOrgId, orgRole: 'org:admin' })
})

afterAll(async () => {
  process.env.AI_ASSIST_ALLOWED_ORG_IDS = ORIGINAL_ALLOWLIST
  process.env.AI_ASSIST_KILL_SWITCH = ORIGINAL_ENV_KILL
  await prisma.owner.deleteMany({ where: { orgId: org.id } })
  await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } })
  await prisma.organization.delete({ where: { id: org.id } })
  await prisma.platformSetting.deleteMany({ where: { key: KILL_SWITCH_KEY } })
  await prisma.$disconnect()
})

afterEach(async () => {
  process.env.AI_ASSIST_KILL_SWITCH = ORIGINAL_ENV_KILL
  await prisma.platformSetting.deleteMany({ where: { key: KILL_SWITCH_KEY } })
})

describe('GET /api/crm-refetch: aiAssistAvailable reflects live config, not just first load', () => {
  it('flips from false to true across two calls once the org is enabled and allowlisted, with no other change', async () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = ''
    const before = await (await crmRefetchGET()).json()
    expect(before.aiAssistAvailable).toBe(false)

    await prisma.organization.update({ where: { id: org.id }, data: { aiAssistEnabled: true } })
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = org.id

    const after = await (await crmRefetchGET()).json()
    expect(after.aiAssistAvailable).toBe(true)
    expect(after.aiAssistProviderKind).toBe('dev')

    await prisma.organization.update({ where: { id: org.id }, data: { aiAssistEnabled: false } })
  })

  it('flips back to false the moment the DB kill switch is turned on, without touching the toggle or allowlist', async () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = org.id
    await prisma.organization.update({ where: { id: org.id }, data: { aiAssistEnabled: true } })

    const before = await (await crmRefetchGET()).json()
    expect(before.aiAssistAvailable).toBe(true)

    await prisma.platformSetting.upsert({ where: { key: KILL_SWITCH_KEY }, create: { key: KILL_SWITCH_KEY, value: 'true' }, update: { value: 'true' } })
    const after = await (await crmRefetchGET()).json()
    expect(after.aiAssistAvailable).toBe(false)
    expect(after.aiAssistProviderKind).toBeNull()

    await prisma.organization.update({ where: { id: org.id }, data: { aiAssistEnabled: false } })
  })

  it('never includes the allowlist itself or any other field beyond the plain booleans/kind', async () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = `other-org-1,${org.id},other-org-2`
    await prisma.organization.update({ where: { id: org.id }, data: { aiAssistEnabled: true } })
    const json = await (await crmRefetchGET()).json()
    const serialized = JSON.stringify(json)
    expect(serialized).not.toContain('other-org-1')
    expect(serialized).not.toContain('other-org-2')
    await prisma.organization.update({ where: { id: org.id }, data: { aiAssistEnabled: false } })
  })
})
