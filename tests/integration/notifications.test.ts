/**
 * Stage B: the Notification model, the 'assigned' kind, the two read routes
 * (GET /api/notifications, GET /api/notifications/unread-count), and the two mark-read actions.
 * Covers exactly the behavioral list from the Stage B design review: recipient scoping, OWN-mode
 * retraction on reassignment, Owner.active exclusion, self-assignment never notifying, A->B->A
 * notifying A twice (not deduped away), bulk-reassign/import coalescing into one notification per
 * recipient, and titles never containing a stored value/amount.
 */
import { randomUUID } from 'crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@clerk/nextjs/server', () => ({ auth: () => mockAuth(), clerkClient: () => ({}) }))

import { prisma } from '@lib/prisma'
import { ensureDefaultStages, listStages } from '@lib/data/stages'
import {
  getUnreadCount,
  listNotifications,
  writeAssignedNotification,
  withTransaction as notifWithTransaction,
} from '@lib/data/notifications'
import { writeImportBatchSummaryNotifications } from '@lib/data/import'
import * as actions from '@lib/actions/crm'
import { markAllNotificationsReadAction, markNotificationReadAction } from '@lib/actions/notifications'
import { GET as unreadCountGET, dynamic as unreadCountDynamic } from '../../app/api/notifications/unread-count/route'
import { GET as notificationsGET, dynamic as notificationsDynamic } from '../../app/api/notifications/route'
import { assignableOwners } from '@/lib/utils'
import type { Scope } from '@lib/scope'
import type { PipelineStage } from '@prisma/client'

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

let org: Awaited<ReturnType<typeof prisma.organization.create>>
let company: Awaited<ReturnType<typeof prisma.company.create>>
let repA: Awaited<ReturnType<typeof prisma.owner.create>>
let repB: Awaited<ReturnType<typeof prisma.owner.create>>
let inactiveRep: Awaited<ReturnType<typeof prisma.owner.create>>
let admin: Awaited<ReturnType<typeof prisma.owner.create>>
let stage: PipelineStage

beforeAll(async () => {
  org = await prisma.organization.create({
    data: { clerkOrgId: `test-notif-org-${RUN}`, name: 'Notifications test org', repVisibility: 'OWN' },
  })
  await ensureDefaultStages(org.id)
  stage = (await listStages(org.id)).find((s) => s.key === 'discovery')!
  company = await prisma.company.create({ data: { orgId: org.id, name: `Notif Co ${RUN}` } })
  repA = await prisma.owner.create({
    data: { orgId: org.id, clerkUserId: `test-notif-repA-${RUN}`, name: 'Rep A', email: `rep-a-${RUN}@example.com`, role: 'Member' },
  })
  repB = await prisma.owner.create({
    data: { orgId: org.id, clerkUserId: `test-notif-repB-${RUN}`, name: 'Rep B', email: `rep-b-${RUN}@example.com`, role: 'Member' },
  })
  inactiveRep = await prisma.owner.create({
    data: { orgId: org.id, clerkUserId: `test-notif-inactive-${RUN}`, name: 'Inactive Rep', email: `rep-inactive-${RUN}@example.com`, role: 'Member', active: false },
  })
  admin = await prisma.owner.create({
    data: { orgId: org.id, clerkUserId: `test-notif-admin-${RUN}`, name: 'Admin', email: `admin-${RUN}@example.com`, role: 'Admin' },
  })
})

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { orgId: org.id } })
  await prisma.activity.deleteMany({ where: { orgId: org.id } })
  await prisma.task.deleteMany({ where: { orgId: org.id } })
  await prisma.deal.deleteMany({ where: { orgId: org.id } })
  await prisma.lead.deleteMany({ where: { orgId: org.id } })
  await prisma.contact.deleteMany({ where: { orgId: org.id } })
  await prisma.importBatch.deleteMany({ where: { orgId: org.id } })
  await prisma.company.deleteMany({ where: { orgId: org.id } })
  await prisma.owner.deleteMany({ where: { orgId: org.id } })
  await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } })
  await prisma.organization.delete({ where: { id: org.id } })
  await prisma.$disconnect()
})

function loginAsAdmin() {
  mockAuth.mockResolvedValue({ userId: admin.clerkUserId, orgId: org.clerkOrgId, orgRole: 'org:admin' })
}
function loginAsRepA() {
  mockAuth.mockResolvedValue({ userId: repA.clerkUserId, orgId: org.clerkOrgId, orgRole: 'org:member' })
}
function loginAsRepB() {
  mockAuth.mockResolvedValue({ userId: repB.clerkUserId, orgId: org.clerkOrgId, orgRole: 'org:member' })
}

afterEach(() => mockAuth.mockReset())

const scopeFor = (ownerId: string | null): Scope => ({ orgId: org.id, scopeOwnerId: ownerId })

async function createLeadOwnedBy(ownerId: string) {
  loginAsAdmin()
  const id = randomUUID()
  await actions.createLeadAction({
    id, name: `Lead ${id}`, email: `${id}@example.com`, phone: '', companyId: company.id,
    source: 'Inbound', status: 'new', ownerId, activityId: randomUUID(),
  })
  return id
}

async function createTaskOwnedBy(ownerId: string) {
  loginAsAdmin()
  const id = randomUUID()
  await actions.addTaskAction({
    id, title: `Task ${id}`, dueDate: new Date().toISOString(), priority: 'low', ownerId,
  })
  return id
}

describe('Owner.active exclusion', () => {
  it('createLeadAction rejects an inactive owner', async () => {
    loginAsAdmin()
    await expect(
      actions.createLeadAction({
        id: randomUUID(), name: 'x', email: '', phone: '', companyId: company.id, source: 'Inbound',
        status: 'new', ownerId: inactiveRep.id, activityId: randomUUID(),
      }),
    ).rejects.toThrow()
  })

  it('writeAssignedNotification writes nothing for an inactive recipient', async () => {
    const leadId = await createLeadOwnedBy(repA.id)
    await notifWithTransaction(async (tx) => {
      await writeAssignedNotification(tx, {
        orgId: org.id, recipientId: inactiveRep.id, actorId: admin.id,
        subjectType: 'lead', subjectId: leadId, dedupeKey: randomUUID(),
      })
    })
    expect(await getUnreadCount(org.id, inactiveRep.id)).toBe(0)
  })

  it('assignableOwners excludes an inactive owner from an assignment picker, but keeps the currently-selected inactive owner visible', () => {
    const owners = [
      { id: repA.id, active: true },
      { id: repB.id, active: true },
      { id: inactiveRep.id, active: false },
    ]
    expect(assignableOwners(owners).map((o) => o.id)).toEqual([repA.id, repB.id])
    expect(assignableOwners(owners, inactiveRep.id).map((o) => o.id)).toEqual([repA.id, repB.id, inactiveRep.id])
  })
})

describe('self-assignment never notifies', () => {
  it('createLeadAction writes no notification when owner === actor', async () => {
    loginAsAdmin()
    await actions.createLeadAction({
      id: randomUUID(), name: 'self-assigned', email: '', phone: '', companyId: company.id,
      source: 'Inbound', status: 'new', ownerId: admin.id, activityId: randomUUID(),
    })
    expect(await getUnreadCount(org.id, admin.id)).toBe(0)
  })
})

describe('reassignment: retraction and re-notification (A -> B -> A notifies A twice)', () => {
  it('each reassignment independently notifies the new owner and retracts from the former owner', async () => {
    loginAsAdmin()
    const leadId = await createLeadOwnedBy(repA.id)
    const before = await getUnreadCount(org.id, repA.id)
    expect(before).toBeGreaterThanOrEqual(1) // the initial assignment notified A

    await actions.updateLeadAction({
      id: leadId, name: `Lead ${leadId}`, title: '', email: '', phone: '', companyId: company.id,
      source: 'Inbound', ownerId: repB.id, activityId: randomUUID(),
    })
    // A -> B: A's notification about this lead is retracted; B is freshly notified.
    const afterToB = await listNotifications(scopeFor(null), repA.id)
    expect(afterToB.some((n) => n.subjectId === leadId)).toBe(false)
    const bNotifications = await listNotifications(scopeFor(null), repB.id)
    expect(bNotifications.some((n) => n.subjectId === leadId)).toBe(true)

    await actions.updateLeadAction({
      id: leadId, name: `Lead ${leadId}`, title: '', email: '', phone: '', companyId: company.id,
      source: 'Inbound', ownerId: repA.id, activityId: randomUUID(),
    })
    // B -> A: B's notification is retracted; A is notified again — a second, independent event,
    // not suppressed by any dedupe against the earlier (already-retracted) notification.
    const afterBackToA = await listNotifications(scopeFor(null), repA.id)
    expect(afterBackToA.some((n) => n.subjectId === leadId)).toBe(true)
    const bAfter = await listNotifications(scopeFor(null), repB.id)
    expect(bAfter.some((n) => n.subjectId === leadId)).toBe(false)
  })
})

describe('OWN mode: reassignment hides the record from the former owner entirely', () => {
  it('former owner\'s unread count and list contain nothing about the reassigned record', async () => {
    loginAsAdmin()
    const leadId = await createLeadOwnedBy(repA.id)
    const countBefore = await getUnreadCount(org.id, repA.id)
    expect(countBefore).toBeGreaterThanOrEqual(1)

    await actions.updateLeadAction({
      id: leadId, name: `Lead ${leadId}`, title: '', email: '', phone: '', companyId: company.id,
      source: 'Inbound', ownerId: repB.id, activityId: randomUUID(),
    })

    const list = await listNotifications(scopeFor(null), repA.id)
    expect(list.some((n) => n.subjectId === leadId)).toBe(false)
  })
})

describe('recipient scoping: a Member cannot read or mark another user\'s notifications', () => {
  it('GET /api/notifications only ever returns the caller\'s own notifications', async () => {
    const leadId = await createLeadOwnedBy(repB.id)
    loginAsRepA()
    const response = await notificationsGET()
    const body = await response.json()
    expect(body.notifications.some((n: { subjectId: string }) => n.subjectId === leadId)).toBe(false)

    loginAsRepB()
    const responseB = await notificationsGET()
    const bodyB = await responseB.json()
    expect(bodyB.notifications.some((n: { subjectId: string }) => n.subjectId === leadId)).toBe(true)
  })

  it('markNotificationReadAction scoped by id+orgId+recipientId cannot mark another user\'s notification', async () => {
    loginAsAdmin()
    const leadId = await createLeadOwnedBy(repB.id)
    const bNotification = (await listNotifications(scopeFor(null), repB.id)).find((n) => n.subjectId === leadId)!
    expect(bNotification.readAt).toBeNull()

    loginAsRepA()
    await markNotificationReadAction(bNotification.id)

    const row = await prisma.notification.findUnique({ where: { id: bNotification.id } })
    expect(row?.readAt).toBeNull()
  })

  it('markAllNotificationsReadAction only marks the caller\'s own notifications', async () => {
    loginAsAdmin()
    const leadId = await createLeadOwnedBy(repB.id)
    loginAsRepA()
    await markAllNotificationsReadAction()

    const row = await prisma.lead.findUnique({ where: { id: leadId } })
    const bNotification = await prisma.notification.findFirst({ where: { orgId: org.id, recipientId: repB.id, subjectId: row!.id } })
    expect(bNotification?.readAt).toBeNull()
  })

  it('GET /api/notifications/unread-count is force-dynamic', () => {
    expect(unreadCountDynamic).toBe('force-dynamic')
  })
  it('GET /api/notifications is force-dynamic', () => {
    expect(notificationsDynamic).toBe('force-dynamic')
  })

  it('GET /api/notifications/unread-count returns a Cache-Control: private, no-store header', async () => {
    loginAsRepA()
    const response = await unreadCountGET()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })
})

describe('bulk reassign coalesces into one notification per recipient', () => {
  it('reassigning 3 leads to repB writes exactly one notification with count 3', async () => {
    loginAsAdmin()
    const ids = [await createLeadOwnedBy(repA.id), await createLeadOwnedBy(repA.id), await createLeadOwnedBy(repA.id)]

    await actions.bulkReassignLeadsAction({ leadIds: ids, ownerId: repB.id, activityId: randomUUID() })

    const rows = await prisma.notification.findMany({ where: { orgId: org.id, recipientId: repB.id, count: { not: null } } })
    const matching = rows.filter((r) => r.count === 3)
    expect(matching.length).toBe(1)

    const list = await listNotifications(scopeFor(null), repB.id)
    const title = list.find((n) => n.id === matching[0].id)?.title
    expect(title).toBe('3 leads assigned to you')
  })
})

describe('CSV import writes only a batch summary, never one notification per row', () => {
  it('3 rows imported for repB produce exactly one coalesced notification, idempotently', async () => {
    const batch = await prisma.importBatch.create({
      data: { orgId: org.id, importedById: admin.id, entityType: 'lead', totalRows: 3 },
    })
    for (let i = 0; i < 3; i++) {
      await prisma.lead.create({
        data: {
          orgId: org.id, name: `Import Row ${i} ${batch.id}`, title: '', companyId: company.id,
          email: `import-${batch.id}-${i}@example.com`, phone: '', source: 'Inbound', location: '',
          ownerId: repB.id, importBatchId: batch.id,
        },
      })
    }

    await writeImportBatchSummaryNotifications({ id: batch.id, orgId: org.id, entityType: 'lead' }, admin.id)
    // Retried final chunk calls this a second time — must stay idempotent (unique dedupeKey), not
    // double the count or create a second row.
    await writeImportBatchSummaryNotifications({ id: batch.id, orgId: org.id, entityType: 'lead' }, admin.id)

    const rows = await prisma.notification.findMany({
      where: { orgId: org.id, recipientId: repB.id, dedupeKey: `import:${batch.id}:${repB.id}` },
    })
    expect(rows.length).toBe(1)
    expect(rows[0].count).toBe(3)

    const list = await listNotifications(scopeFor(null), repB.id)
    const title = list.find((n) => n.id === rows[0].id)?.title
    expect(title).toBe('3 leads assigned to you')
  })

  it('the importer never notifies themselves even if the batch assigns rows to them', async () => {
    const batch = await prisma.importBatch.create({
      data: { orgId: org.id, importedById: admin.id, entityType: 'lead', totalRows: 1 },
    })
    await prisma.lead.create({
      data: {
        orgId: org.id, name: `Self Import ${batch.id}`, title: '', companyId: company.id,
        email: `self-import-${batch.id}@example.com`, phone: '', source: 'Inbound', location: '',
        ownerId: admin.id, importBatchId: batch.id,
      },
    })
    await writeImportBatchSummaryNotifications({ id: batch.id, orgId: org.id, entityType: 'lead' }, admin.id)
    expect(await getUnreadCount(org.id, admin.id)).toBe(0)
  })
})

describe('titles never contain a stored value or amount', () => {
  it('an assigned-deal notification title has the deal name but not its dollar value', async () => {
    loginAsAdmin()
    const dealId = randomUUID()
    const value = 123456
    await actions.createDealAction({
      id: dealId, name: `Six Figure Deal ${dealId}`, value, stageId: stage.id,
      closeDate: new Date().toISOString(), companyId: company.id, ownerId: repA.id,
      source: 'Inbound', priority: 'low', activityId: randomUUID(),
    })

    const list = await listNotifications(scopeFor(null), repA.id)
    const title = list.find((n) => n.subjectId === dealId)?.title
    expect(title).toBeTruthy()
    expect(title).not.toContain(String(value))
    expect(title).toBe(`Deal assigned to you: Six Figure Deal ${dealId}`)
  })
})

describe('unread count and the list agree (Stage B sign-off check 2)', () => {
  it('count equals the unread portion of the list after deleting a task, completing another, and reassigning a lead', async () => {
    // A fresh recipient, not repA/repB — both already carry notifications (some marked read) from
    // earlier describe blocks in this file, and the list legitimately includes read rows (newest
    // 50) while the count is unread-only, so count vs. raw list.length would disagree for reasons
    // having nothing to do with this test. The real invariant is: every notification `count`
    // counts appears in the list as unread, and nothing else in the list is unread either.
    const freshRep = await prisma.owner.create({
      data: { orgId: org.id, clerkUserId: `test-notif-fresh-${randomUUID()}`, name: 'Fresh Rep', email: `fresh-${randomUUID()}@example.com`, role: 'Member' },
    })

    const assertAgree = async (recipientId: string) => {
      const count = await getUnreadCount(org.id, recipientId)
      const list = await listNotifications(scopeFor(null), recipientId)
      expect(count).toBe(list.filter((n) => n.readAt === null).length)
    }

    loginAsAdmin()
    const taskToDelete = await createTaskOwnedBy(freshRep.id)
    const taskToComplete = await createTaskOwnedBy(freshRep.id)
    const leadToReassign = await createLeadOwnedBy(freshRep.id)
    await assertAgree(freshRep.id)
    expect(await getUnreadCount(org.id, freshRep.id)).toBe(3)

    // Deleting a task does NOT cascade-delete its Notification row (subjectId is a soft
    // polymorphic reference, not an enforced FK) — without retractNotificationsForSubject inside
    // deleteTask, the count above would still include it while listNotifications correctly drops
    // it (buildTitle's lookup finds nothing), breaking the count/list agreement this test checks.
    await actions.deleteTaskAction(taskToDelete)
    await assertAgree(freshRep.id)
    expect(await getUnreadCount(org.id, freshRep.id)).toBe(2)

    await actions.toggleTaskAction(taskToComplete, true)
    await assertAgree(freshRep.id)
    expect(await getUnreadCount(org.id, freshRep.id)).toBe(2) // unaffected — completion isn't retraction

    await actions.updateLeadAction({
      id: leadToReassign, name: `Lead ${leadToReassign}`, title: '', email: '', phone: '',
      companyId: company.id, source: 'Inbound', ownerId: repB.id, activityId: randomUUID(),
    })
    await assertAgree(freshRep.id)
    expect(await getUnreadCount(org.id, freshRep.id)).toBe(1) // the lead's notification moved away

    // The reassignment moved the notification to repB, not just removed it from freshRep.
    await assertAgree(repB.id)
    const repBUnreadForLead = (await listNotifications(scopeFor(null), repB.id)).filter(
      (n) => n.subjectId === leadToReassign && n.readAt === null,
    )
    expect(repBUnreadForLead.length).toBe(1)

    await prisma.notification.deleteMany({ where: { orgId: org.id, recipientId: freshRep.id } })
    await prisma.task.deleteMany({ where: { orgId: org.id, ownerId: freshRep.id } })
    await prisma.owner.delete({ where: { id: freshRep.id } })
  })
})

describe('GET /api/notifications query count with mixed subject types (Stage B sign-off check 3)', () => {
  it('stays bounded (one query per subject type present, not one per notification)', async () => {
    const leadIds = Array.from({ length: 13 }, () => randomUUID())
    const contactIds = Array.from({ length: 13 }, () => randomUUID())
    const dealIds = Array.from({ length: 12 }, () => randomUUID())
    const taskIds = Array.from({ length: 12 }, () => randomUUID())

    await prisma.lead.createMany({
      data: leadIds.map((id, i) => ({
        id, orgId: org.id, name: `Bulk Lead ${i} ${id}`, title: '', companyId: company.id,
        email: `bulk-lead-${id}@example.com`, phone: '', source: 'Inbound' as const, location: '', ownerId: repA.id,
      })),
    })
    await prisma.contact.createMany({
      data: contactIds.map((id, i) => ({
        id, orgId: org.id, name: `Bulk Contact ${i} ${id}`, title: '', companyId: company.id,
        email: `bulk-contact-${id}@example.com`, phone: '', location: '', tags: [], lifecycle: 'Prospect', ownerId: repA.id,
      })),
    })
    await prisma.deal.createMany({
      data: dealIds.map((id, i) => ({
        id, orgId: org.id, name: `Bulk Deal ${i} ${id}`, companyId: company.id, value: 100,
        source: 'Inbound' as const, probability: stage.probability, stageId: stage.id, closeDate: new Date(), ownerId: repA.id,
      })),
    })
    await prisma.task.createMany({
      data: taskIds.map((id, i) => ({
        id, orgId: org.id, title: `Bulk Task ${i} ${id}`, dueDate: new Date(), ownerId: repA.id, createdById: admin.id,
      })),
    })

    const subjectIds = [
      ...leadIds.map((id) => ({ subjectType: 'lead' as const, subjectId: id })),
      ...contactIds.map((id) => ({ subjectType: 'contact' as const, subjectId: id })),
      ...dealIds.map((id) => ({ subjectType: 'deal' as const, subjectId: id })),
      ...taskIds.map((id) => ({ subjectType: 'task' as const, subjectId: id })),
    ]
    await prisma.notification.createMany({
      data: subjectIds.map(({ subjectType, subjectId }) => ({
        orgId: org.id, recipientId: repA.id, kind: 'assigned' as const, subjectType, subjectId,
        dedupeKey: randomUUID(),
      })),
    })

    let queryCount = 0
    const onQuery = () => { queryCount++ }
    // @ts-expect-error -- 'query' event typing requires the log config to include it; see
    // lib/prisma.ts's test-only { emit: 'event', level: 'query' } entry.
    prisma.$on('query', onQuery)

    loginAsRepA()
    const response = await notificationsGET()
    const body = await response.json()
    expect(body.notifications.length).toBe(50)

    // Bounded: 1 query to list the notifications + at most 4 (one per subject type present) to
    // fetch their names — never one per row. Report the real number rather than hiding it behind
    // a loose upper bound: it should be close to 5-7 (plus requireAuth's own 2 lookups), nowhere
    // near 50.
    console.log(`GET /api/notifications issued ${queryCount} Prisma queries for 50 mixed-subject-type notifications`)
    expect(queryCount).toBeLessThanOrEqual(10)
  })
})
