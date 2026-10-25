/**
 * Task creation from the Calendar screen reuses addTaskAction unchanged — the same assignee
 * rules (active owners only, default to the caller), the same server-side Scope/org checks, and
 * the same "assigned" notification when the assignee isn't the actor. There is no second create
 * path: Calendar.tsx and Tasks.tsx both render the one shared NewTaskModal (src/components/
 * common/NewTaskModal.tsx), which calls the one `addTask` -> `addTaskAction`. This file proves
 * that shared path's own behavior directly (what a calendar-origin create actually goes through)
 * and pins the "no second form" structural fact the design relies on.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@clerk/nextjs/server', () => ({ auth: () => mockAuth(), clerkClient: () => ({}) }))

import { prisma } from '@lib/prisma'
import * as actions from '@lib/actions/crm'

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

let org: Awaited<ReturnType<typeof prisma.organization.create>>
let repA: Awaited<ReturnType<typeof prisma.owner.create>>
let repB: Awaited<ReturnType<typeof prisma.owner.create>>
let inactiveRep: Awaited<ReturnType<typeof prisma.owner.create>>

beforeAll(async () => {
  org = await prisma.organization.create({
    data: { clerkOrgId: `test-caltask-org-${RUN}`, name: 'Calendar-task test org', repVisibility: 'OWN' },
  })
  repA = await prisma.owner.create({
    data: { orgId: org.id, clerkUserId: `test-caltask-repA-${RUN}`, name: 'Rep A', email: `rep-a-${RUN}@example.com`, role: 'Member' },
  })
  repB = await prisma.owner.create({
    data: { orgId: org.id, clerkUserId: `test-caltask-repB-${RUN}`, name: 'Rep B', email: `rep-b-${RUN}@example.com`, role: 'Member' },
  })
  inactiveRep = await prisma.owner.create({
    data: { orgId: org.id, clerkUserId: `test-caltask-inactive-${RUN}`, name: 'Inactive Rep', email: `rep-inactive-${RUN}@example.com`, role: 'Member', active: false },
  })
})

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { orgId: org.id } })
  await prisma.task.deleteMany({ where: { orgId: org.id } })
  await prisma.owner.deleteMany({ where: { orgId: org.id } })
  await prisma.organization.delete({ where: { id: org.id } })
  await prisma.$disconnect()
})

afterEach(() => mockAuth.mockReset())

function loginAsRepA() {
  mockAuth.mockResolvedValue({ userId: repA.clerkUserId, orgId: org.clerkOrgId, orgRole: 'org:member' })
}

describe('Calendar and Tasks share one "New task" form — no second path exists', () => {
  it('both screens import NewTaskModal from the same shared module', () => {
    const repoRoot = resolve(__dirname, '../..')
    const calendarSrc = readFileSync(resolve(repoRoot, 'src/screens/Calendar.tsx'), 'utf8')
    const tasksSrc = readFileSync(resolve(repoRoot, 'src/screens/Tasks.tsx'), 'utf8')
    const importLine = "import { NewTaskModal } from '@/components/common/NewTaskModal'"
    expect(calendarSrc).toContain(importLine)
    expect(tasksSrc).toContain(importLine)
    // Neither screen defines its own local "NewTaskModal" function anymore.
    expect(calendarSrc).not.toMatch(/function NewTaskModal/)
    expect(tasksSrc).not.toMatch(/function NewTaskModal/)
  })
})

describe('addTaskAction (the shared create path): OWN mode, self and teammate assignment', () => {
  it('a Member can create a task assigned to themselves', async () => {
    loginAsRepA()
    const id = randomUUID()
    await actions.addTaskAction({
      id, title: 'Self-assigned task', dueDate: new Date('2026-11-05T12:00:00.000Z').toISOString(),
      priority: 'medium', ownerId: repA.id,
    })
    const task = await prisma.task.findUnique({ where: { id } })
    expect(task?.ownerId).toBe(repA.id)
    expect(task?.createdById).toBe(repA.id)
    // Self-assignment never notifies.
    expect(await prisma.notification.count({ where: { orgId: org.id, recipientId: repA.id, subjectId: id } })).toBe(0)
  })

  it('a Member can create a task assigned to a teammate, who gets exactly one notification', async () => {
    loginAsRepA()
    const id = randomUUID()
    await actions.addTaskAction({
      id, title: 'Assigned to repB', dueDate: new Date('2026-11-06T12:00:00.000Z').toISOString(),
      priority: 'medium', ownerId: repB.id,
    })
    const task = await prisma.task.findUnique({ where: { id } })
    expect(task?.ownerId).toBe(repB.id)
    expect(task?.createdById).toBe(repA.id)

    const notifications = await prisma.notification.findMany({
      where: { orgId: org.id, recipientId: repB.id, subjectType: 'task', subjectId: id },
    })
    expect(notifications.length).toBe(1)
    expect(notifications[0].kind).toBe('assigned')
  })

  it('rejects an inactive assignee', async () => {
    loginAsRepA()
    await expect(
      actions.addTaskAction({
        id: randomUUID(), title: 'Should fail', dueDate: new Date('2026-11-07T12:00:00.000Z').toISOString(),
        priority: 'medium', ownerId: inactiveRep.id,
      }),
    ).rejects.toThrow()
  })
})
