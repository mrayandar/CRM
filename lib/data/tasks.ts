// Server-only data access. Do not import this module from a Client
// Component — it pulls in `@prisma/client`, which only runs in Node.
import type { Prisma } from '@prisma/client'
import { prisma } from '@lib/prisma'

export interface ListTasksOptions {
  ownerId?: string
  done?: boolean
}

export function listTasks(options: ListTasksOptions = {}) {
  const { ownerId, done } = options

  return prisma.task.findMany({
    where: {
      ...(ownerId && { ownerId }),
      ...(done !== undefined && { done }),
    },
    include: { owner: true },
    orderBy: { dueDate: 'asc' },
  })
}

export function createTask(data: Prisma.TaskCreateInput) {
  return prisma.task.create({ data })
}

export function toggleTaskDone(id: string, done: boolean) {
  return prisma.task.update({ where: { id }, data: { done } })
}
