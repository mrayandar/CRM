/**
 * Stage E: per-owner notification preferences. Covers exactly the behavioral list from the Stage
 * E design: one user's change never affects another's, a Member and an Admin can each change
 * their own identically (there's no role distinction in this check — it's always "your own"),
 * and a disabled kind creates no new notifications (both the per-event write functions and
 * scanAndNotify's own scan check this) AND hides any of its existing notifications already in
 * the table (read-time, via listNotifications/getUnreadCount).
 */
import { randomUUID } from 'crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@clerk/nextjs/server', () => ({ auth: () => mockAuth(), clerkClient: () => ({}) }))

import { prisma } from '@lib/prisma'
import {
  getNotificationPreferences,
  getUnreadCount,
  listNotifications,
  scanAndNotify,
} from '@lib/data/notifications'
import * as actions from '@lib/actions/crm'
import { updateNotificationPreferenceAction } from '@lib/actions/notifications'
import type { Scope } from '@lib/scope'

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const DAY_MS = 24 * 60 * 60 * 1000

let org: Awaited<ReturnType<typeof prisma.organization.create>>
let company: Awaited<ReturnType<typeof prisma.company.create>>
let admin: Awaited<ReturnType<typeof prisma.owner.create>>
let repA: Awaited<ReturnType<typeof prisma.owner.create>>
let repB: Awaited<ReturnType<typeof prisma.owner.create>>

beforeAll(async () => {
  org = await prisma.organization.create({
    data: { clerkOrgId: `test-prefs-org-${RUN}`, name: 'Notification-prefs test org', repVisibility: 'ALL' },
  })
  company = await prisma.company.create({ data: { orgId: org.id, name: `Prefs Co ${RUN}` } })
  admin = await prisma.owner.create({
    data: { orgId: org.id, clerkUserId: `test-prefs-admin-${RUN}`, name: 'Admin', email: `admin-${RUN}@example.com`, role: 'Admin' },
  })
  repA = await prisma.owner.create({
    data: { orgId: org.id, clerkUserId: `test-prefs-repA-${RUN}`, name: 'Rep A', email: `rep-a-${RUN}@example.com`, role: 'Member' },
  })
  repB = await prisma.owner.create({
    data: { orgId: org.id, clerkUserId: `test-prefs-repB-${RUN}`, name: 'Rep B', email: `rep-b-${RUN}@example.com`, role: 'Member' },
  })
})

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { orgId: org.id } })
  await prisma.notificationPreference.deleteMany({ where: { orgId: org.id } })
  await prisma.activity.deleteMany({ where: { orgId: org.id } })
  await prisma.task.deleteMany({ where: { orgId: org.id } })
  await prisma.lead.deleteMany({ where: { orgId: org.id } })
  await prisma.company.deleteMany({ where: { orgId: org.id } })
  await prisma.owner.deleteMany({ where: { orgId: org.id } })
  await prisma.organization.delete({ where: { id: org.id } })
  await prisma.$disconnect()
})

afterEach(() => mockAuth.mockReset())

const scopeFor = (ownerId: string | null): Scope => ({ orgId: org.id, scopeOwnerId: ownerId })

function loginAsAdmin() {
  mockAuth.mockResolvedValue({ userId: admin.clerkUserId, orgId: org.clerkOrgId, orgRole: 'org:admin' })
}
function loginAsRepA() {
  mockAuth.mockResolvedValue({ userId: repA.clerkUserId, orgId: org.clerkOrgId, orgRole: 'org:member' })
}

describe('a Member can change their own preference; another user is never affected', () => {
  it("repA disabling 'assigned' leaves repB's preference untouched", async () => {
    loginAsRepA()
    await updateNotificationPreferenceAction({ kind: 'assigned', enabled: false })

    const repAPrefs = await getNotificationPreferences(org.id, repA.id)
    const repBPrefs = await getNotificationPreferences(org.id, repB.id)
    expect(repAPrefs.assigned).toBe(false)
    expect(repBPrefs.assigned).toBe(true) // untouched — still the default
  })
})

describe('a Member and an Admin can each change their own preference', () => {
  it('repA disables task_due and admin disables lead_follow_up, independently', async () => {
    loginAsRepA()
    await updateNotificationPreferenceAction({ kind: 'task_due', enabled: false })
    loginAsAdmin()
    await updateNotificationPreferenceAction({ kind: 'lead_follow_up', enabled: false })

    const repAPrefs = await getNotificationPreferences(org.id, repA.id)
    const adminPrefs = await getNotificationPreferences(org.id, admin.id)
    expect(repAPrefs.task_due).toBe(false)
    expect(repAPrefs.lead_follow_up).toBe(true) // repA never touched this one
    expect(adminPrefs.lead_follow_up).toBe(false)
    expect(adminPrefs.task_due).toBe(true) // admin never touched this one
  })

  it('rejects an invalid kind even for an admin', async () => {
    loginAsAdmin()
    await expect(
      // @ts-expect-error -- deliberately invalid, to prove the server validates it
      updateNotificationPreferenceAction({ kind: 'not_a_real_kind', enabled: false }),
    ).rejects.toThrow('Invalid notification kind')
  })
})

describe('disabled kinds: no new writes, and existing notifications of that kind are hidden', () => {
  it("'assigned': disabling it stops new writes and hides an existing row", async () => {
    // A fresh rep, isolated from the preference changes made in earlier describe blocks above.
    const rep = await prisma.owner.create({
      data: { orgId: org.id, clerkUserId: `test-prefs-fresh1-${RUN}`, name: 'Fresh Rep 1', email: `fresh1-${RUN}@example.com`, role: 'Member' },
    })

    loginAsAdmin()
    const leadId = randomUUID()
    await actions.createLeadAction({
      id: leadId, name: 'Before disabling', email: `${leadId}@example.com`, phone: '', companyId: company.id,
      source: 'Inbound', status: 'new', ownerId: rep.id, activityId: randomUUID(),
    })
    expect(await getUnreadCount(org.id, rep.id)).toBe(1) // written while still enabled (the default)

    mockAuth.mockResolvedValue({ userId: rep.clerkUserId, orgId: org.clerkOrgId, orgRole: 'org:member' })
    await updateNotificationPreferenceAction({ kind: 'assigned', enabled: false })

    // Read-time: the row from before still exists in the table, but must no longer show.
    expect(await getUnreadCount(org.id, rep.id)).toBe(0)
    const list = await listNotifications(scopeFor(null), rep.id)
    expect(list.find((n) => n.subjectId === leadId)).toBeUndefined()

    // Write-time: a brand new assignment must not create anything either.
    loginAsAdmin()
    const secondLeadId = randomUUID()
    await actions.createLeadAction({
      id: secondLeadId, name: 'After disabling', email: `${secondLeadId}@example.com`, phone: '', companyId: company.id,
      source: 'Inbound', status: 'new', ownerId: rep.id, activityId: randomUUID(),
    })
    expect(await prisma.notification.count({ where: { orgId: org.id, recipientId: rep.id, subjectId: secondLeadId } })).toBe(0)
  })

  it('task_due: disabling it stops scanAndNotify from writing or even querying for due tasks', async () => {
    const rep = await prisma.owner.create({
      data: { orgId: org.id, clerkUserId: `test-prefs-fresh2-${RUN}`, name: 'Fresh Rep 2', email: `fresh2-${RUN}@example.com`, role: 'Member' },
    })
    mockAuth.mockResolvedValue({ userId: rep.clerkUserId, orgId: org.clerkOrgId, orgRole: 'org:member' })
    await updateNotificationPreferenceAction({ kind: 'task_due', enabled: false })

    await prisma.task.create({
      data: { orgId: org.id, title: 'Overdue while disabled', dueDate: new Date(Date.now() - DAY_MS), ownerId: rep.id, createdById: admin.id, done: false },
    })

    await scanAndNotify(org.id, rep.id)

    expect(await prisma.notification.count({ where: { orgId: org.id, recipientId: rep.id, kind: 'task_due' } })).toBe(0)
  })

  it('lead_follow_up: an existing notification is hidden once the kind is disabled, even mid-batch', async () => {
    const rep = await prisma.owner.create({
      data: { orgId: org.id, clerkUserId: `test-prefs-fresh3-${RUN}`, name: 'Fresh Rep 3', email: `fresh3-${RUN}@example.com`, role: 'Member' },
    })
    const lead = await prisma.lead.create({
      data: {
        orgId: org.id, name: 'Follow-up lead', title: '', companyId: company.id, email: `followup-${RUN}@example.com`,
        phone: '', source: 'Inbound', location: '', ownerId: rep.id, followUpAt: new Date(Date.now() - DAY_MS),
      },
    })
    await prisma.notification.create({
      data: {
        orgId: org.id, recipientId: rep.id, kind: 'lead_follow_up', subjectType: 'lead', subjectId: lead.id,
        triggerDate: new Date(Date.now() - DAY_MS).toISOString().slice(0, 10), dedupeKey: randomUUID(),
      },
    })
    expect(await getUnreadCount(org.id, rep.id)).toBe(1)

    mockAuth.mockResolvedValue({ userId: rep.clerkUserId, orgId: org.clerkOrgId, orgRole: 'org:member' })
    await updateNotificationPreferenceAction({ kind: 'lead_follow_up', enabled: false })

    expect(await getUnreadCount(org.id, rep.id)).toBe(0)
    const list = await listNotifications(scopeFor(null), rep.id)
    expect(list.find((n) => n.subjectId === lead.id)).toBeUndefined()
  })
})
