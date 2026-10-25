// Server-only data access. Do not import this module from a Client
// Component — it pulls in `@prisma/client`, which only runs in Node.
//
// Every function takes a `Scope` (orgId + the caller's scopeOwnerId) as its first argument and
// includes both in every `where` clause. Never call these with a bare orgId or an id alone —
// that would let a client read or write across tenants, or across reps within the same org.
import type { ActivityKind, Prisma } from '@prisma/client'
import { prisma, withTransaction } from '@lib/prisma'
import type { Scope } from '@lib/scope'

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
 *  paginated query — for that case now. When `scope.scopeOwnerId` is set, filters by the
 *  denormalized `Activity.ownerId` — a scoped Member's feed only ever contains activity on
 *  records they currently own, same rule as every list in this app. */
export function listActivities(scope: Scope, options: ListActivitiesOptions = {}) {
  const { leadId, contactId, dealId, limit = 50, excludeKinds } = options

  return prisma.activity.findMany({
    where: {
      orgId: scope.orgId,
      ...(scope.scopeOwnerId && { ownerId: scope.scopeOwnerId }),
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
 *  responsible for checking the subject itself belongs to the caller's scope before calling
 *  this (the scoped by-id read on the subject) — once that's confirmed, every activity attached
 *  to it already shares the subject's current owner (Activity.ownerId is cascaded on every
 *  reassignment), so no separate ownerId filter is needed here. */
export async function listActivitiesForSubject(
  scope: Scope,
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
      orgId: scope.orgId,
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
 * Feeds the AI-assist prompt builders (lib/ai/promptBuilder.ts's buildTimelineSummaryPrompt /
 * buildNextStepPrompt), which need `actor.name` to label each timeline entry — unlike
 * `listActivitiesForSubject`, which never includes the actor relation (its own callers resolve
 * that from the already-loaded owners list client-side). Payment-kind rows are excluded
 * unconditionally here, not via an `excludeKinds` option the caller could forget to pass: the
 * prompt builders filter them again themselves (see their own doc comments), so this is
 * belt-and-suspenders, not the only place that enforcement happens. The caller is responsible for
 * the scoped by-id read on the subject first, same as `listActivitiesForSubject`.
 */
export async function listActivitiesForAiPrompt(scope: Scope, subject: { type: 'lead' | 'contact'; id: string }) {
  const subjectWhere = subject.type === 'lead' ? { leadId: subject.id } : { contactId: subject.id }
  return prisma.activity.findMany({
    where: { orgId: scope.orgId, ...subjectWhere, kind: { not: 'payment' } },
    include: { actor: true },
    orderBy: { at: 'desc' },
    take: 20,
  })
}

/**
 * Records an activity and, in the same transaction, moves the parent record's "last activity"
 * timestamp (Lead.lastTouchedAt / Contact.lastInteractionAt) to the activity's time. Without this
 * the UI's optimistic bump is lost on reload. The updates are filtered by `orgId` so an id from
 * another tenant can never be touched.
 *
 * `data` must already include `ownerId` — the subject's current owner, or the actor for a
 * standalone activity with no subject (see each call site: whoever already fetched/validated the
 * subject already knows its current ownerId, so this never re-queries for it).
 */
export function logActivity(scope: Scope, data: Omit<Prisma.ActivityCreateInput, 'orgId'>) {
  return withTransaction(async (tx) => {
    const activity = await tx.activity.create({ data: { ...data, orgId: scope.orgId } })
    if (activity.leadId) {
      await tx.lead.updateMany({
        where: { id: activity.leadId, orgId: scope.orgId },
        data: { lastTouchedAt: activity.at },
      })
    }
    if (activity.contactId) {
      await tx.contact.updateMany({
        where: { id: activity.contactId, orgId: scope.orgId },
        data: { lastInteractionAt: activity.at },
      })
    }
    return activity
  })
}

/** Bulk-updates every Activity attached to one subject to a new ownerId — the reassignment
 *  cascade every updateLead/updateContact/updateDeal (and the lead-conversion owner move) runs in
 *  the same transaction as the ownerId change itself, so Activity.ownerId never drifts from the
 *  subject's real current owner. Takes a transaction client (`tx`), not `prisma` directly — it's
 *  always called from inside another function's own `$transaction`, never standalone. */
export function cascadeActivityOwner(
  tx: Prisma.TransactionClient,
  subjectField: 'leadId' | 'contactId' | 'dealId',
  subjectId: string,
  newOwnerId: string,
) {
  return tx.activity.updateMany({
    where: { [subjectField]: subjectId },
    data: { ownerId: newOwnerId },
  })
}
