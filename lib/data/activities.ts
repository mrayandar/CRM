// Server-only data access. Do not import this module from a Client
// Component — it pulls in `@prisma/client`, which only runs in Node.
//
// Every function requires `orgId` as its first argument and includes it in
// every `where` clause. Never call these with an id alone — that would let
// a client that guessed/enumerated an id read across tenants.
import type { Prisma } from '@prisma/client'
import { prisma } from '@lib/prisma'

export interface ListActivitiesOptions {
  leadId?: string
  contactId?: string
  dealId?: string
  limit?: number
}

/** Powers both the dashboard's recent-activity feed and a record's timeline tab. */
export function listActivities(
  orgId: string,
  options: ListActivitiesOptions = {},
) {
  const { leadId, contactId, dealId, limit = 50 } = options

  return prisma.activity.findMany({
    where: {
      orgId,
      ...(leadId && { leadId }),
      ...(contactId && { contactId }),
      ...(dealId && { dealId }),
    },
    include: { actor: true },
    orderBy: { at: 'desc' },
    take: limit,
  })
}

export function logActivity(
  orgId: string,
  data: Omit<Prisma.ActivityCreateInput, 'orgId'>,
) {
  return prisma.activity.create({ data: { ...data, orgId } })
}
