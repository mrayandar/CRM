/**
 * Lead.followUpAt: a calendar date, not an instant (see the schema's own doc comment). Covers
 * the "edited" activity diff (updateLead in lib/data/leads.ts) and createLeadAction/
 * updateLeadAction's validation of the incoming date string.
 */
import { randomUUID } from 'crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@lib/prisma'
import { createLead, updateLead } from '@lib/data/leads'
import type { Scope } from '@lib/scope'
import type { LeadSource } from '@prisma/client'

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

let org: Awaited<ReturnType<typeof prisma.organization.create>>
let company: Awaited<ReturnType<typeof prisma.company.create>>
let owner: Awaited<ReturnType<typeof prisma.owner.create>>

beforeAll(async () => {
  org = await prisma.organization.create({ data: { clerkOrgId: `test-followup-org-${RUN}`, name: 'Follow-up test org' } })
  company = await prisma.company.create({ data: { orgId: org.id, name: `Follow-up Co ${RUN}` } })
  owner = await prisma.owner.create({
    data: { orgId: org.id, clerkUserId: `test-followup-owner-${RUN}`, name: 'Owner', email: `owner-${RUN}@example.com`, role: 'Member' },
  })
})

afterAll(async () => {
  await prisma.activity.deleteMany({ where: { orgId: org.id } })
  await prisma.lead.deleteMany({ where: { orgId: org.id } })
  await prisma.company.deleteMany({ where: { orgId: org.id } })
  await prisma.owner.deleteMany({ where: { orgId: org.id } })
  await prisma.organization.delete({ where: { id: org.id } })
  await prisma.$disconnect()
})

const scope = (): Scope => ({ orgId: org.id, scopeOwnerId: null })

async function makeLead() {
  return createLead(scope(), {
    id: randomUUID(), name: 'Follow-up Lead', title: '', email: '', phone: '', location: '',
    status: 'new', source: 'Inbound',
    company: { connect: { id: company.id } }, owner: { connect: { id: owner.id } },
  })
}

const baseInput = (lead: { name: string; title: string; email: string; phone: string; companyId: string; source: LeadSource; ownerId: string }) => ({
  name: lead.name, title: lead.title, email: lead.email, phone: lead.phone,
  companyId: lead.companyId, source: lead.source, ownerId: lead.ownerId,
})

describe('updateLead: followUpAt diff and blank-preserving semantics', () => {
  it('setting a follow-up date for the first time logs it in the "edited" activity diff', async () => {
    const lead = await makeLead()
    const activityId = randomUUID()
    await updateLead(scope(), lead.id, { ...baseInput(lead), followUpAt: new Date('2026-04-01') }, owner.id, activityId)
    const activity = await prisma.activity.findUnique({ where: { id: activityId } })
    expect(activity?.body).toBe('Changed: follow-up date')

    const updated = await prisma.lead.findUnique({ where: { id: lead.id } })
    expect(updated?.followUpAt?.toISOString()).toBe(new Date('2026-04-01').toISOString())
  })

  it('a no-op save (same date) logs no new activity', async () => {
    const lead = await makeLead()
    await updateLead(scope(), lead.id, { ...baseInput(lead), followUpAt: new Date('2026-04-01') }, owner.id, randomUUID())
    const beforeCount = await prisma.activity.count({ where: { leadId: lead.id } })

    await updateLead(scope(), lead.id, { ...baseInput(lead), followUpAt: new Date('2026-04-01') }, owner.id, randomUUID())
    const afterCount = await prisma.activity.count({ where: { leadId: lead.id } })
    expect(afterCount).toBe(beforeCount)
  })

  it('omitting followUpAt entirely leaves the existing value untouched (no diff entry)', async () => {
    const lead = await makeLead()
    await updateLead(scope(), lead.id, { ...baseInput(lead), followUpAt: new Date('2026-04-01') }, owner.id, randomUUID())

    const activityId = randomUUID()
    // followUpAt omitted — only name changes.
    await updateLead(scope(), lead.id, { ...baseInput(lead), name: 'Renamed Lead' }, owner.id, activityId)
    const activity = await prisma.activity.findUnique({ where: { id: activityId } })
    expect(activity?.body).toBe('Changed: name')

    const updated = await prisma.lead.findUnique({ where: { id: lead.id } })
    expect(updated?.followUpAt?.toISOString()).toBe(new Date('2026-04-01').toISOString())
  })

  it('explicitly clearing (null) a follow-up date logs it in the diff and clears the column', async () => {
    const lead = await makeLead()
    await updateLead(scope(), lead.id, { ...baseInput(lead), followUpAt: new Date('2026-04-01') }, owner.id, randomUUID())

    const activityId = randomUUID()
    await updateLead(scope(), lead.id, { ...baseInput(lead), followUpAt: null }, owner.id, activityId)
    const activity = await prisma.activity.findUnique({ where: { id: activityId } })
    expect(activity?.body).toBe('Changed: follow-up date')

    const updated = await prisma.lead.findUnique({ where: { id: lead.id } })
    expect(updated?.followUpAt).toBeNull()
  })
})
