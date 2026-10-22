// Server-only data access. Do not import this module from a Client
// Component — it pulls in `@prisma/client`, which only runs in Node.
//
// Every function requires `orgId` as its first argument and includes it in
// every `where` clause. Never call these with an id alone — that would let
// a client that guessed/enumerated an id read across tenants.
import type { ActivityKind, Prisma } from '@prisma/client'
import { prisma } from '@lib/prisma'

export interface ListActivitiesOptions {
  leadId?: string
  contactId?: string
  dealId?: string
  limit?: number
  /** Excludes these kinds entirely — used by the data loader to keep 'payment' activities out of
   *  a non-privileged caller's feed. Not a UI filter: this is the one place that enforcement
   *  happens, so nothing downstream (dashboard feed, deal timeline) ever receives them to begin
   *  with. See requirePaymentAccess in lib/auth.ts. */
  excludeKinds?: ActivityKind[]
}

/** Powers the dashboard's recent-activity feed (org-wide, capped at `limit`) — NOT a record's
 *  timeline tab. That used to filter this function's capped, org-wide result down to one
 *  record's own subject, which meant any record whose activity wasn't among the org's `limit`
 *  most recent *overall* silently showed an incomplete or empty timeline once an org had more
 *  activity than `limit`. See `listActivitiesForSubject` below — a record's own, properly
 *  paginated query — for that case now. */
export function listActivities(
  orgId: string,
  options: ListActivitiesOptions = {},
) {
  const { leadId, contactId, dealId, limit = 50, excludeKinds } = options

  return prisma.activity.findMany({
    where: {
      orgId,
      ...(leadId && { leadId }),
      ...(contactId && { contactId }),
      ...(dealId && { dealId }),
      ...(excludeKinds && excludeKinds.length > 0 && { kind: { notIn: excludeKinds } }),
    },
    include: { actor: true },
    orderBy: { at: 'desc' },
    take: limit,
  })
}

export interface ListActivitiesForSubjectOptions {
  /** Id of the last activity on the previous page — omit for the first page. */
  cursor?: string
  /** Rows per page. Default 30. */
  take?: number
  /** Excludes these kinds entirely — same enforcement point as `listActivities`'s option of the
   *  same name: a non-privileged caller's page never receives a payment-kind row to begin with. */
  excludeKinds?: ActivityKind[]
}

/** One record's own activity history, newest first, real cursor pagination — unlike
 *  `listActivities`, this has no cap: every page is reachable, however much history exists.
 *  Powers GET /api/activities (RecordDetail's Activity and Notes tabs). The caller is
 *  responsible for checking the subject itself belongs to this org before calling this — this
 *  function only filters by the subject id, same as every other data-layer function here. */
export async function listActivitiesForSubject(
  orgId: string,
  subject: { type: 'lead' | 'contact' | 'deal'; id: string },
  options: ListActivitiesForSubjectOptions = {},
): Promise<{ rows: Awaited<ReturnType<typeof prisma.activity.findMany>>; nextCursor: string | null }> {
  const { cursor, take = 30, excludeKinds } = options
  const subjectWhere =
    subject.type === 'lead'
      ? { leadId: subject.id }
      : subject.type === 'contact'
        ? { contactId: subject.id }
        : { dealId: subject.id }

  const rows = await prisma.activity.findMany({
    where: {
      orgId,
      ...subjectWhere,
      ...(excludeKinds && excludeKinds.length > 0 && { kind: { notIn: excludeKinds } }),
    },
    orderBy: { at: 'desc' },
    take: take + 1,
    ...(cursor && { cursor: { id: cursor }, skip: 1 }),
  })

  const hasMore = rows.length > take
  const page = hasMore ? rows.slice(0, take) : rows
  return { rows: page, nextCursor: hasMore ? page[page.length - 1]!.id : null }
}

/**
 * Records an activity and, in the same transaction, moves the parent record's "last activity"
 * timestamp (Lead.lastTouchedAt / Contact.lastInteractionAt) to the activity's time. Without this
 * the UI's optimistic bump is lost on reload. The updates are filtered by `orgId` so an id from
 * another tenant can never be touched.
 */
export function logActivity(
  orgId: string,
  data: Omit<Prisma.ActivityCreateInput, 'orgId'>,
) {
  return prisma.$transaction(async (tx) => {
    const activity = await tx.activity.create({ data: { ...data, orgId } })
    if (activity.leadId) {
      await tx.lead.updateMany({
        where: { id: activity.leadId, orgId },
        data: { lastTouchedAt: activity.at },
      })
    }
    if (activity.contactId) {
      await tx.contact.updateMany({
        where: { id: activity.contactId, orgId },
        data: { lastInteractionAt: activity.at },
      })
    }
    return activity
  })
}
