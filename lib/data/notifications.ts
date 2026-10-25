// Server-only data access. Every function takes orgId + recipientId explicitly and filters by
// both — never a bare recipientId, which would let one owner read or mark another's
// notifications (see tests/integration/notifications.test.ts).
import { prisma, withTransaction } from '@lib/prisma'
import type { Scope } from '@lib/scope'
import type { Prisma, SubjectType } from '@prisma/client'

// ---------------------------------------------------------------------------
// Writing (assigned kind only, in this stage)
// ---------------------------------------------------------------------------

/**
 * Writes an 'assigned' notification for one subject, inside the caller's own transaction `tx` —
 * never a standalone write, so it can never land without the mutation that caused it (or survive
 * a mutation that itself got rolled back). Self-contained: every call site just calls this and
 * moves on, never branching on "should I even call this" —
 *   - never notifies when `recipientId === actorId` (assigning something to yourself)
 *   - never notifies an inactive recipient (Owner.active === false)
 *   - a dedupe-key collision (the only case being the batch-scoped import summary retried) is
 *     swallowed as a safe no-op; any other error propagates — never silently loses a write.
 *
 * `dedupeKey` is the caller's choice, by design — see the schema's own doc comment on
 * Notification.dedupeKey for why a plain per-event assignment and a batch-scoped import summary
 * need different keys.
 */
export async function writeAssignedNotification(
  tx: Prisma.TransactionClient,
  input: {
    orgId: string
    recipientId: string
    actorId: string
    subjectType: SubjectType
    subjectId: string
    dedupeKey: string
  },
): Promise<void> {
  if (input.recipientId === input.actorId) return
  const recipient = await tx.owner.findFirst({ where: { id: input.recipientId, orgId: input.orgId, active: true } })
  if (!recipient) return
  try {
    await tx.notification.create({
      data: {
        orgId: input.orgId,
        recipientId: input.recipientId,
        kind: 'assigned',
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        dedupeKey: input.dedupeKey,
      },
    })
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as { code?: string }).code === 'P2002') return
    throw err
  }
}

/**
 * The coalesced form — "N leads assigned to you" — for a bulk reassign or an import batch
 * summary. Same self-assignment/active-recipient/dedupe-collision handling as
 * `writeAssignedNotification`; no `subjectId` (there is no single subject), `count` instead.
 * `subjectType` is still recorded (lead/contact) purely to pick the right noun at read time — see
 * `buildTitle` — never to look up an individual record.
 */
export async function writeCoalescedAssignedNotification(
  tx: Prisma.TransactionClient,
  input: {
    orgId: string
    recipientId: string
    actorId: string
    subjectType: SubjectType
    count: number
    dedupeKey: string
  },
): Promise<void> {
  if (input.count <= 0) return
  if (input.recipientId === input.actorId) return
  const recipient = await tx.owner.findFirst({ where: { id: input.recipientId, orgId: input.orgId, active: true } })
  if (!recipient) return
  try {
    await tx.notification.create({
      data: {
        orgId: input.orgId,
        recipientId: input.recipientId,
        kind: 'assigned',
        subjectType: input.subjectType,
        count: input.count,
        dedupeKey: input.dedupeKey,
      },
    })
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as { code?: string }).code === 'P2002') return
    throw err
  }
}

/**
 * Retracts a now-stale 'assigned' notification about one subject from its FORMER owner — called
 * from inside the same transaction as a reassignment, right alongside `cascadeActivityOwner`.
 * This is what keeps the former owner's list/unread-count correct WITHOUT needing to re-validate
 * every notification against its live subject on every read (see this file's own module-level
 * doc comment on why 'assigned' doesn't need that: the recipient only ever stops being valid for
 * an assignment via exactly this one event — a reassignment away — so retracting it here, once,
 * at the moment it happens, is the complete mechanism). Removes both read and unread rows: a
 * notification about a record you no longer own has nothing left to say.
 */
export function retractAssignedNotifications(
  tx: Prisma.TransactionClient,
  input: { orgId: string; formerRecipientId: string; subjectType: SubjectType; subjectId: string },
) {
  return tx.notification.deleteMany({
    where: {
      orgId: input.orgId,
      recipientId: input.formerRecipientId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
    },
  })
}

/**
 * Deletes EVERY notification about one subject, regardless of recipient — for when the subject
 * itself is gone (e.g. a deleted task), not just reassigned away from one recipient. Unlike
 * `retractAssignedNotifications` (scoped to a single former recipient, used on reassignment),
 * this has no FK to rely on: `Notification.subjectId` is a soft polymorphic reference (it can
 * point at a Lead, Contact, Deal, or Task row), never an enforced foreign key, so nothing deletes
 * these automatically when the subject row itself is deleted — the caller must do it explicitly,
 * in the same transaction as the delete (see `deleteTask` in lib/data/tasks.ts).
 */
export function retractNotificationsForSubject(
  tx: Prisma.TransactionClient,
  input: { orgId: string; subjectType: SubjectType; subjectId: string },
) {
  return tx.notification.deleteMany({
    where: { orgId: input.orgId, subjectType: input.subjectType, subjectId: input.subjectId },
  })
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Polled every ~60s from the bell — a single indexed COUNT, deliberately as cheap as possible.
 *  See `retractAssignedNotifications` for why this never needs to re-validate rows against their
 *  live subject: a stale row for this recipient was already deleted at the moment it went stale. */
export function getUnreadCount(orgId: string, recipientId: string): Promise<number> {
  return prisma.notification.count({ where: { orgId, recipientId, readAt: null } })
}

export interface NotificationListItem {
  id: string
  title: string
  createdAt: string
  readAt: string | null
  subjectType: SubjectType | null
  subjectId: string | null
}

const SUBJECT_LABEL: Record<SubjectType, string> = { lead: 'Lead', contact: 'Contact', deal: 'Deal', task: 'Task' }

/** One scoped findMany per subject type present in the current page of rows — bounded at 4
 *  queries total (lead/contact/deal/task), regardless of how many of the up-to-50 rows need a
 *  title. Replaces the earlier one-query-per-row approach (up to 50 extra queries for a full
 *  page), which showed up as a real N+1 — see tests/integration/notifications.test.ts's query-
 *  count check. Each query is scoped by `scope.scopeOwnerId` exactly like the single-id
 *  `getLeadById`/etc. it replaces, so an OWN-mode Member still never gets a title built from a
 *  subject outside their own reach. Only `id`/`name` (or `title` for a task) is selected — title-
 *  building never needs the full record. */
async function fetchSubjectNamesByType(
  scope: Scope,
  subjectType: SubjectType,
  ids: string[],
): Promise<Map<string, string>> {
  const scopeWhere = scope.scopeOwnerId ? { ownerId: scope.scopeOwnerId } : {}
  const where = { id: { in: ids }, orgId: scope.orgId, ...scopeWhere }

  const rows =
    subjectType === 'lead'
      ? await prisma.lead.findMany({ where, select: { id: true, name: true } })
      : subjectType === 'contact'
        ? await prisma.contact.findMany({ where, select: { id: true, name: true } })
        : subjectType === 'deal'
          ? await prisma.deal.findMany({ where, select: { id: true, name: true } })
          : await prisma.task.findMany({ where, select: { id: true, title: true } })

  const map = new Map<string, string>()
  for (const row of rows) map.set(row.id, 'name' in row ? row.name : row.title)
  return map
}

/** Newest 50, titles built at read time from a batched lookup (see `fetchSubjectNamesByType`) —
 *  never from anything stored on the Notification row itself. A row whose subject is gone, or
 *  outside `scope`'s reach, or (for a coalesced row) has `count` set, is handled without a lookup
 *  miss showing a broken title: the former two are simply dropped (the batched map has no entry
 *  for them), the latter never needs the map at all. `scope` must be the RECIPIENT's own — the
 *  caller (the route handler) already has it from its own `requireAuth()`, since this is always
 *  "list my own notifications," never anyone else's. */
export async function listNotifications(scope: Scope, recipientId: string): Promise<NotificationListItem[]> {
  const rows = await prisma.notification.findMany({
    where: { orgId: scope.orgId, recipientId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  const idsByType = new Map<SubjectType, string[]>()
  for (const row of rows) {
    if (row.count !== null || !row.subjectType || !row.subjectId) continue
    const existing = idsByType.get(row.subjectType)
    if (existing) existing.push(row.subjectId)
    else idsByType.set(row.subjectType, [row.subjectId])
  }

  const namesByType = new Map<SubjectType, Map<string, string>>(
    await Promise.all(
      [...idsByType.entries()].map(
        async ([subjectType, ids]) => [subjectType, await fetchSubjectNamesByType(scope, subjectType, ids)] as const,
      ),
    ),
  )

  const withTitles = rows.map((row) => {
    if (row.count !== null) {
      const noun = row.subjectType ? SUBJECT_LABEL[row.subjectType].toLowerCase() : 'record'
      return { row, title: `${row.count} ${noun}${row.count === 1 ? '' : 's'} assigned to you` as string | null }
    }
    if (!row.subjectType || !row.subjectId) return { row, title: null }
    const name = namesByType.get(row.subjectType)?.get(row.subjectId)
    if (name === undefined) return { row, title: null }
    return { row, title: `${SUBJECT_LABEL[row.subjectType]} assigned to you: ${name}` }
  })

  return withTitles
    .filter((r) => r.title !== null)
    .map(({ row, title }) => ({
      id: row.id,
      title: title!,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
    }))
}

/** Scoped by id + orgId + recipientId — a Member can only ever mark their OWN notification read,
 *  never anyone else's (see tests/integration/notifications.test.ts). A no-op (already read, or
 *  not found/not theirs) is not an error — `updateMany`'s affected-row count is 0 either way, and
 *  the caller doesn't need to distinguish those two cases. */
export function markNotificationRead(orgId: string, recipientId: string, id: string) {
  return prisma.notification.updateMany({
    where: { id, orgId, recipientId, readAt: null },
    data: { readAt: new Date() },
  })
}

export function markAllNotificationsRead(orgId: string, recipientId: string) {
  return prisma.notification.updateMany({
    where: { orgId, recipientId, readAt: null },
    data: { readAt: new Date() },
  })
}

// withTransaction re-exported so action-layer code that needs to write a notification alongside
// an existing mutation (bulk reassign, import's batch-finalization summary) doesn't need a
// second import for the one helper every write in lib/data/*.ts already goes through.
export { withTransaction }
