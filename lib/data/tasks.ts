// Server-only data access. Do not import this module from a Client
// Component — it pulls in `@prisma/client`, which only runs in Node.
//
// Every function takes a `Scope` (orgId + the caller's scopeOwnerId) as its first argument and
// includes both in every `where` clause. Never call these with a bare orgId or an id alone —
// that would let a client read or write across tenants, or across reps within the same org.
import type { Prisma, Priority, TaskType } from '@prisma/client'
import { prisma } from '@lib/prisma'
import type { Scope } from '@lib/scope'

export interface ListTasksOptions {
  /** A free filter, meaningful only when `scope.scopeOwnerId` is null — see ListLeadsOptions'
   *  identical field in lib/data/leads.ts for why this is ignored once the caller is scoped. */
  ownerId?: string
  done?: boolean
}

/** A task is visible to a scoped Member if they're its assignee OR its creator — distinct from
 *  every other list in this app, which gates on `ownerId` alone. A rep who created a task and
 *  handed it to someone else should still see it (same reasoning Task.createdById's own schema
 *  comment gives), and the reverse (assigned to them, created by someone else) is the ordinary
 *  case. */
function taskVisibilityWhere(scopeOwnerId: string): Prisma.TaskWhereInput {
  return { OR: [{ ownerId: scopeOwnerId }, { createdById: scopeOwnerId }] }
}

/** Nulls out a task's `relatedTo` fields when the parent lead/contact/deal's current owner isn't
 *  the scoped caller — the task itself passed its own (assignee-or-creator) visibility check, but
 *  that doesn't mean the caller may see which record it's attached to. Unscoped (Admin/ALL-mode)
 *  callers never redact: `parentOwnerId` is only meaningful once the caller is scoped. */
function redactOutOfScopeParent<
  T extends {
    relatedToType: string | null
    relatedToLabel: string | null
    leadId: string | null
    contactId: string | null
    dealId: string | null
    lead?: { ownerId: string } | null
    contact?: { ownerId: string } | null
    deal?: { ownerId: string } | null
  },
>(task: T, scopeOwnerId: string | null): T {
  if (!scopeOwnerId) return task
  const parentOwnerId = task.lead?.ownerId ?? task.contact?.ownerId ?? task.deal?.ownerId ?? null
  if (!parentOwnerId || parentOwnerId === scopeOwnerId) return task
  return {
    ...task,
    relatedToType: null,
    relatedToLabel: null,
    leadId: null,
    contactId: null,
    dealId: null,
    lead: null,
    contact: null,
    deal: null,
  }
}

const PARENT_OWNER_INCLUDE = {
  lead: { select: { ownerId: true } },
  contact: { select: { ownerId: true } },
  deal: { select: { ownerId: true } },
} as const

export async function listTasks(scope: Scope, options: ListTasksOptions = {}) {
  const { ownerId, done } = options

  const rows = await prisma.task.findMany({
    where: {
      orgId: scope.orgId,
      ...(scope.scopeOwnerId
        ? taskVisibilityWhere(scope.scopeOwnerId)
        : ownerId
          ? { ownerId }
          : {}),
      ...(done !== undefined && { done }),
    },
    include: { owner: true, ...PARENT_OWNER_INCLUDE },
    orderBy: { dueDate: 'asc' },
  })

  return rows.map((row) => redactOutOfScopeParent(row, scope.scopeOwnerId))
}

export async function getTaskById(scope: Scope, id: string) {
  const row = await prisma.task.findFirst({
    where: {
      id,
      orgId: scope.orgId,
      ...(scope.scopeOwnerId && taskVisibilityWhere(scope.scopeOwnerId)),
    },
    include: { owner: true, ...PARENT_OWNER_INCLUDE },
  })
  if (!row) return null
  return redactOutOfScopeParent(row, scope.scopeOwnerId)
}

/** Creation has nothing yet to scope a read against — `scope.scopeOwnerId` isn't used here. The
 *  caller (addTaskAction) is responsible for passing `createdById` (the actor creating the task)
 *  in `data`, and for enforcing any ownership rule on the assignee — task assignment itself is
 *  unrestricted even for a scoped Member (see addTaskAction). */
export function createTask(scope: Scope, data: Omit<Prisma.TaskCreateInput, 'orgId'>) {
  return prisma.task.create({ data: { ...data, orgId: scope.orgId } })
}

export async function toggleTaskDone(scope: Scope, id: string, done: boolean) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.task.findFirst({
      where: {
        id,
        orgId: scope.orgId,
        ...(scope.scopeOwnerId && taskVisibilityWhere(scope.scopeOwnerId)),
      },
    })
    if (!existing) throw new Error(`Task ${id} not found in org ${scope.orgId}`)
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
 *
 * When the task has a `relatedTo` subject, the activity (and its ownerId) is only written when
 * that subject's *current* owner is within the caller's scope — a scoped Member who's a task's
 * assignee-or-creator can still edit the task itself (the visibility check above already allows
 * that), but shouldn't be the one writing an audit entry onto a parent record they don't own. The
 * task's own fields are updated either way; only the attached-activity write is skipped.
 */
export async function updateTask(
  scope: Scope,
  id: string,
  data: UpdateTaskInput,
  actorId: string,
  /** Client-generated id for the "edited" activity, when the task has a `relatedTo` subject (the
   *  only case the client has a matching local optimistic row for — see updateLead's identical
   *  param). Omitted for a standalone task; the server still logs the activity either way, just
   *  under its own generated id, since there's no optimistic row on the client to reconcile with. */
  activityId?: string,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.task.findFirst({
      where: {
        id,
        orgId: scope.orgId,
        ...(scope.scopeOwnerId && taskVisibilityWhere(scope.scopeOwnerId)),
      },
    })
    if (!existing) throw new Error(`Task ${id} not found in org ${scope.orgId}`)

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

    let parentOwnerId: string | null = null
    if (existing.relatedToType) {
      const parent = existing.leadId
        ? await tx.lead.findUnique({ where: { id: existing.leadId }, select: { ownerId: true } })
        : existing.contactId
          ? await tx.contact.findUnique({ where: { id: existing.contactId }, select: { ownerId: true } })
          : await tx.deal.findUnique({ where: { id: existing.dealId! }, select: { ownerId: true } })
      parentOwnerId = parent?.ownerId ?? null
    }
    const parentInScope = !scope.scopeOwnerId || !existing.relatedToType || parentOwnerId === scope.scopeOwnerId

    if (parentInScope) {
      await tx.activity.create({
        data: {
          id: activityId,
          orgId: scope.orgId,
          kind: 'edited',
          title: `edited ${updated.title}`,
          body: `Changed: ${changed.join(', ')}`,
          actorId,
          ownerId: existing.relatedToType ? parentOwnerId : actorId,
          ...(existing.relatedToType && {
            subjectType: existing.relatedToType,
            subjectLabel: existing.relatedToLabel,
            leadId: existing.leadId,
            contactId: existing.contactId,
            dealId: existing.dealId,
          }),
        },
      })
    }

    return updated
  })
}

/**
 * Deletes a task outright — no activity logged. Unlike a lead/contact/deal edit or a stage
 * change, removing a to-do isn't a business event worth a permanent audit entry (and Activity
 * has no "task" subject type to attach one to anyway); it's routine list cleanup.
 */
export async function deleteTask(scope: Scope, id: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.task.findFirst({
      where: {
        id,
        orgId: scope.orgId,
        ...(scope.scopeOwnerId && taskVisibilityWhere(scope.scopeOwnerId)),
      },
    })
    if (!existing) throw new Error(`Task ${id} not found in org ${scope.orgId}`)
    await tx.task.delete({ where: { id } })
    return existing
  })
}
