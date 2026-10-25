/**
 * Stage C: the time-based notification kinds (task_due, lead_follow_up), computed at read time by
 * `scanAndNotify` (no cron — Vercel Hobby has none). Covers exactly the behavioral list from the
 * Stage C design: the atomic 5-minute claim, dedupe-by-triggering-date (a postponed/rescheduled
 * item notifies again, an unchanged one doesn't), the first-scan flood-control summary vs.
 * individual notifications on later scans, the per-scan flood cap, read-time visibility (done/
 * deleted/reassigned/closed/date-changed/out-of-scope), timezone-correct day boundaries, and
 * retention cleanup.
 */
import { randomUUID } from 'crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@clerk/nextjs/server', () => ({ auth: () => mockAuth(), clerkClient: () => ({}) }))

import { prisma } from '@lib/prisma'
import { listNotifications, scanAndNotify, SCAN_FLOOD_CAP } from '@lib/data/notifications'
import * as actions from '@lib/actions/crm'
import type { Scope } from '@lib/scope'

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const DAY_MS = 24 * 60 * 60 * 1000
const SIX_MINUTES_AGO = new Date(Date.now() - 6 * 60 * 1000)

let org: Awaited<ReturnType<typeof prisma.organization.create>>
let company: Awaited<ReturnType<typeof prisma.company.create>>
let admin: Awaited<ReturnType<typeof prisma.owner.create>>

beforeAll(async () => {
  org = await prisma.organization.create({
    data: { clerkOrgId: `test-scan-org-${RUN}`, name: 'Notification-scan test org', repVisibility: 'OWN' },
  })
  company = await prisma.company.create({ data: { orgId: org.id, name: `Scan Co ${RUN}` } })
  admin = await prisma.owner.create({
    data: { orgId: org.id, clerkUserId: `test-scan-admin-${RUN}`, name: 'Admin', email: `admin-${RUN}@example.com`, role: 'Admin' },
  })
})

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { orgId: org.id } })
  await prisma.activity.deleteMany({ where: { orgId: org.id } })
  await prisma.task.deleteMany({ where: { orgId: org.id } })
  await prisma.deal.deleteMany({ where: { orgId: org.id } })
  await prisma.contact.deleteMany({ where: { orgId: org.id } }) // convertLeadAction's test creates one
  await prisma.lead.deleteMany({ where: { orgId: org.id } })
  await prisma.company.deleteMany({ where: { orgId: org.id } })
  await prisma.owner.deleteMany({ where: { orgId: org.id } })
  await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } })
  await prisma.organization.delete({ where: { id: org.id } })
  await prisma.$disconnect()
})

afterEach(() => mockAuth.mockReset())

const scopeFor = (ownerId: string | null): Scope => ({ orgId: org.id, scopeOwnerId: ownerId })

let repCounter = 0
/** A fresh owner per test — scanAndNotify is stateful (Owner.lastScannedAt) and every test needs
 *  precise control over whether a given scan is this owner's "first" one. */
async function createRep(opts: { timezone?: string | null; lastScannedAt?: Date | null } = {}) {
  repCounter++
  return prisma.owner.create({
    data: {
      orgId: org.id, clerkUserId: `test-scan-rep-${RUN}-${repCounter}`, name: `Rep ${repCounter}`,
      email: `rep-${RUN}-${repCounter}@example.com`, role: 'Member',
      timezone: opts.timezone ?? null,
      ...(opts.lastScannedAt !== undefined && { lastScannedAt: opts.lastScannedAt }),
    },
  })
}

async function createOverdueTask(ownerId: string, daysOverdue: number) {
  return prisma.task.create({
    data: {
      orgId: org.id, title: `Task ${randomUUID()}`, dueDate: new Date(Date.now() - daysOverdue * DAY_MS),
      ownerId, createdById: admin.id, done: false,
    },
  })
}

async function createOverdueLead(ownerId: string, daysOverdue: number, status: 'new' | 'lost' | 'unqualified' = 'new') {
  return prisma.lead.create({
    data: {
      orgId: org.id, name: `Lead ${randomUUID()}`, title: '', companyId: company.id,
      email: `lead-${randomUUID()}@example.com`, phone: '', source: 'Inbound', location: '',
      ownerId, status, followUpAt: new Date(Date.now() - daysOverdue * DAY_MS),
    },
  })
}

describe('first scan: one summary per kind, never individual notifications for pre-existing overdue items', () => {
  it('a first-ever scan with 3 overdue tasks and 2 overdue leads writes exactly 2 summary rows', async () => {
    const rep = await createRep({ lastScannedAt: null })
    await Promise.all([
      createOverdueTask(rep.id, 3), createOverdueTask(rep.id, 1), createOverdueTask(rep.id, 5),
    ])
    await Promise.all([createOverdueLead(rep.id, 2), createOverdueLead(rep.id, 4)])

    await scanAndNotify(org.id, rep.id)

    const rows = await prisma.notification.findMany({ where: { orgId: org.id, recipientId: rep.id } })
    expect(rows.length).toBe(2)
    const taskRow = rows.find((r) => r.kind === 'task_due')!
    const leadRow = rows.find((r) => r.kind === 'lead_follow_up')!
    expect(taskRow.count).toBe(3)
    expect(taskRow.subjectId).toBeNull()
    expect(leadRow.count).toBe(2)

    const list = await listNotifications(scopeFor(rep.id), rep.id)
    expect(list.find((n) => n.id === taskRow.id)?.title).toBe('3 tasks due or overdue')
    expect(list.find((n) => n.id === leadRow.id)?.title).toBe('2 leads need follow-up')
  })
})

describe('the atomic 5-minute claim', () => {
  it('a second scan within 5 minutes of the first does nothing at all', async () => {
    const rep = await createRep({ lastScannedAt: null })
    await createOverdueTask(rep.id, 1)
    await scanAndNotify(org.id, rep.id)
    const countAfterFirst = await prisma.notification.count({ where: { orgId: org.id, recipientId: rep.id } })
    expect(countAfterFirst).toBe(1)

    await createOverdueTask(rep.id, 1) // a second overdue task appears before the next allowed scan
    await scanAndNotify(org.id, rep.id)
    const countAfterSecond = await prisma.notification.count({ where: { orgId: org.id, recipientId: rep.id } })
    expect(countAfterSecond).toBe(1) // unchanged — the claim rejected this call outright
  })

  it('an inactive owner is never scanned', async () => {
    const rep = await createRep({ lastScannedAt: null })
    await prisma.owner.update({ where: { id: rep.id }, data: { active: false } })
    await createOverdueTask(rep.id, 1)
    await scanAndNotify(org.id, rep.id)
    expect(await prisma.notification.count({ where: { orgId: org.id, recipientId: rep.id } })).toBe(0)
    const owner = await prisma.owner.findUnique({ where: { id: rep.id } })
    expect(owner?.lastScannedAt).toBeNull() // never even claimed
  })
})

describe('dedupe by triggering date: a postponed task/moved follow-up notifies again, an unchanged one does not', () => {
  it('task_due: two scans with the same due date write one notification; a changed due date writes a second', async () => {
    const rep = await createRep({ lastScannedAt: SIX_MINUTES_AGO }) // not a first scan
    const task = await createOverdueTask(rep.id, 3)

    await scanAndNotify(org.id, rep.id)
    expect(await prisma.notification.count({ where: { orgId: org.id, recipientId: rep.id, kind: 'task_due' } })).toBe(1)

    // Scan again with the SAME due date (simulating the next 5-minute tick) — must stay at 1.
    await prisma.owner.update({ where: { id: rep.id }, data: { lastScannedAt: SIX_MINUTES_AGO } })
    await scanAndNotify(org.id, rep.id)
    expect(await prisma.notification.count({ where: { orgId: org.id, recipientId: rep.id, kind: 'task_due' } })).toBe(1)

    // The task gets postponed to a different (still-overdue) date, bypassing updateTaskAction's
    // own write-time retraction on purpose — this isolates the SCAN's own dedupe-by-date
    // behavior from the action layer's separate retraction, which has its own test elsewhere.
    await prisma.task.update({ where: { id: task.id }, data: { dueDate: new Date(Date.now() - 1 * DAY_MS) } })
    await prisma.owner.update({ where: { id: rep.id }, data: { lastScannedAt: SIX_MINUTES_AGO } })
    await scanAndNotify(org.id, rep.id)
    expect(await prisma.notification.count({ where: { orgId: org.id, recipientId: rep.id, kind: 'task_due' } })).toBe(2)
  })

  it('lead_follow_up: a moved follow-up date notifies again', async () => {
    const rep = await createRep({ lastScannedAt: SIX_MINUTES_AGO })
    const lead = await createOverdueLead(rep.id, 3)

    await scanAndNotify(org.id, rep.id)
    expect(await prisma.notification.count({ where: { orgId: org.id, recipientId: rep.id, kind: 'lead_follow_up' } })).toBe(1)

    await prisma.lead.update({ where: { id: lead.id }, data: { followUpAt: new Date(Date.now() - 1 * DAY_MS) } })
    await prisma.owner.update({ where: { id: rep.id }, data: { lastScannedAt: SIX_MINUTES_AGO } })
    await scanAndNotify(org.id, rep.id)
    expect(await prisma.notification.count({ where: { orgId: org.id, recipientId: rep.id, kind: 'lead_follow_up' } })).toBe(2)
  })
})

describe('flood cap on a non-first scan', () => {
  it(`more than ${SCAN_FLOOD_CAP} newly-overdue tasks collapse into one summary, not one each`, async () => {
    const rep = await createRep({ lastScannedAt: SIX_MINUTES_AGO })
    const count = SCAN_FLOOD_CAP + 5
    await prisma.task.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        id: randomUUID(), orgId: org.id, title: `Flood Task ${i}`, dueDate: new Date(Date.now() - DAY_MS),
        ownerId: rep.id, createdById: admin.id, done: false,
      })),
    })

    await scanAndNotify(org.id, rep.id)

    const rows = await prisma.notification.findMany({ where: { orgId: org.id, recipientId: rep.id, kind: 'task_due' } })
    expect(rows.length).toBe(1)
    expect(rows[0].count).toBe(count)
    expect(rows[0].subjectId).toBeNull()
  }, 60000)
})

describe('read-time visibility (OWN mode): a scoped recipient never sees a stale time-based notification', () => {
  it('hides a task_due row once the task is done, deleted, reassigned, or out of the recipient\'s scope', async () => {
    const rep = await createRep({ lastScannedAt: SIX_MINUTES_AGO })
    const other = await createRep({ lastScannedAt: SIX_MINUTES_AGO })

    const doneTask = await createOverdueTask(rep.id, 1)
    const deletedTask = await createOverdueTask(rep.id, 1)
    const reassignedTask = await createOverdueTask(rep.id, 1)
    const liveTask = await createOverdueTask(rep.id, 1)

    const insertRow = (subjectId: string, triggerDays: number) =>
      prisma.notification.create({
        data: {
          orgId: org.id, recipientId: rep.id, kind: 'task_due', subjectType: 'task', subjectId,
          triggerDate: new Date(Date.now() - triggerDays * DAY_MS).toISOString().slice(0, 10),
          dedupeKey: randomUUID(),
        },
      })
    await insertRow(doneTask.id, 1)
    await insertRow(deletedTask.id, 1)
    await insertRow(reassignedTask.id, 1)
    const liveRow = await insertRow(liveTask.id, 1)

    await prisma.task.update({ where: { id: doneTask.id }, data: { done: true } })
    await prisma.task.delete({ where: { id: deletedTask.id } })
    await prisma.task.update({ where: { id: reassignedTask.id }, data: { ownerId: other.id } })

    // scope.scopeOwnerId = rep.id — the exact OWN-mode shape a scoped Member's own session has.
    const list = await listNotifications(scopeFor(rep.id), rep.id)
    const visibleIds = new Set(list.map((n) => n.id))
    expect(visibleIds.has(liveRow.id)).toBe(true)
    expect(list.length).toBe(1) // only the live one — the other 3 are all hidden
  })

  it('hides a lead_follow_up row once the lead is converted, closed, or reassigned', async () => {
    const rep = await createRep({ lastScannedAt: SIX_MINUTES_AGO })
    const other = await createRep({ lastScannedAt: SIX_MINUTES_AGO })

    const convertedLead = await createOverdueLead(rep.id, 1)
    const closedLead = await createOverdueLead(rep.id, 1)
    const reassignedLead = await createOverdueLead(rep.id, 1)
    const liveLead = await createOverdueLead(rep.id, 1)

    const insertRow = (subjectId: string) =>
      prisma.notification.create({
        data: {
          orgId: org.id, recipientId: rep.id, kind: 'lead_follow_up', subjectType: 'lead', subjectId,
          triggerDate: new Date(Date.now() - DAY_MS).toISOString().slice(0, 10),
          dedupeKey: randomUUID(),
        },
      })
    await insertRow(convertedLead.id)
    await insertRow(closedLead.id)
    await insertRow(reassignedLead.id)
    const liveRow = await insertRow(liveLead.id)

    loginAsAdmin()
    await actions.convertLeadAction(convertedLead.id, { ownerId: rep.id, contactId: randomUUID(), activityId: randomUUID() })
    await prisma.lead.update({ where: { id: closedLead.id }, data: { status: 'lost' } })
    await prisma.lead.update({ where: { id: reassignedLead.id }, data: { ownerId: other.id } })

    // Filtered to just these 4 lead ids — converting the lead above ALSO writes a brand-new
    // 'assigned' notification for the contact it creates (a real, valid, unrelated notification
    // for this same recipient), so the list's raw length is no longer just these 4 rows.
    const testLeadIds = new Set([convertedLead.id, closedLead.id, reassignedLead.id, liveLead.id])
    const list = await listNotifications(scopeFor(rep.id), rep.id)
    const relevant = list.filter((n) => n.subjectType === 'lead' && n.subjectId && testLeadIds.has(n.subjectId))
    expect(relevant.map((n) => n.id)).toEqual([liveRow.id])
  })

  function loginAsAdmin() {
    mockAuth.mockResolvedValue({ userId: admin.clerkUserId, orgId: org.clerkOrgId, orgRole: 'org:admin' })
  }
})

describe('day boundaries use the recipient\'s own timezone', () => {
  it('a task due "tomorrow" (UTC) is already due for a Karachi recipient but not yet for a Los Angeles one', async () => {
    const karachiRep = await createRep({ timezone: 'Asia/Karachi', lastScannedAt: null })
    const laRep = await createRep({ timezone: 'America/Los_Angeles', lastScannedAt: null })

    // Freeze "now" at 23:30 UTC on a fixed day — local time in Karachi (UTC+5) is already past
    // midnight into the next calendar day; local time in Los Angeles (UTC-7/8) is still the
    // earlier evening of the same day. The due date below is "tomorrow" relative to UTC's
    // current date, which is exactly Karachi's "today" but still Los Angeles's "tomorrow".
    const frozenNow = new Date('2026-11-10T23:30:00.000Z')
    const dueDate = new Date('2026-11-11T00:00:00.000Z')

    // Task setup happens with REAL timers — only scanAndNotify's own `Date.now()`/`new Date()`
    // calls need faking, and keeping the real network I/O for the setup queries off of fake
    // timers avoids any risk of Prisma's own internal timeout/retry timers never firing.
    await prisma.task.create({
      data: { orgId: org.id, title: `Karachi boundary task`, dueDate, ownerId: karachiRep.id, createdById: admin.id, done: false },
    })
    await prisma.task.create({
      data: { orgId: org.id, title: `LA boundary task`, dueDate, ownerId: laRep.id, createdById: admin.id, done: false },
    })

    // shouldAdvanceTime keeps the fake clock ticking forward in real time (just starting from
    // frozenNow instead of the real "now") — scanAndNotify's own setTimeout-driven retries/
    // timeouts (see lib/prisma.ts) keep working normally; only the STARTING point of "now" is
    // under test control, which is all this test needs.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(frozenNow)
    try {
      await scanAndNotify(org.id, karachiRep.id)
      await scanAndNotify(org.id, laRep.id)
    } finally {
      vi.useRealTimers()
    }

    const karachiNotifs = await prisma.notification.count({ where: { orgId: org.id, recipientId: karachiRep.id, kind: 'task_due' } })
    const laNotifs = await prisma.notification.count({ where: { orgId: org.id, recipientId: laRep.id, kind: 'task_due' } })
    expect(karachiNotifs).toBe(1) // already "today" for them — due
    expect(laNotifs).toBe(0) // still "tomorrow" for them — not due yet
  })
})

describe('retention: read notifications older than 30 days are deleted inside the scan', () => {
  it('deletes an old read notification but keeps a recent one', async () => {
    const rep = await createRep({ lastScannedAt: SIX_MINUTES_AGO })
    const old = await prisma.notification.create({
      data: {
        orgId: org.id, recipientId: rep.id, kind: 'assigned', subjectType: 'task', subjectId: randomUUID(),
        dedupeKey: randomUUID(), readAt: new Date(Date.now() - 31 * DAY_MS), createdAt: new Date(Date.now() - 31 * DAY_MS),
      },
    })
    const recent = await prisma.notification.create({
      data: {
        orgId: org.id, recipientId: rep.id, kind: 'assigned', subjectType: 'task', subjectId: randomUUID(),
        dedupeKey: randomUUID(), readAt: new Date(Date.now() - 2 * DAY_MS),
      },
    })

    await scanAndNotify(org.id, rep.id)

    expect(await prisma.notification.findUnique({ where: { id: old.id } })).toBeNull()
    expect(await prisma.notification.findUnique({ where: { id: recent.id } })).not.toBeNull()
  })
})
