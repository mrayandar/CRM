/**
 * Permanent regression guard for multi-tenant data isolation.
 *
 * Creates two real Organizations (with real Owners/Leads/Contacts/Deals/
 * Tasks/PipelineStages) in the real database, then attempts cross-tenant
 * access through every lib/data/*.ts function and every server action in
 * lib/actions/crm.ts: reading, editing, deleting/mutating, and reassigning
 * records across the org boundary. Every one of these must fail — if any
 * of them succeeds, a tenant can read or write another tenant's CRM data.
 *
 * Clerk's `auth()` is mocked (so this can run outside an HTTP request),
 * but `requireAuth()` itself is real: it still does a real DB lookup from
 * the mocked Clerk session to a real Organization/Owner row, exactly as
 * it does in production. Only the Clerk session boundary is stubbed —
 * every org/tenant boundary check under test is real application code
 * running against the real database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }))

vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@clerk/nextjs/server', () => ({
  auth: () => mockAuth(),
  clerkClient: vi.fn(),
}))

import { prisma } from '@lib/prisma'
import { getLeadById, listLeads, updateLeadStatus, updateLead, convertLeadToDeal } from '@lib/data/leads'
import { getContactById, listContacts, updateContact, addContactTag } from '@lib/data/contacts'
import { getDealById, listDeals, updateDeal, moveDealToStage } from '@lib/data/deals'
import { getCompanyById, getCompanyDetail, deleteCompany } from '@lib/data/companies'
import { getOwnerById, listOwners } from '@lib/data/owners'
import { getTaskById, listTasks, toggleTaskDone, updateTask, deleteTask } from '@lib/data/tasks'
import { listActivities } from '@lib/data/activities'
import { ensureDefaultStages, getStageById, listStages, renameStage, reorderStage, deleteStage } from '@lib/data/stages'
import * as actions from '@lib/actions/crm'
import type { PipelineStage } from '@prisma/client'

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

interface Fixture {
  org: Awaited<ReturnType<typeof prisma.organization.create>>
  owner: Awaited<ReturnType<typeof prisma.owner.create>>
  company: Awaited<ReturnType<typeof prisma.company.create>>
  lead: Awaited<ReturnType<typeof prisma.lead.create>>
  contact: Awaited<ReturnType<typeof prisma.contact.create>>
  deal: Awaited<ReturnType<typeof prisma.deal.create>>
  task: Awaited<ReturnType<typeof prisma.task.create>>
  stages: PipelineStage[]
  /** This org's "discovery"-equivalent open stage — what the deal fixture sits in. */
  stage: PipelineStage
  /** A second open stage, for move/reorder tests. */
  otherStage: PipelineStage
}

async function makeFixture(tag: 'a' | 'b'): Promise<Fixture> {
  const org = await prisma.organization.create({
    data: { clerkOrgId: `test-clerk-org-${tag}-${RUN}`, name: `Cross-tenant test org ${tag}` },
  })
  await ensureDefaultStages(org.id)
  const stages = await listStages(org.id)
  const stage = stages.find((s) => s.key === 'discovery')!
  const otherStage = stages.find((s) => s.key === 'proposal')!

  const owner = await prisma.owner.create({
    data: {
      orgId: org.id,
      clerkUserId: `test-clerk-user-${tag}-${RUN}`,
      name: `Owner ${tag}`,
      email: `owner-${tag}-${RUN}@example.com`,
      role: 'Admin',
    },
  })
  const company = await prisma.company.create({
    data: { orgId: org.id, name: `Co ${tag}` },
  })
  const lead = await prisma.lead.create({
    data: {
      orgId: org.id,
      name: `Lead ${tag}`,
      title: '',
      companyId: company.id,
      email: `lead-${tag}-${RUN}@example.com`,
      phone: '',
      source: 'Inbound',
      location: '',
      ownerId: owner.id,
    },
  })
  const contact = await prisma.contact.create({
    data: {
      orgId: org.id,
      name: `Contact ${tag}`,
      title: '',
      companyId: company.id,
      email: `contact-${tag}-${RUN}@example.com`,
      phone: '',
      location: '',
      ownerId: owner.id,
    },
  })
  const deal = await prisma.deal.create({
    data: {
      orgId: org.id,
      name: `Deal ${tag}`,
      companyId: company.id,
      value: 1000,
      source: 'Inbound',
      probability: stage.probability,
      stageId: stage.id,
      closeDate: new Date(),
      ownerId: owner.id,
      contactId: contact.id,
    },
  })
  const task = await prisma.task.create({
    data: { orgId: org.id, title: `Task ${tag}`, dueDate: new Date(), ownerId: owner.id },
  })
  return { org, owner, company, lead, contact, deal, task, stages, stage, otherStage }
}

async function destroyFixture(f: Fixture) {
  const orgId = f.org.id
  await prisma.activity.deleteMany({ where: { orgId } })
  await prisma.task.deleteMany({ where: { orgId } })
  await prisma.deal.deleteMany({ where: { orgId } })
  await prisma.contact.deleteMany({ where: { orgId } })
  await prisma.lead.deleteMany({ where: { orgId } })
  await prisma.company.deleteMany({ where: { orgId } })
  await prisma.owner.deleteMany({ where: { orgId } })
  await prisma.pipelineStage.deleteMany({ where: { orgId } })
  await prisma.organization.delete({ where: { id: orgId } })
}

function loginAs(f: Fixture) {
  mockAuth.mockResolvedValue({ userId: f.owner.clerkUserId, orgId: f.org.clerkOrgId })
}

let A: Fixture
let B: Fixture

beforeAll(async () => {
  A = await makeFixture('a')
  B = await makeFixture('b')
})

afterAll(async () => {
  await destroyFixture(A)
  await destroyFixture(B)
  await prisma.$disconnect()
})

describe('lib/data: reads are scoped by orgId', () => {
  it('getLeadById returns null for another org\'s lead', async () => {
    expect(await getLeadById(B.org.id, A.lead.id)).toBeNull()
  })
  it('getContactById returns null for another org\'s contact', async () => {
    expect(await getContactById(B.org.id, A.contact.id)).toBeNull()
  })
  it('getDealById returns null for another org\'s deal', async () => {
    expect(await getDealById(B.org.id, A.deal.id)).toBeNull()
  })
  it('getOwnerById returns null for another org\'s owner', async () => {
    expect(await getOwnerById(B.org.id, A.owner.id)).toBeNull()
  })
  it('getTaskById returns null for another org\'s task', async () => {
    expect(await getTaskById(B.org.id, A.task.id)).toBeNull()
  })
  it('getStageById returns null for another org\'s stage', async () => {
    expect(await getStageById(B.org.id, A.stage.id)).toBeNull()
  })
  it('getCompanyById returns null for another org\'s company', async () => {
    expect(await getCompanyById(B.org.id, A.company.id)).toBeNull()
  })
  it('getCompanyDetail returns null for another org\'s company', async () => {
    expect(await getCompanyDetail(B.org.id, A.company.id)).toBeNull()
  })
  it('listLeads never includes another org\'s leads', async () => {
    expect((await listLeads(B.org.id)).map((l) => l.id)).not.toContain(A.lead.id)
  })
  it('listContacts never includes another org\'s contacts', async () => {
    expect((await listContacts(B.org.id)).map((c) => c.id)).not.toContain(A.contact.id)
  })
  it('listDeals never includes another org\'s deals', async () => {
    expect((await listDeals(B.org.id)).map((d) => d.id)).not.toContain(A.deal.id)
  })
  it('listOwners never includes another org\'s owners', async () => {
    expect((await listOwners(B.org.id)).map((o) => o.id)).not.toContain(A.owner.id)
  })
  it('listTasks never includes another org\'s tasks', async () => {
    expect((await listTasks(B.org.id)).map((t) => t.id)).not.toContain(A.task.id)
  })
  it('listStages never includes another org\'s stages', async () => {
    const bStageIds = (await listStages(B.org.id)).map((s) => s.id)
    for (const s of A.stages) expect(bStageIds).not.toContain(s.id)
  })
  it('listActivities never includes another org\'s activities', async () => {
    const activityA = await prisma.activity.create({
      data: { orgId: A.org.id, kind: 'note', title: 'org A only', actorId: A.owner.id },
    })
    expect((await listActivities(B.org.id)).map((x) => x.id)).not.toContain(activityA.id)
  })
})

describe('lib/data: writes reject a record id from another org', () => {
  it('updateLeadStatus throws', async () => {
    await expect(updateLeadStatus(B.org.id, A.lead.id, 'contacted')).rejects.toThrow()
  })
  it('updateLead throws', async () => {
    await expect(
      updateLead(
        B.org.id,
        A.lead.id,
        { name: 'x', title: '', email: '', phone: '', companyId: B.company.id, source: 'Inbound', ownerId: B.owner.id },
        B.owner.id,
      ),
    ).rejects.toThrow()
  })
  it('convertLeadToDeal throws', async () => {
    await expect(
      convertLeadToDeal(B.org.id, A.lead.id, { ownerId: B.owner.id, actorId: B.owner.id }),
    ).rejects.toThrow()
  })
  it('updateContact throws', async () => {
    await expect(
      updateContact(
        B.org.id,
        A.contact.id,
        { name: 'x', title: '', email: '', phone: '', companyId: B.company.id, ownerId: B.owner.id },
        B.owner.id,
      ),
    ).rejects.toThrow()
  })
  it('addContactTag throws', async () => {
    await expect(addContactTag(B.org.id, A.contact.id, 'tag')).rejects.toThrow()
  })
  it('updateDeal throws', async () => {
    await expect(
      updateDeal(
        B.org.id,
        A.deal.id,
        {
          name: 'x',
          value: 100,
          stage: { id: B.stage.id, probability: B.stage.probability, isWon: B.stage.isWon },
          closeDate: new Date(),
          contactId: null,
          ownerId: B.owner.id,
          companyId: B.company.id,
        },
        B.owner.id,
      ),
    ).rejects.toThrow()
  })
  it('moveDealToStage throws', async () => {
    await expect(
      moveDealToStage(B.org.id, A.deal.id, {
        id: B.otherStage.id,
        probability: B.otherStage.probability,
        isWon: B.otherStage.isWon,
      }),
    ).rejects.toThrow()
  })
  it('toggleTaskDone throws', async () => {
    await expect(toggleTaskDone(B.org.id, A.task.id, true)).rejects.toThrow()
  })
  it('updateTask throws', async () => {
    await expect(
      updateTask(
        B.org.id,
        A.task.id,
        { title: 'x', description: null, dueDate: new Date(), priority: 'low', type: 'todo', ownerId: B.owner.id },
        B.owner.id,
      ),
    ).rejects.toThrow()
  })
  it('deleteTask throws', async () => {
    await expect(deleteTask(B.org.id, A.task.id)).rejects.toThrow()
  })
  it('renameStage throws', async () => {
    await expect(renameStage(B.org.id, A.stage.id, 'Hijacked')).rejects.toThrow()
  })
  it('reorderStage throws', async () => {
    await expect(reorderStage(B.org.id, A.stage.id, 'down')).rejects.toThrow()
  })
  it('deleteStage throws', async () => {
    await expect(deleteStage(B.org.id, A.stage.id)).rejects.toThrow()
  })
  it('deleteCompany throws for another org\'s company', async () => {
    await expect(deleteCompany(B.org.id, A.company.id)).rejects.toThrow()
  })

  it('none of the above mutated the org A rows', async () => {
    const lead = await prisma.lead.findUnique({ where: { id: A.lead.id } })
    const contact = await prisma.contact.findUnique({ where: { id: A.contact.id } })
    const deal = await prisma.deal.findUnique({ where: { id: A.deal.id } })
    const task = await prisma.task.findUnique({ where: { id: A.task.id } })
    const stage = await prisma.pipelineStage.findUnique({ where: { id: A.stage.id } })
    const company = await prisma.company.findUnique({ where: { id: A.company.id } })
    expect(lead?.status).toBe('new')
    expect(contact?.name).toBe(A.contact.name)
    expect(deal?.stageId).toBe(A.stage.id)
    expect(task).not.toBeNull()
    expect(task?.title).toBe(A.task.title)
    expect(task?.done).toBe(false)
    expect(stage?.label).toBe(A.stage.label)
    expect(company).not.toBeNull()
    expect(company?.name).toBe(A.company.name)
  })
})

describe('server actions: reject a client-supplied ownerId/contactId/stageId from another org', () => {
  beforeEach(() => loginAs(B))

  it('createLeadAction rejects an ownerId from another org', async () => {
    await expect(
      actions.createLeadAction({
        id: crypto.randomUUID(),
        name: 'x',
        email: '',
        phone: '',
        companyId: B.company.id,
        source: 'Inbound',
        status: 'new',
        ownerId: A.owner.id,
      }),
    ).rejects.toThrow(/Owner not found/)
  })

  it('createContactAction rejects an ownerId from another org', async () => {
    await expect(
      actions.createContactAction({
        id: crypto.randomUUID(),
        name: 'x',
        email: '',
        phone: '',
        companyId: B.company.id,
        title: '',
        ownerId: A.owner.id,
      }),
    ).rejects.toThrow(/Owner not found/)
  })

  it('createDealAction rejects an ownerId from another org', async () => {
    await expect(
      actions.createDealAction({
        id: crypto.randomUUID(),
        name: 'x',
        companyId: B.company.id,
        value: 100,
        stageId: B.stage.id,
        closeDate: new Date().toISOString(),
        ownerId: A.owner.id,
        source: 'Inbound',
        priority: 'low',
      }),
    ).rejects.toThrow(/Owner not found/)
  })

  it('createDealAction rejects a stageId from another org', async () => {
    await expect(
      actions.createDealAction({
        id: crypto.randomUUID(),
        name: 'x',
        companyId: B.company.id,
        value: 100,
        stageId: A.stage.id,
        closeDate: new Date().toISOString(),
        ownerId: B.owner.id,
        source: 'Inbound',
        priority: 'low',
      }),
    ).rejects.toThrow(/Stage not found/)
  })

  it('createDealAction rejects a contactId from another org', async () => {
    await expect(
      actions.createDealAction({
        id: crypto.randomUUID(),
        name: 'x',
        companyId: B.company.id,
        value: 100,
        stageId: B.stage.id,
        closeDate: new Date().toISOString(),
        ownerId: B.owner.id,
        contactId: A.contact.id,
        source: 'Inbound',
        priority: 'low',
      }),
    ).rejects.toThrow(/Contact not found/)
  })

  it('updateLeadAction rejects a lead id from another org', async () => {
    await expect(
      actions.updateLeadAction({
        id: A.lead.id,
        name: 'x',
        title: '',
        email: '',
        phone: '',
        companyId: B.company.id,
        source: 'Inbound',
        ownerId: B.owner.id,
      }),
    ).rejects.toThrow()
    expect((await prisma.lead.findUnique({ where: { id: A.lead.id } }))?.name).toBe(A.lead.name)
  })

  it('updateLeadAction rejects an ownerId from another org, even on the caller\'s own lead', async () => {
    const own = await prisma.lead.create({
      data: { orgId: B.org.id, name: 'B-own-lead', title: '', companyId: B.company.id, email: '', phone: '', source: 'Inbound', location: '', ownerId: B.owner.id },
    })
    await expect(
      actions.updateLeadAction({
        id: own.id,
        name: 'x',
        title: '',
        email: '',
        phone: '',
        companyId: B.company.id,
        source: 'Inbound',
        ownerId: A.owner.id,
      }),
    ).rejects.toThrow(/Owner not found/)
  })

  it('updateContactAction rejects a contact id from another org', async () => {
    await expect(
      actions.updateContactAction({
        id: A.contact.id,
        name: 'x',
        title: '',
        email: '',
        phone: '',
        companyId: B.company.id,
        ownerId: B.owner.id,
      }),
    ).rejects.toThrow()
    expect((await prisma.contact.findUnique({ where: { id: A.contact.id } }))?.name).toBe(A.contact.name)
  })

  it('updateDealAction rejects a deal id from another org', async () => {
    await expect(
      actions.updateDealAction({
        id: A.deal.id,
        name: 'x',
        value: 100,
        stageId: B.stage.id,
        closeDate: new Date().toISOString(),
        ownerId: B.owner.id,
        companyId: B.company.id,
      }),
    ).rejects.toThrow()
    expect((await prisma.deal.findUnique({ where: { id: A.deal.id } }))?.name).toBe(A.deal.name)
  })

  it('updateDealAction rejects a stageId from another org', async () => {
    const own = await prisma.deal.create({
      data: { orgId: B.org.id, name: 'B-own-deal-stage', companyId: B.company.id, value: 1, source: 'Inbound', probability: 20, stageId: B.stage.id, closeDate: new Date(), ownerId: B.owner.id },
    })
    await expect(
      actions.updateDealAction({
        id: own.id,
        name: 'x',
        value: 100,
        stageId: A.stage.id,
        closeDate: new Date().toISOString(),
        ownerId: B.owner.id,
        companyId: B.company.id,
      }),
    ).rejects.toThrow(/Stage not found/)
  })

  it('updateDealAction rejects a contactId from another org', async () => {
    const own = await prisma.deal.create({
      data: { orgId: B.org.id, name: 'B-own-deal', companyId: B.company.id, value: 1, source: 'Inbound', probability: 20, stageId: B.stage.id, closeDate: new Date(), ownerId: B.owner.id },
    })
    await expect(
      actions.updateDealAction({
        id: own.id,
        name: 'x',
        value: 100,
        stageId: B.stage.id,
        closeDate: new Date().toISOString(),
        ownerId: B.owner.id,
        contactId: A.contact.id,
        companyId: B.company.id,
      }),
    ).rejects.toThrow(/Contact not found/)
  })

  it('moveDealAction (kanban drag) rejects a deal id from another org', async () => {
    await expect(actions.moveDealAction(A.deal.id, B.otherStage.id)).rejects.toThrow()
    expect((await prisma.deal.findUnique({ where: { id: A.deal.id } }))?.stageId).toBe(A.stage.id)
  })

  it('moveDealAction rejects a stageId from another org, even on the caller\'s own deal', async () => {
    const own = await prisma.deal.create({
      data: { orgId: B.org.id, name: 'B-own-deal-2', companyId: B.company.id, value: 1, source: 'Inbound', probability: 20, stageId: B.stage.id, closeDate: new Date(), ownerId: B.owner.id },
    })
    await expect(actions.moveDealAction(own.id, A.otherStage.id)).rejects.toThrow(/Stage not found/)
  })

  it('setLeadStatusAction rejects a lead id from another org', async () => {
    await expect(actions.setLeadStatusAction(A.lead.id, 'contacted')).rejects.toThrow()
    expect((await prisma.lead.findUnique({ where: { id: A.lead.id } }))?.status).toBe('new')
  })

  it('convertLeadAction rejects a lead id from another org', async () => {
    await expect(
      actions.convertLeadAction(A.lead.id, { ownerId: B.owner.id, contactId: crypto.randomUUID() }),
    ).rejects.toThrow()
    expect((await prisma.lead.findUnique({ where: { id: A.lead.id } }))?.status).toBe('new')
  })

  it('convertLeadAction rejects an ownerId from another org', async () => {
    const own = await prisma.lead.create({
      data: { orgId: B.org.id, name: 'B-own-lead-2', title: '', companyId: B.company.id, email: '', phone: '', source: 'Inbound', location: '', ownerId: B.owner.id },
    })
    await expect(
      actions.convertLeadAction(own.id, { ownerId: A.owner.id, contactId: crypto.randomUUID() }),
    ).rejects.toThrow(/Owner not found/)
  })

  it('convertLeadAction rejects a stageId from another org when opening a deal', async () => {
    const own = await prisma.lead.create({
      data: { orgId: B.org.id, name: 'B-own-lead-3', title: '', companyId: B.company.id, email: '', phone: '', source: 'Inbound', location: '', ownerId: B.owner.id },
    })
    await expect(
      actions.convertLeadAction(own.id, {
        ownerId: B.owner.id,
        contactId: crypto.randomUUID(),
        dealId: crypto.randomUUID(),
        deal: { name: 'x', value: 100, stageId: A.stage.id, closeDate: new Date().toISOString(), priority: 'low' },
      }),
    ).rejects.toThrow(/Stage not found/)
  })

  it('toggleTaskAction rejects a task id from another org', async () => {
    await expect(actions.toggleTaskAction(A.task.id, true)).rejects.toThrow()
    expect((await prisma.task.findUnique({ where: { id: A.task.id } }))?.done).toBe(false)
  })

  it('updateTaskAction rejects a task id from another org', async () => {
    await expect(
      actions.updateTaskAction({
        id: A.task.id,
        title: 'x',
        dueDate: new Date().toISOString(),
        priority: 'low',
        type: 'todo',
        ownerId: B.owner.id,
      }),
    ).rejects.toThrow()
    expect((await prisma.task.findUnique({ where: { id: A.task.id } }))?.title).toBe(A.task.title)
  })

  it('updateTaskAction rejects an ownerId from another org, even on the caller\'s own task', async () => {
    const own = await prisma.task.create({
      data: { orgId: B.org.id, title: 'B-own-task', dueDate: new Date(), ownerId: B.owner.id },
    })
    await expect(
      actions.updateTaskAction({
        id: own.id,
        title: 'x',
        dueDate: new Date().toISOString(),
        priority: 'low',
        type: 'todo',
        ownerId: A.owner.id,
      }),
    ).rejects.toThrow(/Owner not found/)
  })

  it('deleteTaskAction rejects a task id from another org', async () => {
    await expect(actions.deleteTaskAction(A.task.id)).rejects.toThrow()
    expect(await prisma.task.findUnique({ where: { id: A.task.id } })).not.toBeNull()
  })

  it('addTaskAction rejects an assignee ownerId from another org', async () => {
    await expect(
      actions.addTaskAction({ id: crypto.randomUUID(), title: 'x', dueDate: new Date().toISOString(), priority: 'low', ownerId: A.owner.id }),
    ).rejects.toThrow(/Owner not found/)
  })

  it('addTaskAction rejects a subject lead from another org', async () => {
    await expect(
      actions.addTaskAction({
        id: crypto.randomUUID(),
        title: 'x',
        dueDate: new Date().toISOString(),
        priority: 'low',
        subject: { type: 'lead', id: A.lead.id, label: 'x' },
      }),
    ).rejects.toThrow()
  })

  it('addTaskAction rejects a subject contact from another org', async () => {
    await expect(
      actions.addTaskAction({
        id: crypto.randomUUID(),
        title: 'x',
        dueDate: new Date().toISOString(),
        priority: 'low',
        subject: { type: 'contact', id: A.contact.id, label: 'x' },
      }),
    ).rejects.toThrow()
  })

  it('addTaskAction rejects a subject deal from another org', async () => {
    await expect(
      actions.addTaskAction({
        id: crypto.randomUUID(),
        title: 'x',
        dueDate: new Date().toISOString(),
        priority: 'low',
        subject: { type: 'deal', id: A.deal.id, label: 'x' },
      }),
    ).rejects.toThrow()
  })

  it('logActivityAction rejects a subject lead from another org', async () => {
    await expect(actions.logActivityAction('note', 'x', { type: 'lead', id: A.lead.id, label: 'x' })).rejects.toThrow()
  })

  it('logActivityAction rejects a subject contact from another org', async () => {
    await expect(actions.logActivityAction('note', 'x', { type: 'contact', id: A.contact.id, label: 'x' })).rejects.toThrow()
  })

  it('logActivityAction rejects a subject deal from another org', async () => {
    await expect(actions.logActivityAction('note', 'x', { type: 'deal', id: A.deal.id, label: 'x' })).rejects.toThrow()
  })

  it('addNoteAction rejects a subject from another org', async () => {
    await expect(actions.addNoteAction({ type: 'lead', id: A.lead.id, label: 'x' }, 'body')).rejects.toThrow()
  })

  it('renameStageAction rejects a stage id from another org', async () => {
    await expect(actions.renameStageAction(A.stage.id, 'Hijacked')).rejects.toThrow()
    expect((await prisma.pipelineStage.findUnique({ where: { id: A.stage.id } }))?.label).toBe(A.stage.label)
  })

  it('reorderStageAction rejects a stage id from another org', async () => {
    await expect(actions.reorderStageAction(A.stage.id, 'down')).rejects.toThrow()
    expect((await prisma.pipelineStage.findUnique({ where: { id: A.stage.id } }))?.order).toBe(A.stage.order)
  })

  it('deleteStageAction rejects a stage id from another org', async () => {
    await expect(actions.deleteStageAction(A.stage.id)).rejects.toThrow()
    expect(await prisma.pipelineStage.findUnique({ where: { id: A.stage.id } })).not.toBeNull()
  })

  it('updateCompanyAction rejects a company id from another org', async () => {
    await expect(actions.updateCompanyAction({ id: A.company.id, name: 'Hijacked' })).rejects.toThrow()
    expect((await prisma.company.findUnique({ where: { id: A.company.id } }))?.name).toBe(A.company.name)
  })

  it('deleteCompanyAction rejects a company id from another org', async () => {
    await expect(actions.deleteCompanyAction(A.company.id)).rejects.toThrow()
    expect(await prisma.company.findUnique({ where: { id: A.company.id } })).not.toBeNull()
  })

  it('createLeadAction rejects a companyId from another org', async () => {
    await expect(
      actions.createLeadAction({
        id: crypto.randomUUID(),
        name: 'x',
        email: '',
        phone: '',
        companyId: A.company.id,
        source: 'Inbound',
        status: 'new',
        ownerId: B.owner.id,
      }),
    ).rejects.toThrow(/Company not found/)
  })

  it('createContactAction rejects a companyId from another org', async () => {
    await expect(
      actions.createContactAction({
        id: crypto.randomUUID(),
        name: 'x',
        email: '',
        phone: '',
        companyId: A.company.id,
        title: '',
        ownerId: B.owner.id,
      }),
    ).rejects.toThrow(/Company not found/)
  })

  it('createDealAction rejects a companyId from another org', async () => {
    await expect(
      actions.createDealAction({
        id: crypto.randomUUID(),
        name: 'x',
        companyId: A.company.id,
        value: 100,
        stageId: B.stage.id,
        closeDate: new Date().toISOString(),
        ownerId: B.owner.id,
        source: 'Inbound',
        priority: 'low',
      }),
    ).rejects.toThrow(/Company not found/)
  })

  it('updateLeadAction rejects a companyId from another org, even on the caller\'s own lead', async () => {
    const own = await prisma.lead.create({
      data: { orgId: B.org.id, name: 'B-own-lead-company', title: '', companyId: B.company.id, email: '', phone: '', source: 'Inbound', location: '', ownerId: B.owner.id },
    })
    await expect(
      actions.updateLeadAction({
        id: own.id,
        name: 'x',
        title: '',
        email: '',
        phone: '',
        companyId: A.company.id,
        source: 'Inbound',
        ownerId: B.owner.id,
      }),
    ).rejects.toThrow(/Company not found/)
  })

  it('updateContactAction rejects a companyId from another org, even on the caller\'s own contact', async () => {
    const own = await prisma.contact.create({
      data: { orgId: B.org.id, name: 'B-own-contact', title: '', companyId: B.company.id, email: '', phone: '', location: '', ownerId: B.owner.id },
    })
    await expect(
      actions.updateContactAction({
        id: own.id,
        name: 'x',
        title: '',
        email: '',
        phone: '',
        companyId: A.company.id,
        ownerId: B.owner.id,
      }),
    ).rejects.toThrow(/Company not found/)
  })

  it('updateDealAction rejects a companyId from another org, even on the caller\'s own deal', async () => {
    const own = await prisma.deal.create({
      data: { orgId: B.org.id, name: 'B-own-deal-company', companyId: B.company.id, value: 1, source: 'Inbound', probability: 20, stageId: B.stage.id, closeDate: new Date(), ownerId: B.owner.id },
    })
    await expect(
      actions.updateDealAction({
        id: own.id,
        name: 'x',
        value: 100,
        stageId: B.stage.id,
        closeDate: new Date().toISOString(),
        ownerId: B.owner.id,
        companyId: A.company.id,
      }),
    ).rejects.toThrow(/Company not found/)
  })

  it('createCompanyAction\'s case-insensitive name match never resolves to another org\'s company', async () => {
    const result = await actions.createCompanyAction({ id: crypto.randomUUID(), name: A.company.name.toUpperCase() })
    expect(result.id).not.toBe(A.company.id)
    expect(result.existing).toBe(false)
    await prisma.company.delete({ where: { id: result.id } })
  })

  it('no cross-tenant attempt above left an Activity authored by B on org A', async () => {
    const leaked = await prisma.activity.findMany({ where: { orgId: A.org.id, actorId: B.owner.id } })
    expect(leaked).toHaveLength(0)
  })
})

describe('server actions: every action requires a real, session-derived orgId', () => {
  it('rejects when there is no Clerk session at all', async () => {
    mockAuth.mockResolvedValue({ userId: null, orgId: null })
    await expect(actions.moveDealAction(A.deal.id, A.otherStage.id)).rejects.toThrow()
  })

  it('rejects when the Clerk org has no matching Organization row', async () => {
    mockAuth.mockResolvedValue({ userId: 'ghost-user', orgId: `ghost-clerk-org-${RUN}` })
    await expect(actions.moveDealAction(A.deal.id, A.otherStage.id)).rejects.toThrow()
  })

  it('rejects when the Clerk user has no matching Owner row in that org', async () => {
    mockAuth.mockResolvedValue({ userId: `ghost-user-${RUN}`, orgId: A.org.clerkOrgId })
    await expect(actions.moveDealAction(A.deal.id, A.otherStage.id)).rejects.toThrow()
  })
})
