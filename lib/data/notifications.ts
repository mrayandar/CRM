// Server-only data access. Every function takes orgId + recipientId explicitly and filters by
// both — never a bare recipientId, which would let one owner read or mark another's
// notifications (see tests/integration/notifications.test.ts).
import { prisma, withTransaction } from '@lib/prisma'
import type { Scope } from '@lib/scope'
import { localDayDelta } from '@lib/timezones'
import type { LeadStatus, NotificationKind, Prisma, SubjectType } from '@prisma/client'

// Duplicated from lib/data/leads.ts's identical constant, deliberately — importing it here would
// create a circular module dependency (lib/data/leads.ts already imports from this file for its
// own notification writes). Two Lead statuses, unlikely to drift; if it ever needs a third
// source of truth, that's the moment to extract a shared non-circular module instead.
const CLOSED_LEAD_STATUSES: LeadStatus[] = ['lost', 'unqualified']

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
 *
 * Writes via `createMany({ skipDuplicates: true })`, not `create()` + catch P2002 — this is
 * usually the ONLY write in its caller's transaction, but a few call sites (convertLeadToDeal's
 * three suffixed-dedupe-key writes; Stage C's per-item loop) write several of these inside ONE
 * transaction. A caught error still leaves Postgres's own transaction aborted (no implicit
 * savepoint — see https://www.postgresql.org/docs/current/transaction-iso.html): every statement
 * AFTER the one that threw, including an unrelated activity.create at the end, would then fail
 * with "current transaction is aborted" even though the catch block looked like it recovered.
 * `skipDuplicates` turns the conflict into a no-op at the SQL level (`ON CONFLICT DO NOTHING`),
 * so the transaction is never put in that state at all. (Found this exact failure mode building
 * Stage C's per-item scan loop — see tests/integration/notification-scan.test.ts.)
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
  await tx.notification.createMany({
    data: [{
      orgId: input.orgId,
      recipientId: input.recipientId,
      kind: 'assigned',
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      dedupeKey: input.dedupeKey,
    }],
    skipDuplicates: true,
  })
}

/**
 * The coalesced form — "N leads assigned to you" — for a bulk reassign or an import batch
 * summary. Same self-assignment/active-recipient/dedupe-collision handling as
 * `writeAssignedNotification`; no `subjectId` (there is no single subject), `count` instead.
 * `subjectType` is still recorded (lead/contact) purely to pick the right noun at read time — see
 * `buildNotificationView` — never to look up an individual record.
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
  await tx.notification.createMany({
    data: [{
      orgId: input.orgId,
      recipientId: input.recipientId,
      kind: 'assigned',
      subjectType: input.subjectType,
      count: input.count,
      dedupeKey: input.dedupeKey,
    }],
    skipDuplicates: true,
  })
}

// ---------------------------------------------------------------------------
// Writing (time-based kinds: task_due, lead_follow_up — Stage C)
// ---------------------------------------------------------------------------

/**
 * Writes a single task_due/lead_follow_up notification for one subject — same self-contained,
 * inactive-recipient-skipping, dedupe-collision-swallowing conventions as
 * `writeAssignedNotification`, but there is no `actorId` (nobody "did" this; a scan found it) and
 * `triggerDate` is always recorded, so a later read can tell whether the date that made this due
 * is still the subject's current one (see `buildNotificationView`). Only ever called from
 * `scanAndNotify` — never from an action, which is what `assigned` writes are for.
 */
async function writeTimeBasedNotification(
  tx: Prisma.TransactionClient,
  input: {
    orgId: string
    recipientId: string
    kind: 'task_due' | 'lead_follow_up'
    subjectType: SubjectType
    subjectId: string
    triggerDate: string
    dedupeKey: string
  },
): Promise<void> {
  const recipient = await tx.owner.findFirst({ where: { id: input.recipientId, orgId: input.orgId, active: true } })
  if (!recipient) return
  await tx.notification.createMany({
    data: [{
      orgId: input.orgId,
      recipientId: input.recipientId,
      kind: input.kind,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      triggerDate: input.triggerDate,
      dedupeKey: input.dedupeKey,
    }],
    skipDuplicates: true,
  })
}

/** The coalesced form for task_due/lead_follow_up — "N tasks due or overdue" / "N leads need
 *  follow-up" — used for the first-ever scan's flood control and for any later scan whose
 *  individual count would exceed `SCAN_FLOOD_CAP`. Same shape as `writeCoalescedAssignedNotification`. */
async function writeTimeBasedSummary(
  tx: Prisma.TransactionClient,
  input: {
    orgId: string
    recipientId: string
    kind: 'task_due' | 'lead_follow_up'
    subjectType: SubjectType
    count: number
    dedupeKey: string
  },
): Promise<void> {
  if (input.count <= 0) return
  const recipient = await tx.owner.findFirst({ where: { id: input.recipientId, orgId: input.orgId, active: true } })
  if (!recipient) return
  await tx.notification.createMany({
    data: [{
      orgId: input.orgId,
      recipientId: input.recipientId,
      kind: input.kind,
      subjectType: input.subjectType,
      count: input.count,
      dedupeKey: input.dedupeKey,
    }],
    skipDuplicates: true,
  })
}

async function writeTimeBasedBatch(
  tx: Prisma.TransactionClient,
  orgId: string,
  ownerId: string,
  kind: 'task_due' | 'lead_follow_up',
  subjectType: SubjectType,
  items: { id: string; dateYmd: string }[],
  todayYmd: string,
): Promise<void> {
  if (items.length === 0) return
  // Flood control for a NORMAL (not-first) scan: a recipient who comes back from vacation to 40
  // newly-overdue tasks gets one summary, not 40 individual rows. The already-overdue-at-launch
  // case (the first scan ever) is handled one level up in `scanAndNotify`, before this is even
  // called for that case.
  if (items.length > SCAN_FLOOD_CAP) {
    await writeTimeBasedSummary(tx, {
      orgId, recipientId: ownerId, kind, subjectType, count: items.length,
      dedupeKey: `${kind}_summary:${ownerId}:${todayYmd}`,
    })
    return
  }
  for (const item of items) {
    await writeTimeBasedNotification(tx, {
      orgId, recipientId: ownerId, kind, subjectType, subjectId: item.id, triggerDate: item.dateYmd,
      dedupeKey: `${kind}:${item.id}:${item.dateYmd}`,
    })
  }
}

/** How often ONE owner's time-based notifications are (re)scanned — see `scanAndNotify`'s own
 *  doc comment for the atomic-claim mechanism this bounds. 5 minutes, per the approved design. */
export const SCAN_INTERVAL_MS = 5 * 60 * 1000

/** More than this many newly-due tasks (or leads) in a single non-first scan collapse into one
 *  summary instead of one notification each — proposed number, not derived from any measurement:
 *  20 is enough to cover a genuinely busy day without flooding the bell, while still being a
 *  small enough list that an unread count of "20-ish" reads as real information, not noise. */
export const SCAN_FLOOD_CAP = 20

const RETENTION_DAYS = 30
/** Postgres's DELETE has no native LIMIT — this bounds the retention sweep via a LIMIT'd subquery
 *  instead, so one owner's scan is never the one that happens to delete thousands of rows in a
 *  single statement. Runs every scan; a backlog beyond this just gets caught by next time. */
const RETENTION_DELETE_LIMIT = 200

/**
 * Scans ONE owner for newly-due tasks/leads and writes their notifications — the entire
 * replacement for a cron job this app doesn't have (Vercel Hobby). Called from
 * GET /api/notifications/unread-count on every poll, but does real work only once per owner per
 * `SCAN_INTERVAL_MS`:
 *
 * 1. Reads the owner first (not the claim yet) — this is the only way to know whether their OLD
 *    `lastScannedAt` was null (their first-ever scan) before the claim overwrites it, and to get
 *    their timezone + active status in the same query.
 * 2. Claims the scan with one atomic `updateMany`, conditioned on that same old value — two open
 *    tabs polling at the same moment race on this UPDATE, and Postgres's own row lock makes
 *    exactly one of them see `count: 1`; the loser sees `count: 0` and returns immediately,
 *    without running a single one of the queries below. This is what "at most once per 5 minutes
 *    per user" actually means: not a soft best-effort, a real mutual exclusion.
 * 3. Fetches this owner's not-done tasks and open (not closed/converted) leads-with-a-follow-up-
 *    date — two queries, each hitting a dedicated index (`tasks_orgId_ownerId_done_idx`,
 *    `leads_orgId_ownerId_followUpAt_idx` — added alongside this feature; EXPLAIN ANALYZE against
 *    the real Neon DB confirmed both are used, not a sequential scan). The due/overdue filter
 *    itself (comparing against the recipient's own calendar "today") can't be pushed into SQL —
 *    it depends on the recipient's timezone, which Postgres has no column for — so it's applied
 *    in JS via `localDayDelta` after the indexed fetch narrows the set to "this owner's open
 *    items" first.
 * 4. On a first-ever scan, writes at most one summary per kind for everything already due (never
 *    individual rows — see `writeTimeBasedBatch`'s doc comment on why that's necessary). On every
 *    later scan, writes one notification per newly-due item (the dedupe key — subject id + its
 *    current date — makes an unchanged item's repeat notification a safe no-op every 5 minutes,
 *    not a duplicate), collapsing into a summary only if a single scan's batch exceeds
 *    `SCAN_FLOOD_CAP`.
 * 5. Deletes up to `RETENTION_DELETE_LIMIT` of this owner's own read notifications older than
 *    `RETENTION_DAYS` — the closest thing this app has to a retention job, run opportunistically
 *    inside the one place that already touches this owner's notifications on a schedule.
 *
 * Never throws for an ordinary "nothing to do" outcome (inactive owner, already scanned
 * recently) — just returns. The caller (the unread-count route) awaits this before computing the
 * count, so a fresh notification from this exact call is reflected in the same response.
 */
export async function scanAndNotify(orgId: string, ownerId: string): Promise<void> {
  const owner = await prisma.owner.findFirst({ where: { id: ownerId, orgId, active: true } })
  if (!owner) return

  const wasFirstScan = owner.lastScannedAt === null
  const cutoff = new Date(Date.now() - SCAN_INTERVAL_MS)
  const claimed = await prisma.owner.updateMany({
    where: { id: ownerId, orgId, OR: [{ lastScannedAt: null }, { lastScannedAt: { lt: cutoff } }] },
    data: { lastScannedAt: new Date() },
  })
  if (claimed.count === 0) return // another open tab already claimed this scan

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { timezone: true, timezoneConfigured: true },
  })
  const effectiveTimezone = owner.timezone ?? (org?.timezoneConfigured ? org.timezone : 'UTC')

  const [openTasks, openLeads] = await Promise.all([
    prisma.task.findMany({ where: { orgId, ownerId, done: false }, select: { id: true, dueDate: true } }),
    prisma.lead.findMany({
      where: { orgId, ownerId, followUpAt: { not: null }, status: { notIn: CLOSED_LEAD_STATUSES } },
      select: { id: true, followUpAt: true, convertedDeal: { select: { id: true } }, convertedContact: { select: { id: true } } },
    }),
  ])

  const dueTasks = openTasks
    .filter((t) => localDayDelta(t.dueDate.toISOString(), effectiveTimezone) <= 0)
    .map((t) => ({ id: t.id, dateYmd: utcYmd(t.dueDate) }))
  const dueLeads = openLeads
    .filter((l) => !l.convertedDeal && !l.convertedContact)
    .filter((l) => localDayDelta(l.followUpAt!.toISOString(), effectiveTimezone) <= 0)
    .map((l) => ({ id: l.id, dateYmd: utcYmd(l.followUpAt!) }))

  const todayYmd = utcYmd(new Date())

  await withTransaction(async (tx) => {
    if (wasFirstScan) {
      if (dueTasks.length > 0) {
        await writeTimeBasedSummary(tx, {
          orgId, recipientId: ownerId, kind: 'task_due', subjectType: 'task', count: dueTasks.length,
          dedupeKey: `task_due_summary:${ownerId}:${todayYmd}`,
        })
      }
      if (dueLeads.length > 0) {
        await writeTimeBasedSummary(tx, {
          orgId, recipientId: ownerId, kind: 'lead_follow_up', subjectType: 'lead', count: dueLeads.length,
          dedupeKey: `lead_follow_up_summary:${ownerId}:${todayYmd}`,
        })
      }
    } else {
      await writeTimeBasedBatch(tx, orgId, ownerId, 'task_due', 'task', dueTasks, todayYmd)
      await writeTimeBasedBatch(tx, orgId, ownerId, 'lead_follow_up', 'lead', dueLeads, todayYmd)
    }

    const retentionCutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
    await tx.$executeRaw`
      DELETE FROM notifications WHERE id IN (
        SELECT id FROM notifications
        WHERE "orgId" = ${orgId} AND "recipientId" = ${ownerId}
          AND "readAt" IS NOT NULL AND "readAt" < ${retentionCutoff}
        LIMIT ${RETENTION_DELETE_LIMIT}
      )
    `
  })
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
  input: {
    orgId: string
    subjectType: SubjectType
    subjectId: string
    /** Restricts the deletion to one kind — e.g. a lead closing should retract its
     *  lead_follow_up notification without touching an unrelated 'assigned' one about the same
     *  lead. Omitted (the subject itself is gone, e.g. a deleted task) deletes every kind. */
    kind?: NotificationKind
  },
) {
  return tx.notification.deleteMany({
    where: {
      orgId: input.orgId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      ...(input.kind && { kind: input.kind }),
    },
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

/** "YYYY-MM-DD" as the UTC date — the same convention Task.dueDate/Lead.followUpAt already store
 *  (see their own schema comments). Used only to compare a notification's stored `triggerDate`
 *  against the subject's CURRENT date; never for display. */
function utcYmd(date: Date): string {
  return date.toISOString().slice(0, 10)
}

interface SubjectRow {
  name: string
  /** Only meaningful for subjectType 'task' (done) or 'lead' (closed/converted) — a kind that
   *  never needs this (e.g. 'assigned') simply never checks it. */
  invalidForTimeBasedKind: boolean
  /** The subject's own current date, as "YYYY-MM-DD" — Task.dueDate or Lead.followUpAt. Null for
   *  contact/deal (no date) or a lead with no followUpAt. */
  currentDateYmd: string | null
}

/** One scoped findMany per subject type present in the current page of rows — bounded at 4
 *  queries total (lead/contact/deal/task), regardless of how many of the up-to-50 rows need a
 *  title. Replaces the earlier one-query-per-row approach (up to 50 extra queries for a full
 *  page), which showed up as a real N+1 — see tests/integration/notifications.test.ts's query-
 *  count check. Each query is scoped by `scope.scopeOwnerId` exactly like the single-id
 *  `getLeadById`/etc. it replaces, so an OWN-mode Member still never gets a title built from a
 *  subject outside their own reach (leaving their scope — e.g. reassigned away in a plain ALL-mode
 *  org, or simply not theirs in OWN mode — makes the batched query miss it, same as not existing).
 *  Fetches exactly the fields needed to also validate a task_due/lead_follow_up row's read-time
 *  visibility (done/closed/converted + the subject's current date) — see `buildNotificationView`. */
async function fetchSubjectRowsByType(
  scope: Scope,
  subjectType: SubjectType,
  ids: string[],
): Promise<Map<string, SubjectRow>> {
  const scopeWhere = scope.scopeOwnerId ? { ownerId: scope.scopeOwnerId } : {}
  const where = { id: { in: ids }, orgId: scope.orgId, ...scopeWhere }

  const map = new Map<string, SubjectRow>()
  if (subjectType === 'lead') {
    const rows = await prisma.lead.findMany({
      where,
      select: { id: true, name: true, status: true, followUpAt: true, convertedDeal: { select: { id: true } }, convertedContact: { select: { id: true } } },
    })
    for (const row of rows) {
      map.set(row.id, {
        name: row.name,
        invalidForTimeBasedKind: CLOSED_LEAD_STATUSES.includes(row.status) || !!row.convertedDeal || !!row.convertedContact,
        currentDateYmd: row.followUpAt ? utcYmd(row.followUpAt) : null,
      })
    }
  } else if (subjectType === 'task') {
    const rows = await prisma.task.findMany({ where, select: { id: true, title: true, done: true, dueDate: true } })
    for (const row of rows) {
      map.set(row.id, { name: row.title, invalidForTimeBasedKind: row.done, currentDateYmd: utcYmd(row.dueDate) })
    }
  } else {
    const rows =
      subjectType === 'contact'
        ? await prisma.contact.findMany({ where, select: { id: true, name: true } })
        : await prisma.deal.findMany({ where, select: { id: true, name: true } })
    for (const row of rows) map.set(row.id, { name: row.name, invalidForTimeBasedKind: false, currentDateYmd: null })
  }
  return map
}

/** Builds one row's title/visibility from its (already batch-fetched) subject data — null means
 *  "don't show this row at all": the subject is gone or out of scope (no map entry), or (for
 *  task_due/lead_follow_up specifically) the task is done/the lead is closed-or-converted, or the
 *  triggering date no longer matches the subject's current date (postponed task, rescheduled
 *  follow-up — see Notification.triggerDate's own schema comment). A coalesced row (count set)
 *  never looks at the subject map at all. */
function buildNotificationView(
  row: { kind: NotificationKind; count: number | null; subjectType: SubjectType | null; subjectId: string | null; triggerDate: string | null },
  subjectsByType: Map<SubjectType, Map<string, SubjectRow>>,
): string | null {
  if (row.count !== null) {
    const noun = row.subjectType ? SUBJECT_LABEL[row.subjectType].toLowerCase() : 'record'
    if (row.kind === 'task_due') return `${row.count} task${row.count === 1 ? '' : 's'} due or overdue`
    if (row.kind === 'lead_follow_up') return `${row.count} lead${row.count === 1 ? '' : 's'} need follow-up`
    return `${row.count} ${noun}${row.count === 1 ? '' : 's'} assigned to you`
  }
  if (!row.subjectType || !row.subjectId) return null
  const subject = subjectsByType.get(row.subjectType)?.get(row.subjectId)
  if (!subject) return null

  if (row.kind === 'task_due') {
    if (subject.invalidForTimeBasedKind) return null // task completed
    if (row.triggerDate !== null && subject.currentDateYmd !== row.triggerDate) return null // due date moved
    return `Task due: ${subject.name}`
  }
  if (row.kind === 'lead_follow_up') {
    if (subject.invalidForTimeBasedKind) return null // lead closed or converted
    if (row.triggerDate !== null && subject.currentDateYmd !== row.triggerDate) return null // follow-up date moved
    return `Lead follow-up: ${subject.name}`
  }
  return `${SUBJECT_LABEL[row.subjectType]} assigned to you: ${subject.name}`
}

/** Newest 50, titles/visibility built at read time from a batched lookup (see
 *  `fetchSubjectRowsByType`/`buildNotificationView`) — never from anything stored on the
 *  Notification row itself beyond `triggerDate` (which only ever holds the DATE that triggered
 *  it, never a name/value/amount). `scope` must be the RECIPIENT's own — the caller (the route
 *  handler) already has it from its own `requireAuth()`, since this is always "list my own
 *  notifications," never anyone else's. */
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

  const subjectsByType = new Map<SubjectType, Map<string, SubjectRow>>(
    await Promise.all(
      [...idsByType.entries()].map(
        async ([subjectType, ids]) => [subjectType, await fetchSubjectRowsByType(scope, subjectType, ids)] as const,
      ),
    ),
  )

  return rows
    .map((row) => ({ row, title: buildNotificationView(row, subjectsByType) }))
    .filter((r): r is { row: (typeof rows)[number]; title: string } => r.title !== null)
    .map(({ row, title }) => ({
      id: row.id,
      title,
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
