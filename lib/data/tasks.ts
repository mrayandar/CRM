// Server-only data access. Do not import this module from a Client
// Component — it pulls in `@prisma/client`, which only runs in Node.
//
// Every function requires `orgId` as its first argument and includes it in
// every `where` clause. Never call these with an id alone — that would let
// a client that guessed/enumerated an id read across tenants.
import type { Prisma, Priority, TaskType } from '@prisma/client'
import { prisma } from '@lib/prisma'

export interface ListTasksOptions {
  ownerId?: string
  done?: boolean
}

export function listTasks(orgId: string, options: ListTasksOptions = {}) {
  const { ownerId, done } = options

  return prisma.task.findMany({
    where: {
      orgId,
      ...(ownerId && { ownerId }),
      ...(done !== undefined && { done }),
    },
    include: { owner: true },
    orderBy: { dueDate: 'asc' },
  })
}

export function getTaskById(orgId: string, id: string) {
  return prisma.task.findFirst({
    where: { id, orgId },
    include: { owner: true },
  })
}

export function createTask(
  orgId: string,
  data: Omit<Prisma.TaskCreateInput, 'orgId'>,
) {
  return prisma.task.create({ data: { ...data, orgId } })
}

export async function toggleTaskDone(orgId: string, id: string, done: boolean) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.task.findFirst({ where: { id, orgId } })
    if (!existing) throw new Error(`Task ${id} not found in org ${orgId}`)
    return tx.task.update({ where: { id }, data: { done } })
  })
}

export interface UpdateTaskInput {
  title: string
  description: string | null
  dueDate: Date
  priority: Priority
  type: TaskType
  ownerId: string
}

/**
 * Updates the task's own editable fields, and logs an "edited" activity with a short summary of
 * which fields actually changed — all in one transaction, so a failed write can never leave an
 * orphan activity. A no-op save (nothing actually differs) skips the write and the activity
 * entirely. Mirrors updateLead/updateContact/updateDeal.
 *
 * The activity's subject is the task's own `relatedTo` (lead/contact/deal), not the task itself —
 * Activity has no "task" subject type or `taskId` column, so there's nothing else to attach it
 * to. A standalone task with no `relatedTo` still gets the activity row (for the global "Recent
 * activity" feed), it just won't show up on any specific record's timeline.
 */
export async function updateTask(orgId: string, id: string, data: UpdateTaskInput, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.task.findFirst({ where: { id, orgId } })
    if (!existing) throw new Error(`Task ${id} not found in org ${orgId}`)

    const changed: string[] = []
    if (existing.title !== data.title) changed.push('title')
    if ((existing.description ?? '') !== (data.description ?? '')) changed.push('description')
    if (+existing.dueDate !== +data.dueDate) changed.push('due date')
    if (existing.priority !== data.priority) changed.push('priority')
    if (existing.type !== data.type) changed.push('type')
    if (existing.ownerId !== data.ownerId) changed.push('assignee')

    if (changed.length === 0) return existing

    const updated = await tx.task.update({
      where: { id },
      data: {
        title: data.title,
        description: data.description,
        dueDate: data.dueDate,
        priority: data.priority,
        type: data.type,
        ownerId: data.ownerId,
      },
    })

    await tx.activity.create({
      data: {
        orgId,
        kind: 'edited',
        title: `edited ${updated.title}`,
        body: `Changed: ${changed.join(', ')}`,
        actorId,
        ...(existing.relatedToType && {
          subjectType: existing.relatedToType,
          subjectLabel: existing.relatedToLabel,
          leadId: existing.leadId,
          contactId: existing.contactId,
          dealId: existing.dealId,
        }),
      },
    })

    return updated
  })
}

/**
 * Deletes a task outright — no activity logged. Unlike a lead/contact/deal edit or a stage
 * change, removing a to-do isn't a business event worth a permanent audit entry (and Activity
 * has no "task" subject type to attach one to anyway); it's routine list cleanup.
 */
export async function deleteTask(orgId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.task.findFirst({ where: { id, orgId } })
    if (!existing) throw new Error(`Task ${id} not found in org ${orgId}`)
    await tx.task.delete({ where: { id } })
    return existing
  })
}
