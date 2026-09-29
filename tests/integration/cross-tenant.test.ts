/**
 * Permanent regression guard for multi-tenant data isolation.
 *
 * Creates two real Organizations (with real Owners/Leads/Contacts/Deals/
 * Tasks) in the real database, then attempts cross-tenant access through
 * every lib/data/*.ts function and every server action in
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
import { getOwnerById, listOwners } from '@lib/data/owners'
import { getTaskById, listTasks, toggleTaskDone } from '@lib/data/tasks'
import { listActivities } from '@lib/data/activities'
import * as actions from '@lib/actions/crm'

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

interface Fixture {
  org: Awaited<ReturnType<typeof prisma.organization.create>>
  owner: Awaited<ReturnType<typeof prisma.owner.create>>
  lead: Awaited<ReturnType<typeof prisma.lead.create>>
  contact: Awaited<ReturnType<typeof prisma.contact.create>>
  deal: Awaited<ReturnType<typeof prisma.deal.create>>
  task: Awaited<ReturnType<typeof prisma.task.create>>
}

async function makeFixture(tag: 'a' | 'b'): Promise<Fixture> {
  const org = await prisma.organization.create({
    data: { clerkOrgId: `test-clerk-org-${tag}-${RUN}`, name: `Cross-tenant test org ${tag}` },
  })
  const owner = await prisma.owner.create({
    data: {
      orgId: org.id,
      clerkUserId: `test-clerk-user-${tag}-${RUN}`,
      name: `Owner ${tag}`,
      email: `owner-${tag}-${RUN}@example.com`,
      role: 'Admin',
    },
  })
  const lead = await prisma.lead.create({
    data: {
      orgId: org.id,
      name: `Lead ${tag}`,
      title: '',
      company: `Co ${tag}`,
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
      company: `Co ${tag}`,
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
      company: `Co ${tag}`,
      value: 1000,
      source: 'Inbound',
      probability: 20,
      closeDate: new Date(),
      ownerId: owner.id,
      contactId: contact.id,
    },
  })
  const task = await prisma.task.create({
    data: { orgId: org.id, title: `Task ${tag}`, dueDate: new Date(), ownerId: owner.id },
  })
  return { org, owner, lead, contact, deal, task }
}

async function destroyFixture(f: Fixture) {
  const orgId = f.org.id
  await prisma.activity.deleteMany({ where: { orgId } })
  await prisma.task.deleteMany({ where: { orgId } })
  await prisma.deal.deleteMany({ where: { orgId } })
  await prisma.contact.deleteMany({ where: { orgId } })
  await prisma.lead.deleteMany({ where: { orgId } })
  await prisma.owner.deleteMany({ where: { orgId } })
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
        { name: 'x', title: '', email: '', phone: '', company: 'x', source: 'Inbound', ownerId: B.owner.id },
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
        { name: 'x', title: '', email: '', phone: '', company: 'x', ownerId: B.owner.id },
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
        { name: 'x', value: 100, stage: 'discovery', probability: 20, closeDate: new Date(), contactId: null, ownerId: B.owner.id },
        B.owner.id,
      ),
    ).rejects.toThrow()
  })
  it('moveDealToStage throws', async () => {
    await expect(moveDealToStage(B.org.id, A.deal.id, 'proposal', 45)).rejects.toThrow()
  })
  it('toggleTaskDone throws', async () => {
    await expect(toggleTaskDone(B.org.id, A.task.id, true)).rejects.toThrow()
  })

  it('none of the above mutated the org A rows', async () => {
    const lead = await prisma.lead.findUnique({ where: { id: A.lead.id } })
    const contact = await prisma.contact.findUnique({ where: { id: A.contact.id } })
    const deal = await prisma.deal.findUnique({ where: { id: A.deal.id } })
    const task = await prisma.task.findUnique({ where: { id: A.task.id } })
    expect(lead?.status).toBe('new')
    expect(contact?.name).toBe(A.contact.name)
    expect(deal?.stage).toBe('discovery')
    expect(task?.done).toBe(false)
  })
})

describe('server actions: reject a client-supplied ownerId/contactId from another org', () => {
  beforeEach(() => loginAs(B))

  it('createLeadAction rejects an ownerId from another org', async () => {
    await expect(
      actions.createLeadAction({
        id: crypto.randomUUID(),
        name: 'x',
        email: '',
        phone: '',
        company: 'x',
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
        company: 'x',
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
        company: 'x',
        value: 100,
        stage: 'discovery',
        closeDate: new Date().toISOString(),
        ownerId: A.owner.id,
        source: 'Inbound',
        priority: 'low',
      }),
    ).rejects.toThrow(/Owner not found/)
  })

  it('createDealAction rejects a contactId from another org', async () => {
    await expect(
      actions.createDealAction({
        id: crypto.randomUUID(),
        name: 'x',
        company: 'x',
        value: 100,
        stage: 'discovery',
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
        company: 'x',
        source: 'Inbound',
        ownerId: B.owner.id,
      }),
    ).rejects.toThrow()
    expect((await prisma.lead.findUnique({ where: { id: A.lead.id } }))?.name).toBe(A.lead.name)
  })

  it('updateLeadAction rejects an ownerId from another org, even on the caller\'s own lead', async () => {
    const own = await prisma.lead.create({
      data: { orgId: B.org.id, name: 'B-own-lead', title: '', company: 'x', email: '', phone: '', source: 'Inbound', location: '', ownerId: B.owner.id },
    })
    await expect(
      actions.updateLeadAction({
        id: own.id,
        name: 'x',
        title: '',
        email: '',
        phone: '',
        company: 'x',
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
        company: 'x',
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
        stage: 'discovery',
        closeDate: new Date().toISOString(),
        ownerId: B.owner.id,
      }),
    ).rejects.toThrow()
    expect((await prisma.deal.findUnique({ where: { id: A.deal.id } }))?.name).toBe(A.deal.name)
  })

  it('updateDealAction rejects a contactId from another org', async () => {
    const own = await prisma.deal.create({
      data: { orgId: B.org.id, name: 'B-own-deal', company: 'x', value: 1, source: 'Inbound', probability: 20, closeDate: new Date(), ownerId: B.owner.id },
    })
    await expect(
      actions.updateDealAction({
        id: own.id,
        name: 'x',
        value: 100,
        stage: 'discovery',
        closeDate: new Date().toISOString(),
        ownerId: B.owner.id,
        contactId: A.contact.id,
      }),
    ).rejects.toThrow(/Contact not found/)
  })

  it('moveDealAction (kanban drag) rejects a deal id from another org', async () => {
    await expect(actions.moveDealAction(A.deal.id, 'proposal')).rejects.toThrow()
    expect((await prisma.deal.findUnique({ where: { id: A.deal.id } }))?.stage).toBe('discovery')
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
      data: { orgId: B.org.id, name: 'B-own-lead-2', title: '', company: 'x', email: '', phone: '', source: 'Inbound', location: '', ownerId: B.owner.id },
    })
    await expect(
      actions.convertLeadAction(own.id, { ownerId: A.owner.id, contactId: crypto.randomUUID() }),
    ).rejects.toThrow(/Owner not found/)
  })

  it('toggleTaskAction rejects a task id from another org', async () => {
    await expect(actions.toggleTaskAction(A.task.id, true)).rejects.toThrow()
    expect((await prisma.task.findUnique({ where: { id: A.task.id } }))?.done).toBe(false)
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

  it('no cross-tenant attempt above left an Activity authored by B on org A', async () => {
    const leaked = await prisma.activity.findMany({ where: { orgId: A.org.id, actorId: B.owner.id } })
    expect(leaked).toHaveLength(0)
  })
})

describe('server actions: every action requires a real, session-derived orgId', () => {
  it('rejects when there is no Clerk session at all', async () => {
    mockAuth.mockResolvedValue({ userId: null, orgId: null })
    await expect(actions.moveDealAction(A.deal.id, 'proposal')).rejects.toThrow()
  })

  it('rejects when the Clerk org has no matching Organization row', async () => {
    mockAuth.mockResolvedValue({ userId: 'ghost-user', orgId: `ghost-clerk-org-${RUN}` })
    await expect(actions.moveDealAction(A.deal.id, 'proposal')).rejects.toThrow()
  })

  it('rejects when the Clerk user has no matching Owner row in that org', async () => {
    mockAuth.mockResolvedValue({ userId: `ghost-user-${RUN}`, orgId: A.org.clerkOrgId })
    await expect(actions.moveDealAction(A.deal.id, 'proposal')).rejects.toThrow()
  })
})
