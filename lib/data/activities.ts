// Server-only data access. Do not import this module from a Client
// Component — it pulls in `@prisma/client`, which only runs in Node.
import type { Prisma } from '@prisma/client'
import { prisma } from '@lib/prisma'

export interface ListActivitiesOptions {
  leadId?: string
  contactId?: string
  dealId?: string
  limit?: number
}

/** Powers both the dashboard's recent-activity feed and a record's timeline tab. */
export function listActivities(options: ListActivitiesOptions = {}) {
  const { leadId, contactId, dealId, limit = 50 } = options

  return prisma.activity.findMany({
    where: {
      ...(leadId && { leadId }),
      ...(contactId && { contactId }),
      ...(dealId && { dealId }),
    },
    include: { actor: true },
    orderBy: { at: 'desc' },
    take: limit,
  })
}

export function logActivity(data: Prisma.ActivityCreateInput) {
  return prisma.activity.create({ data })
}
