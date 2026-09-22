// Server-only data access. Do not import this module from a Client
// Component — it pulls in `@prisma/client`, which only runs in Node.
//
// Every function requires `orgId` as its first argument and includes it in
// every `where` clause. Never call these with an id alone — that would let
// a client that guessed/enumerated an id read across tenants.
import type { Prisma } from '@prisma/client'
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
