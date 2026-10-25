/**
 * GET /api/calendar: range validation, org/OWN-mode isolation, payment exclusion, timezone
 * correctness, and the closed-lead/Won-Lost-deal exclusions. Mirrors the conventions
 * tests/integration/cross-tenant.test.ts and own-mode.test.ts already use (mocked Clerk auth,
 * real DB, real route handler).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@clerk/nextjs/server', () => ({ auth: () => mockAuth(), clerkClient: () => ({}) }))

import { randomUUID } from 'crypto'
import { prisma } from '@lib/prisma'
import { ensureDefaultStages, listStages } from '@lib/data/stages'
import * as actions from '@lib/actions/crm'
import { GET as calendarGET, dynamic as calendarDynamic } from '../../app/api/calendar/route'
import type { PipelineStage } from '@prisma/client'

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

interface OrgFixture {
  org: Awaited<ReturnType<typeof prisma.organization.create>>
  company: Awaited<ReturnType<typeof prisma.company.create>>
  admin: Awaited<ReturnType<typeof prisma.owner.create>>
  stages: PipelineStage[]
}

async function makeOrg(name: string, repVisibility: 'ALL' | 'OWN'): Promise<OrgFixture> {
  const org = await prisma.organization.create({
    data: { clerkOrgId: `test-cal-${name}-${RUN}`, name: `Calendar ${name} ${RUN}`, repVisibility },
  })
  await ensureDefaultStages(org.id)
  const stages = await listStages(org.id)
  const company = await prisma.company.create({ data: { orgId: org.id, name: `Cal Co ${name} ${RUN}` } })
  const admin = await prisma.owner.create({
    data: { orgId: org.id, clerkUserId: `test-cal-${name}-admin-${RUN}`, name: 'Admin', email: `admin-${name}-${RUN}@example.com`, role: 'Admin' },
  })
  return { org, company, admin, stages }
}

let A: OrgFixture
let B: OrgFixture
let repA: Awaited<ReturnType<typeof prisma.owner.create>>
let repB: Awaited<ReturnType<typeof prisma.owner.create>> // in A, OWN mode isn't set on A — see below

beforeAll(async () => {
  A = await makeOrg('A', 'OWN')
  B = await makeOrg('B', 'ALL')
  repA = await prisma.owner.create({
    data: { orgId: A.org.id, clerkUserId: `test-cal-repA-${RUN}`, name: 'Rep A', email: `rep-a-${RUN}@example.com`, role: 'Member' },
  })
  repB = await prisma.owner.create({
    data: { orgId: A.org.id, clerkUserId: `test-cal-repB-${RUN}`, name: 'Rep B', email: `rep-b-${RUN}@example.com`, role: 'Member' },
  })
})

afterAll(async () => {
  for (const org of [A.org, B.org]) {
    await prisma.notification.deleteMany({ where: { orgId: org.id } })
    await prisma.activity.deleteMany({ where: { orgId: org.id } }) // convertLeadAction's test logs one
    await prisma.task.deleteMany({ where: { orgId: org.id } })
    await prisma.deal.deleteMany({ where: { orgId: org.id } })
    await prisma.lead.deleteMany({ where: { orgId: org.id } })
    await prisma.contact.deleteMany({ where: { orgId: org.id } })
    await prisma.company.deleteMany({ where: { orgId: org.id } })
    await prisma.owner.deleteMany({ where: { orgId: org.id } })
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } })
    await prisma.organization.delete({ where: { id: org.id } })
  }
  await prisma.$disconnect()
})

afterEach(() => mockAuth.mockReset())

function loginAs(owner: { clerkUserId: string | null }, org: { clerkOrgId: string }, role: 'org:admin' | 'org:member') {
  mockAuth.mockResolvedValue({ userId: owner.clerkUserId, orgId: org.clerkOrgId, orgRole: role })
}

function calendarRequest(from: string, to: string) {
  return calendarGET(new Request(`http://localhost/api/calendar?from=${from}&to=${to}`))
}

describe('GET /api/calendar: basics', () => {
  it('is force-dynamic', () => {
    expect(calendarDynamic).toBe('force-dynamic')
  })
  it('sets Cache-Control: private, no-store', async () => {
    loginAs(A.admin, A.org, 'org:admin')
    const response = await calendarRequest('2026-11-01', '2026-11-30')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })
  it('401s with no session', async () => {
    const response = await calendarRequest('2026-11-01', '2026-11-30')
    expect(response.status).toBe(401)
  })
})

describe('GET /api/calendar: range validation', () => {
  // beforeEach, not beforeAll — the file-level `afterEach(() => mockAuth.mockReset())` clears the
  // mock after every single test, so a one-time beforeAll login would only survive the first
  // test in this block and leave the rest hitting the 401 branch instead of the 400s under test.
  beforeEach(() => loginAs(A.admin, A.org, 'org:admin'))

  it('rejects a missing from/to (no query params at all)', async () => {
    const response = await calendarGET(new Request('http://localhost/api/calendar'))
    expect(response.status).toBe(400)
  })
  it('rejects a malformed date', async () => {
    const response = await calendarRequest('not-a-date', '2026-11-30')
    expect(response.status).toBe(400)
  })
  it('rejects a non-existent calendar date', async () => {
    const response = await calendarRequest('2026-02-30', '2026-03-01')
    expect(response.status).toBe(400)
  })
  it('rejects from > to', async () => {
    const response = await calendarRequest('2026-11-30', '2026-11-01')
    expect(response.status).toBe(400)
  })
  it('rejects a range of exactly 63 days (one day over the 62-day cap)', async () => {
    const response = await calendarRequest('2026-01-01', '2026-03-04') // 63 days inclusive
    expect(response.status).toBe(400)
  })
  it('rejects a range over 62 days (a larger example)', async () => {
    const response = await calendarRequest('2026-01-01', '2026-03-10') // 69 days
    expect(response.status).toBe(400)
  })
  it('accepts a range of exactly 62 days', async () => {
    const response = await calendarRequest('2026-01-01', '2026-03-03') // 62 days inclusive
    expect(response.status).toBe(200)
  })
})

describe('GET /api/calendar: org isolation', () => {
  it("org B's admin never sees org A's items", async () => {
    const task = await prisma.task.create({
      data: { orgId: A.org.id, title: 'Org A only task', dueDate: new Date('2026-11-05T00:00:00.000Z'), ownerId: A.admin.id, createdById: A.admin.id },
    })
    loginAs(B.admin, B.org, 'org:admin')
    const response = await calendarRequest('2026-11-01', '2026-11-30')
    const body = await response.json()
    expect(body.items.find((i: { subjectId: string }) => i.subjectId === task.id)).toBeUndefined()
  })
})

describe('GET /api/calendar: OWN mode', () => {
  it("a Member sees only their own items — repB's items never appear, and no parent name is ever present for a task", async () => {
    const taskA = await prisma.task.create({
      data: { orgId: A.org.id, title: 'repA task', dueDate: new Date('2026-11-10T00:00:00.000Z'), ownerId: repA.id, createdById: repA.id },
    })
    const taskB = await prisma.task.create({
      data: { orgId: A.org.id, title: 'repB task', dueDate: new Date('2026-11-10T00:00:00.000Z'), ownerId: repB.id, createdById: repB.id },
    })
    const leadA = await prisma.lead.create({
      data: { orgId: A.org.id, name: 'repA lead', title: '', companyId: A.company.id, email: `leada-${RUN}@example.com`, phone: '', source: 'Inbound', location: '', ownerId: repA.id, followUpAt: new Date('2026-11-12T00:00:00.000Z') },
    })
    const leadB = await prisma.lead.create({
      data: { orgId: A.org.id, name: 'repB lead', title: '', companyId: A.company.id, email: `leadb-${RUN}@example.com`, phone: '', source: 'Inbound', location: '', ownerId: repB.id, followUpAt: new Date('2026-11-12T00:00:00.000Z') },
    })

    loginAs(repA, A.org, 'org:member')
    const response = await calendarRequest('2026-11-01', '2026-11-30')
    const body = await response.json()
    const ids = body.items.map((i: { subjectId: string }) => i.subjectId)

    expect(ids).toContain(taskA.id)
    expect(ids).not.toContain(taskB.id)
    expect(ids).toContain(leadA.id)
    expect(ids).not.toContain(leadB.id)

    // No item carries any field with repB's lead/task name, or any kind of "related/parent"
    // field at all for a task — the whole response is serialized and checked as one string so a
    // forgotten field can't quietly slip the leak through.
    const raw = JSON.stringify(body)
    expect(raw).not.toContain('repB lead')
    expect(raw).not.toContain('repB task')
    for (const item of body.items) {
      if (item.subjectType === 'task') {
        expect(Object.keys(item)).not.toContain('relatedTo')
        expect(Object.keys(item)).not.toContain('relatedToLabel')
      }
    }
  })
})

describe('GET /api/calendar: no payment data for either role', () => {
  it("a Member's response never contains a Payment field or dollar-amount-shaped data", async () => {
    loginAs(repA, A.org, 'org:member')
    const response = await calendarRequest('2026-11-01', '2026-11-30')
    const body = await response.json()
    const raw = JSON.stringify(body)
    expect(raw.toLowerCase()).not.toContain('payment')
    expect(raw.toLowerCase()).not.toContain('amount')
  })

  it("an Admin's response never contains a Payment field or dollar-amount-shaped data either", async () => {
    // Payments is admin-only everywhere else in this app, but the Calendar route never imports
    // lib/data/payments at all (see the route's own doc comment) — this isn't a role check to get
    // right, there is simply no code path that could add payment data for anyone, admin included.
    loginAs(A.admin, A.org, 'org:admin')
    const response = await calendarRequest('2026-11-01', '2026-11-30')
    const body = await response.json()
    const raw = JSON.stringify(body)
    expect(raw.toLowerCase()).not.toContain('payment')
    expect(raw.toLowerCase()).not.toContain('amount')
  })
})

describe('GET /api/calendar: closed leads and Won/Lost deals are excluded', () => {
  it('a Lost/Unqualified/converted lead never appears as a follow-up', async () => {
    const lostLead = await prisma.lead.create({
      data: { orgId: A.org.id, name: 'Lost lead', title: '', companyId: A.company.id, email: `lost-${RUN}@example.com`, phone: '', source: 'Inbound', location: '', status: 'lost', ownerId: A.admin.id, followUpAt: new Date('2026-11-20T00:00:00.000Z') },
    })
    const unqualifiedLead = await prisma.lead.create({
      data: { orgId: A.org.id, name: 'Unqualified lead', title: '', companyId: A.company.id, email: `unq-${RUN}@example.com`, phone: '', source: 'Inbound', location: '', status: 'unqualified', ownerId: A.admin.id, followUpAt: new Date('2026-11-20T00:00:00.000Z') },
    })

    loginAs(A.admin, A.org, 'org:admin')
    const response = await calendarRequest('2026-11-01', '2026-11-30')
    const body = await response.json()
    const ids = body.items.map((i: { subjectId: string }) => i.subjectId)
    expect(ids).not.toContain(lostLead.id)
    expect(ids).not.toContain(unqualifiedLead.id)
  })

  it('a converted lead never appears as a follow-up, even while still "new" status', async () => {
    const convertedLead = await prisma.lead.create({
      data: { orgId: A.org.id, name: 'Converted lead', title: '', companyId: A.company.id, email: `conv-${RUN}@example.com`, phone: '', source: 'Inbound', location: '', status: 'new', ownerId: A.admin.id, followUpAt: new Date('2026-11-20T00:00:00.000Z') },
    })
    loginAs(A.admin, A.org, 'org:admin')
    await actions.convertLeadAction(convertedLead.id, { ownerId: A.admin.id, contactId: randomUUID(), activityId: randomUUID() })

    const response = await calendarRequest('2026-11-01', '2026-11-30')
    const body = await response.json()
    const ids = body.items.map((i: { subjectId: string }) => i.subjectId)
    expect(ids).not.toContain(convertedLead.id)
  })

  it('a Won or Lost deal never appears as a close date', async () => {
    const wonStage = A.stages.find((s) => s.key === 'won')!
    const lostStage = A.stages.find((s) => s.key === 'lost')!
    const openStage = A.stages.find((s) => s.key === 'discovery')!

    const wonDeal = await prisma.deal.create({
      data: { orgId: A.org.id, name: 'Won deal', companyId: A.company.id, value: 1000, source: 'Inbound', probability: wonStage.probability, stageId: wonStage.id, closeDate: new Date('2026-11-22T00:00:00.000Z'), ownerId: A.admin.id },
    })
    const lostDeal = await prisma.deal.create({
      data: { orgId: A.org.id, name: 'Lost deal', companyId: A.company.id, value: 1000, source: 'Inbound', probability: lostStage.probability, stageId: lostStage.id, closeDate: new Date('2026-11-22T00:00:00.000Z'), ownerId: A.admin.id },
    })
    const openDeal = await prisma.deal.create({
      data: { orgId: A.org.id, name: 'Open deal', companyId: A.company.id, value: 1000, source: 'Inbound', probability: openStage.probability, stageId: openStage.id, closeDate: new Date('2026-11-22T00:00:00.000Z'), ownerId: A.admin.id },
    })

    loginAs(A.admin, A.org, 'org:admin')
    const response = await calendarRequest('2026-11-01', '2026-11-30')
    const body = await response.json()
    const ids = body.items.map((i: { subjectId: string }) => i.subjectId)
    expect(ids).not.toContain(wonDeal.id)
    expect(ids).not.toContain(lostDeal.id)
    expect(ids).toContain(openDeal.id)
  })
})

describe('GET /api/calendar: a task due 2026-11-01 lands on Nov 1 for Asia/Karachi and America/Los_Angeles viewers', () => {
  it('returns date "2026-11-01" for a task with dueDate midnight UTC on that day, under both timezones', async () => {
    const task = await prisma.task.create({
      data: { orgId: A.org.id, title: 'Timezone check task', dueDate: new Date('2026-11-01T00:00:00.000Z'), ownerId: A.admin.id, createdById: A.admin.id },
    })
    loginAs(A.admin, A.org, 'org:admin')

    // The route itself never reads a caller timezone at all (it returns a plain "YYYY-MM-DD"
    // string, never an ISO instant — see utcYmd in app/api/calendar/route.ts) — so the ONLY way
    // this could ever drift per viewer is if something in the route's own date handling
    // accidentally used a local-time Date method instead of a UTC one. Running the exact same
    // request under two real, opposite-signed UTC offsets (TZ affects the SERVER process, which
    // is the only "local time" in play here — a real Asia/Karachi or America/Los_Angeles
    // browser's OWN local-time methods never reach this route at all) and asserting an identical
    // result is what actually proves that, rather than just asserting it once and trusting the
    // code never changes.
    const prevTz = process.env.TZ
    let dateFromKarachi: string
    let dateFromLA: string
    try {
      process.env.TZ = 'Asia/Karachi'
      const responseKarachi = await calendarRequest('2026-11-01', '2026-11-01')
      const bodyKarachi = await responseKarachi.json()
      dateFromKarachi = bodyKarachi.items.find((i: { subjectId: string }) => i.subjectId === task.id)?.date

      process.env.TZ = 'America/Los_Angeles'
      const responseLA = await calendarRequest('2026-11-01', '2026-11-01')
      const bodyLA = await responseLA.json()
      dateFromLA = bodyLA.items.find((i: { subjectId: string }) => i.subjectId === task.id)?.date
    } finally {
      process.env.TZ = prevTz
    }

    expect(dateFromKarachi).toBe('2026-11-01')
    expect(dateFromLA).toBe('2026-11-01')
  })
})
