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
import { randomUUID } from 'crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockAuth, mockClerkClient } = vi.hoisted(() => ({ mockAuth: vi.fn(), mockClerkClient: vi.fn() }))

vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@clerk/nextjs/server', () => ({
  auth: () => mockAuth(),
  clerkClient: () => mockClerkClient(),
}))

import { prisma } from '@lib/prisma'
import { getLeadById, listLeads, updateLeadStatus, updateLead, convertLeadToDeal } from '@lib/data/leads'
import { getContactById, listContacts, updateContact, addContactTag } from '@lib/data/contacts'
import { getDealById, listDeals, updateDeal, moveDealToStage } from '@lib/data/deals'
import { getCompanyById, getCompanyDetail, deleteCompany } from '@lib/data/companies'
import { getOwnerById, listOwners, deactivateOwner } from '@lib/data/owners'
import { requirePaymentAccess, requirePaymentWriteAccess } from '@lib/auth'
import { getPaymentById, listPayments } from '@lib/data/payments'
import * as paymentActions from '@lib/actions/payments'
import { loadCrmData } from '@lib/data-loader'
import { isThisMonth, receivedTotal } from '@/lib/utils'
import { getTaskById, listTasks, toggleTaskDone, updateTask, deleteTask } from '@lib/data/tasks'
import { listActivities } from '@lib/data/activities'
import { ensureDefaultStages, getStageById, listStages, renameStage, reorderStage, deleteStage } from '@lib/data/stages'
import * as actions from '@lib/actions/crm'
import { GET, dynamic as crmRefetchDynamic } from '../../app/api/crm-refetch/route'
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
  payment: Awaited<ReturnType<typeof prisma.payment.create>>
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
  const payment = await prisma.payment.create({
    data: { orgId: org.id, dealId: deal.id, amount: 500, dueDate: new Date(), createdById: owner.id },
  })
  return { org, owner, company, lead, contact, deal, task, payment, stages, stage, otherStage }
}

async function destroyFixture(f: Fixture) {
  const orgId = f.org.id
  await prisma.activity.deleteMany({ where: { orgId } })
  await prisma.payment.deleteMany({ where: { orgId } })
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
  // Fixture owners are always created with role: 'Admin' (see makeFixture) — orgRole mirrors that,
  // same as a real Clerk session would for this person.
  mockAuth.mockResolvedValue({ userId: f.owner.clerkUserId, orgId: f.org.clerkOrgId, orgRole: 'org:admin' })
}

/** Single-page live Clerk mock reporting `f.owner` as org:admin in `f.org` — for tests that need
 *  requirePaymentWriteAccess() to actually succeed, not just reach it. */
function mockClerkAdminFor(f: Fixture) {
  mockClerkClient.mockResolvedValue({
    users: {
      getOrganizationMembershipList: async () => ({
        data: [{ organization: { id: f.org.clerkOrgId }, role: 'org:admin' }],
        totalCount: 1,
      }),
    },
  })
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

describe('org currency: tenant isolation and admin-only enforcement', () => {
  it('updateCurrencyAction only ever changes the caller\'s own org, never leaks into another org', async () => {
    loginAs(A) // A.owner is an Admin — see makeFixture
    const before = await prisma.organization.findUnique({ where: { id: B.org.id } })
    expect(before?.currency).toBe('USD')

    await actions.updateCurrencyAction({ currency: 'PKR' })

    const afterA = await prisma.organization.findUnique({ where: { id: A.org.id } })
    const afterB = await prisma.organization.findUnique({ where: { id: B.org.id } })
    expect(afterA?.currency).toBe('PKR')
    expect(afterB?.currency).toBe('USD') // untouched — org A has no way to address org B's row

    // Revert so this fixture org doesn't confuse any other test in this file.
    await prisma.organization.update({ where: { id: A.org.id }, data: { currency: 'USD' } })
  })

  it('updateCurrencyAction rejects a non-admin (Member) caller', async () => {
    const member = await prisma.owner.create({
      data: {
        orgId: B.org.id,
        clerkUserId: `test-clerk-member-${RUN}`,
        name: 'Member Owner',
        email: `member-${RUN}@example.com`,
        role: 'Member',
      },
    })
    mockAuth.mockResolvedValue({ userId: member.clerkUserId, orgId: B.org.clerkOrgId })

    await expect(actions.updateCurrencyAction({ currency: 'PKR' })).rejects.toThrow(/Admins only/)

    const org = await prisma.organization.findUnique({ where: { id: B.org.id } })
    expect(org?.currency).toBe('USD') // rejected before any write

    await prisma.owner.delete({ where: { id: member.id } })
  })

  it('updateCurrencyAction rejects an unsupported currency code even for an admin', async () => {
    loginAs(B)
    await expect(actions.updateCurrencyAction({ currency: 'XXX' })).rejects.toThrow(/Unsupported currency/)
    const org = await prisma.organization.findUnique({ where: { id: B.org.id } })
    expect(org?.currency).toBe('USD')
  })
})

describe('requirePaymentAccess: stricter than requireAdmin — built for payments, not currency', () => {
  it('allows an active Admin through', async () => {
    loginAs(A) // A.owner is Admin + active by construction (makeFixture)
    const session = await requirePaymentAccess()
    expect(session).toMatchObject({ orgId: A.org.id, ownerId: A.owner.id, role: 'Admin', active: true })
  })

  it('rejects a Member, same as requireAdmin', async () => {
    const member = await prisma.owner.create({
      data: {
        orgId: B.org.id,
        clerkUserId: `test-clerk-payaccess-member-${RUN}`,
        name: 'Payment Access Member',
        email: `payaccess-member-${RUN}@example.com`,
        role: 'Member',
      },
    })
    mockAuth.mockResolvedValue({ userId: member.clerkUserId, orgId: B.org.clerkOrgId, orgRole: 'org:member' })

    await expect(requirePaymentAccess()).rejects.toThrow(/Admins only/)

    await prisma.owner.delete({ where: { id: member.id } })
  })

  it('rejects an Admin who has been deactivated (removed from the org), unlike requireAdmin alone', async () => {
    const deactivatedAdmin = await prisma.owner.create({
      data: {
        orgId: B.org.id,
        clerkUserId: `test-clerk-payaccess-inactive-${RUN}`,
        name: 'Deactivated Admin',
        email: `payaccess-inactive-${RUN}@example.com`,
        role: 'Admin',
        active: false,
      },
    })
    mockAuth.mockResolvedValue({ userId: deactivatedAdmin.clerkUserId, orgId: B.org.clerkOrgId, orgRole: 'org:admin' })

    await expect(requirePaymentAccess()).rejects.toThrow(/Forbidden/)

    await prisma.owner.delete({ where: { id: deactivatedAdmin.id } })
  })

  it('rejects an Admin deactivated via the real deactivateOwner path, not just a hand-set flag', async () => {
    const admin = await prisma.owner.create({
      data: {
        orgId: B.org.id,
        clerkUserId: `test-clerk-payaccess-real-deactivate-${RUN}`,
        name: 'Soon Deactivated Admin',
        email: `payaccess-real-deactivate-${RUN}@example.com`,
        role: 'Admin',
      },
    })
    mockAuth.mockResolvedValue({ userId: admin.clerkUserId, orgId: B.org.clerkOrgId, orgRole: 'org:admin' })
    await expect(requirePaymentAccess()).resolves.toBeTruthy() // active by default — allowed before deactivation

    await deactivateOwner(B.org.id, admin.clerkUserId!)
    await expect(requirePaymentAccess()).rejects.toThrow(/Forbidden/)

    await prisma.owner.delete({ where: { id: admin.id } })
  })

  it('rejects when the session says org:member but the Owner row says Admin', async () => {
    // Owner.role is correct (Admin) — but the Clerk session itself (the independent source) says
    // this person is no longer an admin. The two sources disagree; fail closed either way.
    mockAuth.mockResolvedValue({ userId: A.owner.clerkUserId, orgId: A.org.clerkOrgId, orgRole: 'org:member' })
    await expect(requirePaymentAccess()).rejects.toThrow(/Forbidden/)
  })

  it('rejects the reverse: session says org:admin but the Owner row says Member', async () => {
    const member = await prisma.owner.create({
      data: {
        orgId: B.org.id,
        clerkUserId: `test-clerk-payaccess-reverse-${RUN}`,
        name: 'Reverse Mismatch Member',
        email: `payaccess-reverse-${RUN}@example.com`,
        role: 'Member',
      },
    })
    // The session claims admin (e.g. a promotion Clerk already knows about), but our DB's
    // Owner.role hasn't caught up yet. Still denied — requireAdmin() rejects on Owner.role alone,
    // before the session check even runs, which is the correct fail-closed outcome either way.
    mockAuth.mockResolvedValue({ userId: member.clerkUserId, orgId: B.org.clerkOrgId, orgRole: 'org:admin' })

    await expect(requirePaymentAccess()).rejects.toThrow(/Admins only/)

    await prisma.owner.delete({ where: { id: member.id } })
  })
})

describe('requirePaymentWriteAccess: live Clerk check, no session-refresh window for writes', () => {
  afterAll(() => mockClerkClient.mockReset())

  it('allows a real admin whose live Clerk role matches', async () => {
    loginAs(A)
    mockClerkClient.mockResolvedValue({
      users: {
        getOrganizationMembershipList: async () => ({
          data: [{ organization: { id: A.org.clerkOrgId }, role: 'org:admin' }],
        }),
      },
    })
    await expect(requirePaymentWriteAccess()).resolves.toBeTruthy()
  })

  it('rejects a write immediately after a Clerk demotion, even while Owner.role is still stale', async () => {
    // Owner.role is still "Admin" in our DB (makeFixture) — nothing has synced the demotion yet,
    // simulating the exact gap described: a real webhook can take an unbounded amount of time,
    // and this test doesn't wait for one. The live Backend API lookup is the only thing that has
    // to be correct here, and it's mocked to report the demotion having already happened in Clerk.
    loginAs(A)
    const stillAdminInOurDb = await prisma.owner.findUnique({ where: { id: A.owner.id } })
    expect(stillAdminInOurDb?.role).toBe('Admin') // confirms the DB really is stale for this test

    mockClerkClient.mockResolvedValue({
      users: {
        getOrganizationMembershipList: async () => ({
          data: [{ organization: { id: A.org.clerkOrgId }, role: 'org:member' }], // demoted, live
        }),
      },
    })

    await expect(requirePaymentWriteAccess()).rejects.toThrow(/Forbidden/)
  })

  it('rejects when the live Clerk membership list has no entry for this org at all (e.g. removed)', async () => {
    loginAs(A)
    mockClerkClient.mockResolvedValue({
      users: { getOrganizationMembershipList: async () => ({ data: [] }) },
    })
    await expect(requirePaymentWriteAccess()).rejects.toThrow(/Forbidden/)
  })

  it('pages through every membership rather than trusting only the first 100 rows', async () => {
    // Org A's own membership doesn't appear until page two — a naive single-page lookup would
    // wrongly reject a real admin just because their org wasn't in the first batch Clerk returned.
    loginAs(A)
    mockClerkClient.mockResolvedValue({
      users: {
        getOrganizationMembershipList: async ({ offset }: { offset: number }) => {
          if (offset === 0) {
            return {
              data: Array.from({ length: 100 }, (_, i) => ({
                organization: { id: `unrelated-org-${i}` },
                role: 'org:member',
              })),
              totalCount: 101,
            }
          }
          return { data: [{ organization: { id: A.org.clerkOrgId }, role: 'org:admin' }], totalCount: 101 }
        },
      },
    })
    await expect(requirePaymentWriteAccess()).resolves.toBeTruthy()
  })

  it('rejects when the matching membership found on a later page is not org:admin', async () => {
    loginAs(A)
    mockClerkClient.mockResolvedValue({
      users: {
        getOrganizationMembershipList: async ({ offset }: { offset: number }) => {
          if (offset === 0) {
            return {
              data: Array.from({ length: 100 }, (_, i) => ({
                organization: { id: `unrelated-org-${i}` },
                role: 'org:member',
              })),
              totalCount: 101,
            }
          }
          return { data: [{ organization: { id: A.org.clerkOrgId }, role: 'org:member' }], totalCount: 101 }
        },
      },
    })
    await expect(requirePaymentWriteAccess()).rejects.toThrow(/Forbidden/)
  })
})

describe('lib/data/payments: tenant isolation', () => {
  it("getPaymentById returns null for another org's payment", async () => {
    expect(await getPaymentById(B.org.id, A.payment.id)).toBeNull()
  })
  it("listPayments never includes another org's payments", async () => {
    expect((await listPayments(B.org.id)).map((p) => p.id)).not.toContain(A.payment.id)
  })
})

describe('lib/actions/payments: rejects a client-supplied dealId from another org', () => {
  beforeEach(() => {
    loginAs(A)
    mockClerkAdminFor(A)
  })
  afterEach(() => mockClerkClient.mockReset())

  it('createPaymentAction rejects a dealId belonging to another org', async () => {
    await expect(
      paymentActions.createPaymentAction({
        id: randomUUID(),
        dealId: B.deal.id,
        amount: 100,
        label: 'Other',
      dueDate: new Date().toISOString(),
      }),
    ).rejects.toThrow(/Deal not found/)
  })
})

describe('lib/actions/payments: role enforcement — a non-privileged member is rejected on every read and write', () => {
  let member: Awaited<ReturnType<typeof prisma.owner.create>>

  beforeAll(async () => {
    member = await prisma.owner.create({
      data: {
        orgId: B.org.id,
        clerkUserId: `test-clerk-payments-member-${RUN}`,
        name: 'Payments Member',
        email: `payments-member-${RUN}@example.com`,
        role: 'Member',
      },
    })
  })
  afterAll(async () => {
    await prisma.owner.delete({ where: { id: member.id } })
  })
  beforeEach(() => {
    mockAuth.mockResolvedValue({ userId: member.clerkUserId, orgId: B.org.clerkOrgId, orgRole: 'org:member' })
  })
  afterEach(() => mockClerkClient.mockReset())

  it('rejects the Payments route / data-loader read gate', async () => {
    await expect(requirePaymentAccess()).rejects.toThrow(/Admins only/)
  })

  it('createPaymentAction rejects', async () => {
    await expect(
      paymentActions.createPaymentAction({
        id: randomUUID(),
        dealId: B.deal.id,
        amount: 100,
        label: 'Other',
      dueDate: new Date().toISOString(),
      }),
    ).rejects.toThrow(/Admins only/)
  })

  it('updatePaymentAction rejects', async () => {
    await expect(
      paymentActions.updatePaymentAction({ id: B.payment.id, amount: 200, label: 'Other', dueDate: new Date().toISOString() }),
    ).rejects.toThrow(/Admins only/)
  })

  it('markPaymentPaidAction rejects', async () => {
    await expect(paymentActions.markPaymentPaidAction(B.payment.id)).rejects.toThrow(/Admins only/)
  })

  it('cancelPaymentAction rejects', async () => {
    await expect(paymentActions.cancelPaymentAction(B.payment.id)).rejects.toThrow(/Admins only/)
  })

  it('deletePaymentAction rejects (throws, rather than returning {ok:false} — the role gate runs before the pending-only check)', async () => {
    await expect(paymentActions.deletePaymentAction(B.payment.id)).rejects.toThrow(/Admins only/)
  })

  it("never received any Payment rows or payment-kind activities in this member's loaded data", async () => {
    const data = await loadCrmData(B.org.id, member.id, false)
    expect(data.payments).toEqual([])
    expect(data.canAccessPayments).toBe(false)
    expect(data.activities.some((a) => a.kind === 'payment')).toBe(false)
  })

  it("a Won deal that has real payments carries no payment-existence signal in this member's loaded Deal data", async () => {
    // Set up, as the real privileged path would: a Won deal with real payments on it.
    loginAs(B) // B.owner is Admin by fixture construction
    mockClerkAdminFor(B)
    const created = await paymentActions.createPaymentAction({
      id: randomUUID(),
      dealId: B.deal.id,
      amount: 500,
      label: 'Other',
      dueDate: new Date().toISOString(),
    })

    const privileged = await loadCrmData(B.org.id, B.owner.id, true)
    const dealPrivileged = privileged.deals.find((d) => d.id === B.deal.id)
    expect(dealPrivileged).toBeTruthy()

    const asMember = await loadCrmData(B.org.id, member.id, false)
    const dealAsMember = asMember.deals.find((d) => d.id === B.deal.id)
    expect(dealAsMember).toBeTruthy()
    // Same Deal shape either way — no extra "hasPayments"/count/amount field exists to leak,
    // and the one place that data lives (`payments`) is empty for the member.
    expect(Object.keys(dealAsMember!).sort()).toEqual(Object.keys(dealPrivileged!).sort())
    expect(JSON.stringify(dealAsMember).toLowerCase()).not.toContain('payment')
    expect(asMember.payments).toEqual([])

    await prisma.activity.deleteMany({ where: { orgId: B.org.id, dealId: B.deal.id, kind: 'payment' } })
    await prisma.payment.delete({ where: { id: created.id } })
  })
})

describe('lib/actions/payments: a payment that was ever paid can never be deleted, even after cancelling', () => {
  beforeEach(() => {
    loginAs(A)
    mockClerkAdminFor(A)
  })
  afterEach(() => mockClerkClient.mockReset())

  it('paid -> cancel -> delete is rejected (cancelling keeps paidAt, which permanently blocks deletion)', async () => {
    const created = await paymentActions.createPaymentAction({
      id: randomUUID(),
      dealId: A.deal.id,
      amount: 750,
      label: 'Other',
      dueDate: new Date().toISOString(),
    })

    await paymentActions.markPaymentPaidAction(created.id)
    const paidRow = await getPaymentById(A.org.id, created.id)
    expect(paidRow?.paidAt).not.toBeNull()

    await paymentActions.cancelPaymentAction(created.id)
    const cancelledRow = await getPaymentById(A.org.id, created.id)
    expect(cancelledRow?.status).toBe('cancelled')
    // The whole point of this fix: cancelling does NOT clear paidAt.
    expect(cancelledRow?.paidAt).not.toBeNull()

    const blockedDelete = await paymentActions.deletePaymentAction(created.id)
    expect(blockedDelete).toEqual({ ok: false, error: expect.stringMatching(/ever marked paid/i) })
    expect(await getPaymentById(A.org.id, created.id)).not.toBeNull() // still there — not deleted
  })

  it('a pending payment (never paid) is still deletable', async () => {
    const created = await paymentActions.createPaymentAction({
      id: randomUUID(),
      dealId: A.deal.id,
      amount: 751,
      label: 'Other',
      dueDate: new Date().toISOString(),
    })
    const result = await paymentActions.deletePaymentAction(created.id)
    expect(result).toEqual({ ok: true })
    expect(await getPaymentById(A.org.id, created.id)).toBeNull()
  })

  it('a cancelled payment that was never paid first is still deletable', async () => {
    const created = await paymentActions.createPaymentAction({
      id: randomUUID(),
      dealId: A.deal.id,
      amount: 752,
      label: 'Other',
      dueDate: new Date().toISOString(),
    })
    await paymentActions.cancelPaymentAction(created.id)
    const cancelledRow = await getPaymentById(A.org.id, created.id)
    expect(cancelledRow?.status).toBe('cancelled')
    expect(cancelledRow?.paidAt).toBeNull() // never paid — nothing to protect

    const result = await paymentActions.deletePaymentAction(created.id)
    expect(result).toEqual({ ok: true })
    expect(await getPaymentById(A.org.id, created.id)).toBeNull()
  })

  it('a real paid-then-cancelled row (paidAt still set) is excluded from receivedTotal, end to end', async () => {
    const created = await paymentActions.createPaymentAction({
      id: randomUUID(),
      dealId: A.deal.id,
      amount: 753,
      label: 'Other',
      dueDate: new Date().toISOString(),
    })
    await paymentActions.markPaymentPaidAction(created.id)
    await paymentActions.cancelPaymentAction(created.id)

    const row = await getPaymentById(A.org.id, created.id)
    expect(row?.status).toBe('cancelled')
    expect(row?.paidAt).not.toBeNull() // the exact shape receivedTotal must not be fooled by

    const dealPayments = (await listPayments(A.org.id, { dealId: A.deal.id })).filter((p) => p.id === created.id)
    expect(receivedTotal(dealPayments)).toBe(0) // excluded — not the $753

    // Cleanup: permanently undeletable by design (see the describe block above) — remove directly.
    await prisma.activity.deleteMany({ where: { orgId: A.org.id, dealId: A.deal.id, kind: 'payment' } })
    await prisma.payment.delete({ where: { id: created.id } })
  })
})

describe('activity leak: payment-kind activities and Payment rows never reach a non-privileged caller', () => {
  let paymentId: string

  beforeAll(async () => {
    loginAs(A)
    mockClerkAdminFor(A)
    const created = await paymentActions.createPaymentAction({
      id: randomUUID(),
      dealId: A.deal.id,
      amount: 999,
      label: 'Other',
      dueDate: new Date().toISOString(),
    })
    paymentId = created.id
  })
  afterAll(async () => {
    mockClerkClient.mockReset()
    await prisma.payment.delete({ where: { id: paymentId } }).catch(() => {})
  })

  it('a privileged load includes the payment and its activity', async () => {
    const data = await loadCrmData(A.org.id, A.owner.id, true)
    expect(data.payments.some((p) => p.id === paymentId)).toBe(true)
    expect(data.canAccessPayments).toBe(true)
    expect(data.activities.some((a) => a.kind === 'payment' && a.subject?.id === A.deal.id)).toBe(true)
    // No dollar figure ever lands in an activity title, regardless of who can see it.
    for (const activity of data.activities.filter((a) => a.kind === 'payment')) {
      expect(activity.title).not.toMatch(/\d/)
    }
  })

  it('the exact same org, loaded as non-privileged, gets no Payment rows and no payment activities', async () => {
    const data = await loadCrmData(A.org.id, A.owner.id, false)
    expect(data.payments).toEqual([])
    expect(data.canAccessPayments).toBe(false)
    expect(data.activities.some((a) => a.kind === 'payment')).toBe(false)
    // Every other activity kind this org has logged is still present — this isn't a blanket
    // activity-feed failure, only payment-kind rows are excluded.
    expect(data.activities.length).toBeGreaterThan(0)
  })
})

describe('splitPaymentAction: tenant, role, and rounding correctness', () => {
  beforeEach(() => {
    loginAs(A)
    mockClerkAdminFor(A)
  })
  afterEach(() => mockClerkClient.mockReset())

  it('rejects a dealId belonging to another org', async () => {
    await expect(
      paymentActions.splitPaymentAction({
        dealId: B.deal.id,
        parts: [
          { id: randomUUID(), percent: 50, label: 'Advance' },
          { id: randomUUID(), percent: 50, label: 'Final' },
        ],
      }),
    ).rejects.toThrow(/Deal not found/)
  })

  it('rejects a non-privileged member', async () => {
    const member = await prisma.owner.create({
      data: {
        orgId: B.org.id,
        clerkUserId: `test-clerk-split-member-${RUN}`,
        name: 'Split Member',
        email: `split-member-${RUN}@example.com`,
        role: 'Member',
      },
    })
    mockAuth.mockResolvedValue({ userId: member.clerkUserId, orgId: B.org.clerkOrgId, orgRole: 'org:member' })

    await expect(
      paymentActions.splitPaymentAction({
        dealId: B.deal.id,
        parts: [
          { id: randomUUID(), percent: 50, label: 'Advance' },
          { id: randomUUID(), percent: 50, label: 'Final' },
        ],
      }),
    ).rejects.toThrow(/Admins only/)

    await prisma.owner.delete({ where: { id: member.id } })
  })

  it('rejects percentages that do not total exactly 100%, before writing anything', async () => {
    const before = await listPayments(A.org.id, { dealId: A.deal.id })
    await expect(
      paymentActions.splitPaymentAction({
        dealId: A.deal.id,
        parts: [
          { id: randomUUID(), percent: 50, label: 'Advance' },
          { id: randomUUID(), percent: 40, label: 'Final' },
        ],
      }),
    ).rejects.toThrow(/total exactly 100/)
    const after = await listPayments(A.org.id, { dealId: A.deal.id })
    expect(after.length).toBe(before.length) // nothing written
  })

  it('rejects fewer than two installments', async () => {
    await expect(
      paymentActions.splitPaymentAction({
        dealId: A.deal.id,
        parts: [{ id: randomUUID(), percent: 100, label: 'Final' }],
      }),
    ).rejects.toThrow(/at least two/)
  })

  it('30/40/30 of a real deal value: amounts sum exactly, last part absorbs the rounding remainder', async () => {
    // A dedicated deal, not A.deal — A.deal can carry a permanent paid-then-cancelled payment
    // left behind by an earlier test (see "a payment that was ever paid can never be deleted"),
    // and the new "refuses to split a deal that already has payments" guard would (correctly)
    // reject a split against it. deal.value still comes from a real Prisma read either way.
    const deal = await prisma.deal.create({
      data: {
        orgId: A.org.id,
        name: 'Rounding test deal',
        companyId: A.company.id,
        value: 1000,
        source: 'Inbound',
        probability: A.stage.probability,
        stageId: A.stage.id,
        closeDate: new Date(),
        ownerId: A.owner.id,
      },
    })

    const ids: string[] = [randomUUID(), randomUUID(), randomUUID()]
    const result = await paymentActions.splitPaymentAction({
      dealId: deal.id,
      parts: [
        { id: ids[0]!, percent: 30, label: 'Advance' },
        { id: ids[1]!, percent: 40, label: 'Milestone' },
        { id: ids[2]!, percent: 30, label: 'Final' },
      ],
    })
    expect(result.payments).toHaveLength(3)
    const total = result.payments.reduce((s, p) => s + p.amount, 0)
    expect(total).toBe(deal.value)
    expect(result.payments.map((p) => p.amount)).toEqual([300, 400, 300])

    const rows = await listPayments(A.org.id, { dealId: deal.id })
    const created = rows.filter((r) => ids.includes(r.id))
    expect(created).toHaveLength(3)
    expect(created.every((r) => r.status === 'pending')).toBe(true)
    expect(created.map((r) => r.label).sort()).toEqual(['Advance', 'Final', 'Milestone'])

    // Label-to-amount correspondence, read fresh from Neon (not the action's own in-memory
    // return value) — the exact thing a prior sorted-array comparison failed to actually check.
    const byLabel = Object.fromEntries(created.map((r) => [r.label, r.amount]))
    expect(byLabel.Advance).toBe(300) // 30% of 1000
    expect(byLabel.Milestone).toBe(400) // 40% of 1000
    expect(byLabel.Final).toBe(300) // 30% of 1000, from the remainder absorption

    // One activity for the whole split, not one per row — the installment count (not a dollar
    // amount) is fine in the title; no amount ever is.
    const activity = await prisma.activity.findFirst({
      where: { orgId: A.org.id, kind: 'payment', dealId: deal.id, title: { contains: 'split' } },
      orderBy: { at: 'desc' },
    })
    expect(activity?.title).toBe('split Rounding test deal into 3 installments')
    expect(activity?.title).not.toMatch(/300|400|1000|1,000/)

    await prisma.activity.deleteMany({ where: { orgId: A.org.id, dealId: deal.id, kind: 'payment' } })
    await prisma.payment.deleteMany({ where: { id: { in: ids } } })
    await prisma.deal.delete({ where: { id: deal.id } })
  })

  it('rejects a per-installment percentage of 0 or 100 (not a real split)', async () => {
    await expect(
      paymentActions.splitPaymentAction({
        dealId: A.deal.id,
        parts: [
          { id: randomUUID(), percent: 100, label: 'Advance' },
          { id: randomUUID(), percent: 0, label: 'Final' },
        ],
      }),
    ).rejects.toThrow(/between 1 and 99/)
  })
})

describe('splitPaymentAction: refuses a second split (or any split) on a deal that already has payments', () => {
  beforeEach(() => {
    loginAs(A)
    mockClerkAdminFor(A)
  })
  afterEach(() => mockClerkClient.mockReset())

  async function makeOwnDeal(value: number) {
    return prisma.deal.create({
      data: {
        orgId: A.org.id,
        name: `Idempotency test deal ${randomUUID()}`,
        companyId: A.company.id,
        value,
        source: 'Inbound',
        probability: A.stage.probability,
        stageId: A.stage.id,
        closeDate: new Date(),
        ownerId: A.owner.id,
      },
    })
  }

  async function cleanupDeal(dealId: string) {
    await prisma.activity.deleteMany({ where: { orgId: A.org.id, dealId, kind: 'payment' } })
    await prisma.payment.deleteMany({ where: { dealId } })
    await prisma.deal.delete({ where: { id: dealId } })
  }

  it('a second split attempt on the same deal is rejected, and the first split is untouched', async () => {
    const deal = await makeOwnDeal(1000)
    const first = await paymentActions.splitPaymentAction({
      dealId: deal.id,
      parts: [
        { id: randomUUID(), percent: 50, label: 'Advance' },
        { id: randomUUID(), percent: 50, label: 'Final' },
      ],
    })
    expect(first.payments).toHaveLength(2)

    await expect(
      paymentActions.splitPaymentAction({
        dealId: deal.id,
        parts: [
          { id: randomUUID(), percent: 30, label: 'Advance' },
          { id: randomUUID(), percent: 70, label: 'Final' },
        ],
      }),
    ).rejects.toThrow(/already has payments/)

    const rows = await listPayments(A.org.id, { dealId: deal.id })
    expect(rows).toHaveLength(2) // still just the first split — nothing added
    expect(rows.map((r) => r.amount).sort((a, b) => a - b)).toEqual([500, 500])

    await cleanupDeal(deal.id)
  })

  it('also refuses to split a deal that already has a single manually-created payment', async () => {
    const deal = await makeOwnDeal(1000)
    await paymentActions.createPaymentAction({
      id: randomUUID(),
      dealId: deal.id,
      amount: 100,
      label: 'Other',
      dueDate: new Date().toISOString(),
    })

    await expect(
      paymentActions.splitPaymentAction({
        dealId: deal.id,
        parts: [
          { id: randomUUID(), percent: 50, label: 'Advance' },
          { id: randomUUID(), percent: 50, label: 'Final' },
        ],
      }),
    ).rejects.toThrow(/already has payments/)

    const rows = await listPayments(A.org.id, { dealId: deal.id })
    expect(rows).toHaveLength(1) // only the original manual payment

    await cleanupDeal(deal.id)
  })

  it('two concurrent split requests on the same deal create exactly one set, never two', async () => {
    const deal = await makeOwnDeal(1000)

    const attempt = () =>
      paymentActions.splitPaymentAction({
        dealId: deal.id,
        parts: [
          { id: randomUUID(), percent: 50, label: 'Advance' },
          { id: randomUUID(), percent: 50, label: 'Final' },
        ],
      })

    const results = await Promise.allSettled([attempt(), attempt()])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1) // exactly one of the two actually created a set
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already has payments/)

    const rows = await listPayments(A.org.id, { dealId: deal.id })
    expect(rows).toHaveLength(2) // one set — not four from both succeeding
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(1000)

    await cleanupDeal(deal.id)
  })
})

describe('Dashboard Payments card math: a paid-then-cancelled payment is excluded, end to end', () => {
  it('mirrors PaymentsSummaryCard\'s own "collected this month" filter on real data', async () => {
    loginAs(A)
    mockClerkAdminFor(A)

    const paidId = randomUUID()
    const cancelledId = randomUUID()
    await paymentActions.createPaymentAction({ id: paidId, dealId: A.deal.id, amount: 400, label: 'Other', dueDate: new Date().toISOString() })
    await paymentActions.createPaymentAction({ id: cancelledId, dealId: A.deal.id, amount: 600, label: 'Other', dueDate: new Date().toISOString() })
    await paymentActions.markPaymentPaidAction(paidId)
    await paymentActions.markPaymentPaidAction(cancelledId)
    await paymentActions.cancelPaymentAction(cancelledId) // paid, then cancelled — paidAt stays set

    const rows = await listPayments(A.org.id, { dealId: A.deal.id })
    const relevant = rows.filter((r) => r.id === paidId || r.id === cancelledId)
    expect(relevant.find((r) => r.id === cancelledId)?.paidAt).not.toBeNull() // the exact trap condition

    // Same filter PaymentsSummaryCard uses: status === 'paid' AND paidAt this month, via receivedTotal.
    const paidThisMonth = relevant.filter((r) => r.status === 'paid' && r.paidAt && isThisMonth(r.paidAt.toISOString()))
    const collectedThisMonth = receivedTotal(paidThisMonth)
    expect(collectedThisMonth).toBe(400) // only the still-paid $400, not the paid-then-cancelled $600

    await prisma.activity.deleteMany({ where: { orgId: A.org.id, dealId: A.deal.id, kind: 'payment' } })
    await prisma.payment.deleteMany({ where: { id: { in: [paidId, cancelledId] } } })
  })

  it('a Member has no payments data for the Dashboard card to compute anything from', async () => {
    // Same gate the Dashboard card relies on — already proven by loadCrmData above, re-asserted
    // here in the specific framing of "the card has nothing to show, not just something hidden".
    const data = await loadCrmData(A.org.id, A.owner.id, false)
    expect(data.payments).toEqual([])
    expect(data.canAccessPayments).toBe(false)
  })
})

describe('GET /api/crm-refetch: live-update refetch is scoped and role-gated exactly like first load', () => {
  // A plain Route Handler (not a Server Action) — see its doc comment for why: Next's Server
  // Action dispatch queue was measured to serialize a mutation behind an in-flight refetch,
  // adding the refetch's full duration to the mutation's own latency. Calling the exported GET()
  // function directly, same as any other async function, still exercises the real handler.
  async function callRefetchRoute() {
    const response = await GET()
    return { status: response.status, headers: response.headers, body: await response.json() }
  }

  it('is forced dynamic — never statically optimized/cached by Next itself', () => {
    expect(crmRefetchDynamic).toBe('force-dynamic')
  })

  it('sets Cache-Control: private, no-store on a successful response — this is one org\'s data (including Payment rows for an admin), and must never be servable to a different user from any shared/intermediary cache', async () => {
    loginAs(A)
    const { status, headers } = await callRefetchRoute()
    expect(status).toBe(200)
    expect(headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('also sets Cache-Control: private, no-store on the 401 (unauthenticated) response', async () => {
    mockAuth.mockResolvedValue({ userId: null, orgId: null })
    const { status, headers } = await callRefetchRoute()
    expect(status).toBe(401)
    expect(headers.get('Cache-Control')).toBe('private, no-store')
  })

  it("is scoped by the caller's own session — never returns another org's rows", async () => {
    loginAs(A)
    const { status, body: data } = await callRefetchRoute()
    expect(status).toBe(200)
    expect(data.deals.some((d: { id: string }) => d.id === B.deal.id)).toBe(false)
    expect(data.leads.some((l: { id: string }) => l.id === B.lead.id)).toBe(false)
    expect(data.contacts.some((c: { id: string }) => c.id === B.contact.id)).toBe(false)
    expect(data.companies.some((c: { id: string }) => c.id === B.company.id)).toBe(false)
    expect(data.deals.some((d: { id: string }) => d.id === A.deal.id)).toBe(true) // sanity: it's not just empty
  })

  it('returns 401 (never redirects) when there is no valid session', async () => {
    mockAuth.mockResolvedValue({ userId: null, orgId: null })
    const { status } = await callRefetchRoute()
    expect(status).toBe(401)
  })

  it("a non-privileged member's refetch carries no Payment rows and no payment-kind activities, same as first load", async () => {
    const member = await prisma.owner.create({
      data: {
        orgId: B.org.id,
        clerkUserId: `test-clerk-refetch-member-${RUN}`,
        name: 'Refetch Member',
        email: `refetch-member-${RUN}@example.com`,
        role: 'Member',
      },
    })
    mockAuth.mockResolvedValue({ userId: member.clerkUserId, orgId: B.org.clerkOrgId, orgRole: 'org:member' })

    const { status, body: data } = await callRefetchRoute()
    expect(status).toBe(200)
    expect(data.canAccessPayments).toBe(false)
    expect(data.payments).toEqual([])
    expect(data.activities.some((a: { kind: string }) => a.kind === 'payment')).toBe(false)

    await prisma.owner.delete({ where: { id: member.id } })
  })

  it("an admin's refetch does include payment access, mirroring first load", async () => {
    loginAs(A) // A.owner is an active Admin with a matching org:admin session — see makeFixture
    const { body: data } = await callRefetchRoute()
    expect(data.canAccessPayments).toBe(true)
  })
})
