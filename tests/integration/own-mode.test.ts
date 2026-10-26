/**
 * Stage 1a: OWN-mode visibility enforcement in the data layer and actions.
 *
 * Creates ONE real Organization in RepVisibility.OWN mode, with two real Member Owners (repA,
 * repB), each with their own Lead/Contact/Deal/Task, plus a shared Company and PipelineStages
 * (companies and stages are explicitly NOT per-rep — see lib/data/companies.ts and
 * lib/data/stages.ts). Logged in as repA (a Member, never an Admin — the two-source role check in
 * lib/scope.ts only ever unscopes a real Admin), every exported server action and both scoped
 * route handlers must treat repB's record ids exactly like a cross-tenant id: rejected, not just
 * hidden.
 *
 * The record-id mutation matrix and the owner-scoped creation matrix are both asserted exhaustive
 * against `Object.keys(actions)` (the real exports of lib/actions/crm.ts) — a newly added action
 * that isn't explicitly placed in one of the three buckets (scoped mutation / scoped creation /
 * exempt-with-reason) fails the exhaustiveness test immediately, rather than silently shipping
 * without OWN-mode coverage.
 */
import { randomUUID } from 'crypto'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const { mockAuth, mockClerkClient } = vi.hoisted(() => ({ mockAuth: vi.fn(), mockClerkClient: vi.fn() }))

vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@clerk/nextjs/server', () => ({
  auth: () => mockAuth(),
  clerkClient: () => mockClerkClient(),
}))

import { prisma } from '@lib/prisma'
import { getLeadById, listLeads } from '@lib/data/leads'
import { getContactById, listContacts } from '@lib/data/contacts'
import { getDealById, listDeals, getPipelineTotals } from '@lib/data/deals'
import { getTaskById, listTasks } from '@lib/data/tasks'
import { listActivities } from '@lib/data/activities'
import { listCompanies } from '@lib/data/companies'
import { ensureDefaultStages, listStages } from '@lib/data/stages'
import { loadCrmData } from '@lib/data-loader'
import * as actions from '@lib/actions/crm'
import { GET as crmRefetchGET } from '../../app/api/crm-refetch/route'
import { GET as activitiesGET } from '../../app/api/activities/route'
import type { Scope } from '@lib/scope'
import type { PipelineStage } from '@prisma/client'

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

interface RepFixture {
  org: Awaited<ReturnType<typeof prisma.organization.create>>
  repA: Awaited<ReturnType<typeof prisma.owner.create>>
  repB: Awaited<ReturnType<typeof prisma.owner.create>>
  admin: Awaited<ReturnType<typeof prisma.owner.create>>
  company: Awaited<ReturnType<typeof prisma.company.create>>
  leadA: Awaited<ReturnType<typeof prisma.lead.create>>
  leadB: Awaited<ReturnType<typeof prisma.lead.create>>
  contactA: Awaited<ReturnType<typeof prisma.contact.create>>
  contactB: Awaited<ReturnType<typeof prisma.contact.create>>
  dealA: Awaited<ReturnType<typeof prisma.deal.create>>
  dealB: Awaited<ReturnType<typeof prisma.deal.create>>
  taskA: Awaited<ReturnType<typeof prisma.task.create>>
  taskB: Awaited<ReturnType<typeof prisma.task.create>>
  stage: PipelineStage
  otherStage: PipelineStage
}

let F: RepFixture

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { clerkOrgId: `test-own-org-${RUN}`, name: `OWN-mode test org`, repVisibility: 'OWN' },
  })
  await ensureDefaultStages(org.id)
  const stages = await listStages(org.id)
  const stage = stages.find((s) => s.key === 'discovery')!
  const otherStage = stages.find((s) => s.key === 'proposal')!

  const repA = await prisma.owner.create({
    data: {
      orgId: org.id,
      clerkUserId: `test-own-repA-${RUN}`,
      name: 'Rep A',
      email: `rep-a-${RUN}@example.com`,
      role: 'Member',
    },
  })
  const repB = await prisma.owner.create({
    data: {
      orgId: org.id,
      clerkUserId: `test-own-repB-${RUN}`,
      name: 'Rep B',
      email: `rep-b-${RUN}@example.com`,
      role: 'Member',
    },
  })
  // A real Admin in this same OWN-mode org — the two-source check in lib/scope.ts only ever
  // unscopes when BOTH the DB role and the live session claim "Admin", so the conversion
  // owner-move test (reachable only by an unscoped caller) logs in as this owner, not repA/repB.
  const admin = await prisma.owner.create({
    data: {
      orgId: org.id,
      clerkUserId: `test-own-admin-${RUN}`,
      name: 'Admin',
      email: `admin-${RUN}@example.com`,
      role: 'Admin',
    },
  })
  // Shared across both reps, deliberately — company identity is org-wide, not per-owner.
  const company = await prisma.company.create({ data: { orgId: org.id, name: `OWN-mode Co` } })

  const leadA = await prisma.lead.create({
    data: {
      orgId: org.id, name: 'Lead A', title: '', companyId: company.id,
      email: `lead-a-${RUN}@example.com`, phone: '', source: 'Inbound', location: '', ownerId: repA.id,
    },
  })
  const leadB = await prisma.lead.create({
    data: {
      orgId: org.id, name: 'Lead B', title: '', companyId: company.id,
      email: `lead-b-${RUN}@example.com`, phone: '', source: 'Inbound', location: '', ownerId: repB.id,
    },
  })
  const contactA = await prisma.contact.create({
    data: {
      orgId: org.id, name: 'Contact A', title: '', companyId: company.id,
      email: `contact-a-${RUN}@example.com`, phone: '', location: '', ownerId: repA.id,
    },
  })
  const contactB = await prisma.contact.create({
    data: {
      orgId: org.id, name: 'Contact B', title: '', companyId: company.id,
      email: `contact-b-${RUN}@example.com`, phone: '', location: '', ownerId: repB.id,
    },
  })
  const dealA = await prisma.deal.create({
    data: {
      orgId: org.id, name: 'Deal A', companyId: company.id, value: 1000, source: 'Inbound',
      probability: stage.probability, stageId: stage.id, closeDate: new Date(), ownerId: repA.id, contactId: contactA.id,
    },
  })
  const dealB = await prisma.deal.create({
    data: {
      orgId: org.id, name: 'Deal B', companyId: company.id, value: 2000, source: 'Inbound',
      probability: stage.probability, stageId: stage.id, closeDate: new Date(), ownerId: repB.id, contactId: contactB.id,
    },
  })
  const taskA = await prisma.task.create({
    data: { orgId: org.id, title: 'Task A', dueDate: new Date(), ownerId: repA.id, createdById: repA.id },
  })
  const taskB = await prisma.task.create({
    data: { orgId: org.id, title: 'Task B', dueDate: new Date(), ownerId: repB.id, createdById: repB.id },
  })

  F = { org, repA, repB, admin, company, leadA, leadB, contactA, contactB, dealA, dealB, taskA, taskB, stage, otherStage }
})

afterAll(async () => {
  const orgId = F.org.id
  await prisma.notification.deleteMany({ where: { orgId } })
  await prisma.activity.deleteMany({ where: { orgId } })
  await prisma.task.deleteMany({ where: { orgId } })
  await prisma.deal.deleteMany({ where: { orgId } })
  await prisma.contact.deleteMany({ where: { orgId } })
  await prisma.lead.deleteMany({ where: { orgId } })
  await prisma.company.deleteMany({ where: { orgId } })
  await prisma.owner.deleteMany({ where: { orgId } })
  await prisma.pipelineStage.deleteMany({ where: { orgId } })
  await prisma.organization.delete({ where: { id: orgId } })
  await prisma.$disconnect()
})

/** repA, a Member, in an OWN-mode org — never an Admin, so computeScopeOwnerId always scopes
 *  this session to repA.id (see lib/scope.ts's two-source check: repA fails both sources). */
function loginAsRepA() {
  mockAuth.mockResolvedValue({ userId: F.repA.clerkUserId, orgId: F.org.clerkOrgId, orgRole: 'org:member' })
}
function loginAsAdmin() {
  mockAuth.mockResolvedValue({ userId: F.admin.clerkUserId, orgId: F.org.clerkOrgId, orgRole: 'org:admin' })
}

const scopeA = (): Scope => ({ orgId: F.org.id, scopeOwnerId: F.repA.id })

beforeEach(() => loginAsRepA())
afterEach(() => mockClerkClient.mockReset())

describe('lib/data: OWN-mode reads/writes are scoped by owner, same rejection as a cross-tenant id', () => {
  it('getLeadById returns null for another rep\'s lead', async () => {
    expect(await getLeadById(scopeA(), F.leadB.id)).toBeNull()
  })
  it('getContactById returns null for another rep\'s contact', async () => {
    expect(await getContactById(scopeA(), F.contactB.id)).toBeNull()
  })
  it('getDealById returns null for another rep\'s deal', async () => {
    expect(await getDealById(scopeA(), F.dealB.id)).toBeNull()
  })
  it('getTaskById returns null for another rep\'s task (not assignee or creator)', async () => {
    expect(await getTaskById(scopeA(), F.taskB.id)).toBeNull()
  })
  it('listLeads never includes another rep\'s leads', async () => {
    const ids = (await listLeads(scopeA())).map((l) => l.id)
    expect(ids).not.toContain(F.leadB.id)
    expect(ids).toContain(F.leadA.id) // sanity: not just empty
  })
  it('listContacts never includes another rep\'s contacts', async () => {
    const ids = (await listContacts(scopeA())).map((c) => c.id)
    expect(ids).not.toContain(F.contactB.id)
    expect(ids).toContain(F.contactA.id)
  })
  it('listDeals never includes another rep\'s deals', async () => {
    const ids = (await listDeals(scopeA())).map((d) => d.id)
    expect(ids).not.toContain(F.dealB.id)
    expect(ids).toContain(F.dealA.id)
  })
  it('listTasks never includes another rep\'s tasks', async () => {
    const ids = (await listTasks(scopeA())).map((t) => t.id)
    expect(ids).not.toContain(F.taskB.id)
    expect(ids).toContain(F.taskA.id)
  })
  it('listLeads\' search param still excludes another rep\'s matching record, not just the unfiltered list', async () => {
    // Both reps get a record matching the same distinctive search term — proves the exclusion is
    // actually enforced on the search path itself, not just incidentally true because the two
    // reps' existing fixture names never collided.
    const zA = await prisma.lead.create({
      data: {
        orgId: F.org.id, name: 'Zephyr Co Lead (A)', title: '', companyId: F.company.id,
        email: `zephyr-a-${RUN}@example.com`, phone: '', source: 'Inbound', location: '', ownerId: F.repA.id,
      },
    })
    const zB = await prisma.lead.create({
      data: {
        orgId: F.org.id, name: 'Zephyr Co Lead (B)', title: '', companyId: F.company.id,
        email: `zephyr-b-${RUN}@example.com`, phone: '', source: 'Inbound', location: '', ownerId: F.repB.id,
      },
    })
    const ids = (await listLeads(scopeA(), { search: 'Zephyr' })).map((l) => l.id)
    expect(ids).toContain(zA.id) // sanity: the search itself works
    expect(ids).not.toContain(zB.id)

    await prisma.lead.deleteMany({ where: { id: { in: [zA.id, zB.id] } } })
  })
  it('listActivities (org-wide feed) never includes another rep\'s activity', async () => {
    const activityB = await prisma.activity.create({
      data: { orgId: F.org.id, kind: 'note', title: 'rep B only', actorId: F.repB.id, ownerId: F.repB.id },
    })
    const ids = (await listActivities(scopeA())).map((a) => a.id)
    expect(ids).not.toContain(activityB.id)
  })
  it('getPipelineTotals (the one aggregate in this app) counts only the scoped caller\'s own deals', async () => {
    const totals = await getPipelineTotals(scopeA())
    const stageTotal = totals.find((t) => t.stageId === F.stage.id)!
    // Both dealA (owned by repA) and dealB (owned by repB) sit in F.stage — a scoped repA must
    // see exactly 1 deal / its own value in this stage's totals, not 2.
    expect(stageTotal.count).toBe(1)
    expect(stageTotal.totalValue).toBe(F.dealA.value)
  })
  it('listCompanies\' rollup counts for a scoped Member only reflect their own records, even though the company itself is shared', async () => {
    const companies = await listCompanies(F.org.id, { scopeOwnerId: F.repA.id })
    const co = companies.find((c) => c.id === F.company.id)!
    expect(co).toBeTruthy()
    // Both reps' leads/contacts/deals are on this one shared company — repA's scoped count must
    // exclude repB's, i.e. be strictly less than the company's real org-wide total (2 of each).
    expect(co._count.leads).toBe(1)
    expect(co._count.contacts).toBe(1)
    expect(co._count.deals).toBe(1)
  })
})

/**
 * The scoped-mutation matrix: every exported server action that mutates (or singly reads) an
 * existing lead/contact/deal/task by id. Each entry calls the action with repB's id while logged
 * in as repA; every one must reject exactly like a cross-tenant id would (same thrown-error
 * convention already proven in cross-tenant.test.ts).
 */
const SCOPED_MUTATION_ACTIONS: Record<string, (otherId: string) => Promise<unknown>> = {
  setLeadStatusAction: (id) => actions.setLeadStatusAction(id, 'contacted'),
  convertLeadAction: (id) =>
    actions.convertLeadAction(id, { ownerId: F.repA.id, contactId: randomUUID(), activityId: randomUUID() }),
  updateLeadAction: (id) =>
    actions.updateLeadAction({
      id, name: 'x', title: '', email: '', phone: '', companyId: F.company.id, source: 'Inbound',
      ownerId: F.repA.id, activityId: randomUUID(),
    }),
  updateContactAction: (id) =>
    actions.updateContactAction({
      id, name: 'x', title: '', email: '', phone: '', companyId: F.company.id, ownerId: F.repA.id,
      activityId: randomUUID(),
    }),
  updateDealAction: (id) =>
    actions.updateDealAction({
      id, name: 'x', value: 100, stageId: F.stage.id, closeDate: new Date().toISOString(),
      ownerId: F.repA.id, companyId: F.company.id, activityId: randomUUID(),
    }),
  moveDealAction: (id) => actions.moveDealAction(id, F.otherStage.id),
  toggleTaskAction: (id) => actions.toggleTaskAction(id, true),
  updateTaskAction: (id) =>
    actions.updateTaskAction({
      id, title: 'x', dueDate: new Date().toISOString(), priority: 'low', type: 'todo', ownerId: F.repA.id,
    }),
  deleteTaskAction: (id) => actions.deleteTaskAction(id),
}
const SCOPED_MUTATION_TARGET: Record<keyof typeof SCOPED_MUTATION_ACTIONS, string> = {
  setLeadStatusAction: 'leadB', convertLeadAction: 'leadB', updateLeadAction: 'leadB',
  updateContactAction: 'contactB', updateDealAction: 'dealB', moveDealAction: 'dealB',
  toggleTaskAction: 'taskB', updateTaskAction: 'taskB', deleteTaskAction: 'taskB',
}

describe('lib/actions/crm: OWN-mode scoped-mutation matrix — another rep\'s record id is rejected like a cross-tenant id', () => {
  for (const [name, call] of Object.entries(SCOPED_MUTATION_ACTIONS)) {
    it(`${name} rejects repB's record id`, async () => {
      const targetKey = SCOPED_MUTATION_TARGET[name as keyof typeof SCOPED_MUTATION_TARGET]
      const otherId = (F as unknown as Record<string, { id: string }>)[targetKey].id
      await expect(call(otherId)).rejects.toThrow()
    })
  }
})

/**
 * bulkReassignLeadsAction doesn't fit SCOPED_MUTATION_ACTIONS' single-id signature (it takes an
 * array), so it gets its own dedicated OWN-mode test instead of a matrix entry — see its
 * EXEMPT_ACTIONS reason below. Parity with the old UI behavior (one updateLeadAction call per
 * lead, where one lead failing never blocked the others): a batch containing repB's lead id does
 * NOT reject the whole call — repB's lead comes back `'failed'` (nothing revealed, nothing
 * written for it) while repA's own lead still moves.
 */
describe('lib/actions/crm: bulkReassignLeadsAction — repB\'s lead fails without blocking repA\'s own lead', () => {
  it('moves the in-scope lead and reports the out-of-scope one as failed, without throwing', async () => {
    const result = await actions.bulkReassignLeadsAction({
      leadIds: [F.leadA.id, F.leadB.id],
      ownerId: F.admin.id,
      activityId: randomUUID(),
    })
    expect(result.movedCount).toBe(1)
    expect(result.results).toEqual(
      expect.arrayContaining([
        { leadId: F.leadA.id, outcome: 'moved' },
        { leadId: F.leadB.id, outcome: 'failed' },
      ]),
    )

    const leadA = await prisma.lead.findUnique({ where: { id: F.leadA.id } })
    const leadB = await prisma.lead.findUnique({ where: { id: F.leadB.id } })
    expect(leadA?.ownerId).toBe(F.admin.id)
    expect(leadB?.ownerId).toBe(F.repB.id) // untouched — nothing written for the out-of-scope lead

    // Restore leadA's ownership so later tests in this file (which assume the original fixture
    // ownership) aren't affected by this one's side effect.
    await prisma.lead.update({ where: { id: F.leadA.id }, data: { ownerId: F.repA.id } })
  })
})

/**
 * The scoped-creation matrix: every exported action that creates (or converts into) a new
 * lead/contact/deal with a client-chosen `ownerId`. A scoped Member may only ever create a record
 * owned by themselves — each entry supplies repB's id as the owner while logged in as repA and
 * expects a rejection.
 */
const SCOPED_CREATE_ACTIONS: Record<string, () => Promise<unknown>> = {
  createLeadAction: () =>
    actions.createLeadAction({
      id: randomUUID(), name: 'x', email: '', phone: '', companyId: F.company.id, source: 'Inbound',
      status: 'new', ownerId: F.repB.id, activityId: randomUUID(),
    }),
  createContactAction: () =>
    actions.createContactAction({
      id: randomUUID(), name: 'x', email: '', phone: '', companyId: F.company.id, title: '',
      ownerId: F.repB.id, activityId: randomUUID(),
    }),
  createDealAction: () =>
    actions.createDealAction({
      id: randomUUID(), name: 'x', value: 100, stageId: F.stage.id, closeDate: new Date().toISOString(),
      ownerId: F.repB.id, source: 'Inbound', priority: 'low', activityId: randomUUID(),
    }),
}

describe('lib/actions/crm: OWN-mode scoped-creation matrix — creating a record owned by another rep is rejected', () => {
  for (const [name, call] of Object.entries(SCOPED_CREATE_ACTIONS)) {
    it(`${name} rejects an ownerId other than the scoped caller's own`, async () => {
      await expect(call()).rejects.toThrow()
    })
  }
})

/**
 * Exhaustiveness check: every export of lib/actions/crm.ts must be accounted for — in the
 * scoped-mutation matrix above, the scoped-creation matrix above, or this explicit exempt list
 * (with a one-line reason each). A newly added action that isn't placed in one of the three fails
 * this test immediately, rather than shipping with silent OWN-mode gaps.
 */
// Role each action requires, pinned by tests/integration/cross-tenant.test.ts's "Role-rule audit"
// and admin-only describe blocks — see PROGRESS.md's role-rule audit entry for the full table.
// 15 entries (a prior report miscounted this as 14 — corrected here).
const EXEMPT_ACTIONS: Record<string, string> = {
  createCompanyAction: 'Member or Admin — companies are shared/org-wide identity, never per-owner (see lib/data/companies.ts)',
  updateCompanyAction: 'Member or Admin — same as createCompanyAction',
  deleteCompanyAction: 'Admin only — destructive and org-wide, unlike create/update (Stage 1c fix; was Member-accessible before)',
  inviteMemberAction: 'Admin only — org-membership action; previously had no role check at all (fixed in the role-rule audit)',
  addTaskAction: 'Member or Admin — task assignment is unrestricted even when scoped (see its own doc comment) — visibility, not assignability, is what OWN mode gates',
  logActivityAction: 'Member or Admin — delegates its subject-in-scope check to assertSubjectInScope, covered by its own direct test below',
  addNoteAction: 'Member or Admin — thin wrapper around logActivityAction',
  updateProfileAction: 'Member or Admin — the caller\'s own profile, not an org-level setting',
  syncMyAvatarAction: 'Member or Admin — the caller\'s own avatarUrl, resolved from Clerk\'s own Backend API, not an org-level setting; see tests/integration/avatar-sync.test.ts',
  updateRepVisibilityAction: 'Admin only, via the live Clerk role check (requireLiveAdminAccess), not just Owner.role — the switch itself (Stage 1c), org-level by definition',
  updateOrgTimezoneAction: 'Admin only — org-level setting, not a scoped CRM record',
  updateQuotaAction: 'Admin only — org-level setting; previously called requireAuth(), letting any Member set it (fixed in the role-rule audit)',
  updateCurrencyAction: 'Admin only — org-level setting, not a scoped CRM record',
  updateFiscalYearStartMonthAction: 'Admin only — org-level setting, not a scoped CRM record; see tests/integration/fiscal-year.test.ts',
  createStageAction: 'Admin only — stage structure is org-wide and affects every deal (Stage 1c fix; was Member-accessible before)',
  renameStageAction: 'Admin only — same as createStageAction',
  reorderStageAction: 'Admin only — same as createStageAction',
  deleteStageAction: 'Admin only — same as createStageAction',
  bulkReassignLeadsAction: 'Member or Admin — takes an array of lead ids, not a single one, so it doesn\'t fit SCOPED_MUTATION_ACTIONS\' signature (and an out-of-scope id fails per-lead, not the whole call); covered by its own dedicated test below instead',
}

describe('lib/actions/crm: OWN-mode matrix is exhaustive over every exported action', () => {
  it('every export is covered by the mutation matrix, the creation matrix, or an explicit exemption', () => {
    const covered = new Set([
      ...Object.keys(SCOPED_MUTATION_ACTIONS),
      ...Object.keys(SCOPED_CREATE_ACTIONS),
      ...Object.keys(EXEMPT_ACTIONS),
    ])
    const actual = Object.keys(actions).filter((k) => typeof (actions as Record<string, unknown>)[k] === 'function')
    const uncovered = actual.filter((k) => !covered.has(k))
    expect(uncovered).toEqual([])
  })
})

describe('lib/actions/crm: logActivityAction/addNoteAction reject a subject owned by another rep', () => {
  it('logActivityAction rejects a lead subject owned by repB', async () => {
    await expect(
      actions.logActivityAction(randomUUID(), 'note', 'x', { type: 'lead', id: F.leadB.id, label: 'x' }),
    ).rejects.toThrow()
  })
  it('addNoteAction rejects a deal subject owned by repB', async () => {
    await expect(
      actions.addNoteAction(randomUUID(), { type: 'deal', id: F.dealB.id, label: 'x' }, 'body'),
    ).rejects.toThrow()
  })
})

describe('GET /api/crm-refetch and GET /api/activities: scoped exactly like the data layer', () => {
  it('crm-refetch never returns another rep\'s rows', async () => {
    const response = await crmRefetchGET()
    const data = await response.json()
    expect(data.leads.some((l: { id: string }) => l.id === F.leadB.id)).toBe(false)
    expect(data.contacts.some((c: { id: string }) => c.id === F.contactB.id)).toBe(false)
    expect(data.deals.some((d: { id: string }) => d.id === F.dealB.id)).toBe(false)
    expect(data.tasks.some((t: { id: string }) => t.id === F.taskB.id)).toBe(false)
    expect(data.leads.some((l: { id: string }) => l.id === F.leadA.id)).toBe(true) // sanity
  })
  it('GET /api/activities 404s for a subject owned by another rep, same as a cross-tenant subject', async () => {
    const request = new Request(
      `http://localhost/api/activities?${new URLSearchParams({ subjectType: 'lead', subjectId: F.leadB.id })}`,
    )
    const response = await activitiesGET(request)
    expect(response.status).toBe(404)
  })
  it('GET /api/activities 200s for the caller\'s own subject', async () => {
    const request = new Request(
      `http://localhost/api/activities?${new URLSearchParams({ subjectType: 'lead', subjectId: F.leadA.id })}`,
    )
    const response = await activitiesGET(request)
    expect(response.status).toBe(200)
  })
})

describe('loadCrmData: scoped exactly like the data layer', () => {
  it('a scoped Member\'s full load contains nothing of another rep\'s records', async () => {
    const data = await loadCrmData(scopeA(), F.repA.id, false)
    expect(data.leads.some((l) => l.id === F.leadB.id)).toBe(false)
    expect(data.contacts.some((c) => c.id === F.contactB.id)).toBe(false)
    expect(data.deals.some((d) => d.id === F.dealB.id)).toBe(false)
    expect(data.tasks.some((t) => t.id === F.taskB.id)).toBe(false)
    expect(data.repVisibility).toBe('OWN')
  })
})

describe('Reassignment: the former owner loses visibility across loadCrmData, crm-refetch, and GET /api/activities', () => {
  it('reassigning repA\'s contact to repB removes it from repA\'s own loaded/refetched/activities views', async () => {
    // Give repA a disposable contact to reassign (the matrix tests above mutate/delete F.taskA, so
    // this uses a fresh row rather than reusing a shared fixture).
    const contact = await prisma.contact.create({
      data: {
        orgId: F.org.id, name: 'Reassign Me', title: '', companyId: F.company.id,
        email: `reassign-${RUN}@example.com`, phone: '', location: '', ownerId: F.repA.id,
      },
    })

    loginAsRepA()
    await actions.updateContactAction({
      id: contact.id, name: 'Reassign Me', title: '', email: contact.email, phone: '',
      companyId: F.company.id, ownerId: F.repB.id, activityId: randomUUID(),
    })

    // Still logged in as repA (the former owner) — every one of these must now show nothing of it.
    const loaded = await loadCrmData(scopeA(), F.repA.id, false)
    expect(loaded.contacts.some((c) => c.id === contact.id)).toBe(false)

    const refetchResponse = await crmRefetchGET()
    const refetched = await refetchResponse.json()
    expect(refetched.contacts.some((c: { id: string }) => c.id === contact.id)).toBe(false)

    const activitiesRequest = new Request(
      `http://localhost/api/activities?${new URLSearchParams({ subjectType: 'contact', subjectId: contact.id })}`,
    )
    const activitiesResponse = await activitiesGET(activitiesRequest)
    expect(activitiesResponse.status).toBe(404)

    await prisma.activity.deleteMany({ where: { orgId: F.org.id, contactId: contact.id } })
    await prisma.contact.delete({ where: { id: contact.id } })
  })
})

describe('convertLeadToDeal: the owner-move-on-convert path (reachable only by an unscoped caller)', () => {
  it('converting repA\'s lead to repB moves the lead\'s own ownerId and cascades its existing activities', async () => {
    const lead = await prisma.lead.create({
      data: {
        orgId: F.org.id, name: 'Convert Me', title: '', companyId: F.company.id,
        email: `convert-${RUN}@example.com`, phone: '', source: 'Inbound', location: '', ownerId: F.repA.id,
      },
    })
    // A pre-existing activity on the lead, owned by repA — must cascade to repB on conversion.
    const priorActivity = await prisma.activity.create({
      data: {
        orgId: F.org.id, kind: 'note', title: 'pre-conversion note', actorId: F.repA.id,
        ownerId: F.repA.id, leadId: lead.id, subjectType: 'lead', subjectLabel: 'Convert Me',
      },
    })

    // Only an unscoped caller (a real Admin) can reach this path at all — a scoped Member's
    // convertLeadAction is restricted by assertOwnerInScope to converting to themselves only (see
    // the scoped-mutation matrix above, which proves repA can't even target repB's own lead this
    // way). Logging in as the org's Admin here is what makes `input.ownerId !== lead.ownerId`
    // reachable in the first place.
    loginAsAdmin()
    const result = await actions.convertLeadAction(lead.id, {
      ownerId: F.repB.id,
      contactId: randomUUID(),
      activityId: randomUUID(),
    })

    const updatedLead = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })
    expect(updatedLead.ownerId).toBe(F.repB.id)
    expect(updatedLead.status).toBe('qualified')

    const newContact = await prisma.contact.findUniqueOrThrow({ where: { id: result.contactId } })
    expect(newContact.ownerId).toBe(F.repB.id)

    const cascadedPrior = await prisma.activity.findUniqueOrThrow({ where: { id: priorActivity.id } })
    expect(cascadedPrior.ownerId).toBe(F.repB.id)

    const conversionActivity = await prisma.activity.findFirst({
      where: { orgId: F.org.id, leadId: lead.id, kind: 'created' },
    })
    expect(conversionActivity?.ownerId).toBe(F.repB.id)

    // And now logged in as repA (the former owner, scoped) — the converted lead and its activity
    // are gone from repA's own view, same rule as the plain-reassignment test above.
    loginAsRepA()
    const asFormerOwner = await loadCrmData(scopeA(), F.repA.id, false)
    expect(asFormerOwner.leads.some((l) => l.id === lead.id)).toBe(false)

    await prisma.activity.deleteMany({ where: { orgId: F.org.id, leadId: lead.id } })
    await prisma.contact.delete({ where: { id: result.contactId } })
    await prisma.lead.delete({ where: { id: lead.id } })
  })
})
