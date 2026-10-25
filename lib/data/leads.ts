// Server-only data access. Do not import this module from a Client
// Component — it pulls in `@prisma/client`, which only runs in Node.
//
// Every function takes a `Scope` (orgId + the caller's scopeOwnerId — null for an Admin or an
// ALL-mode org, a real id for a scoped Member) as its first argument and includes both in every
// `where` clause. Never call these with a bare orgId or an id alone — that would let a client
// read or write across tenants, or (once an org is in OWN mode) across reps within the same org.
import type { LeadSource, LeadStatus, Priority, Prisma } from '@prisma/client'
import { prisma, withTransaction } from '@lib/prisma'
import type { Scope } from '@lib/scope'
import { cascadeActivityOwner } from '@lib/data/activities'
import {
  retractAssignedNotifications,
  writeAssignedNotification,
  writeCoalescedAssignedNotification,
} from '@lib/data/notifications'

export interface ListLeadsOptions {
  status?: LeadStatus
  /** A free filter, meaningful only when `scope.scopeOwnerId` is null (an Admin choosing which
   *  rep's leads to view) — ignored entirely when the caller is already scoped, since there is
   *  only ever one valid value for them and the data layer, not the caller, decides it. */
  ownerId?: string
  search?: string
}

export function listLeads(scope: Scope, options: ListLeadsOptions = {}) {
  const { status, ownerId, search } = options

  const where: Prisma.LeadWhereInput = {
    orgId: scope.orgId,
    ...(status && { status }),
    ...(scope.scopeOwnerId ? { ownerId: scope.scopeOwnerId } : ownerId ? { ownerId } : {}),
    ...(search && {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { company: { name: { contains: search, mode: 'insensitive' } } },
        { email: { contains: search, mode: 'insensitive' } },
      ],
    }),
  }

  return prisma.lead.findMany({
    where,
    include: {
      owner: true,
      company: true,
      convertedDeal: { select: { id: true } },
      convertedContact: { select: { id: true } },
    },
    orderBy: { lastTouchedAt: 'desc' },
  })
}

export function getLeadById(scope: Scope, id: string) {
  return prisma.lead.findFirst({
    where: {
      id,
      orgId: scope.orgId,
      ...(scope.scopeOwnerId && { ownerId: scope.scopeOwnerId }),
    },
    include: { owner: true, company: true, convertedDeal: true, convertedContact: true },
  })
}

/** Creation has nothing yet to scope a read against — `scope.scopeOwnerId` isn't used here. The
 *  caller (createLeadAction) is responsible for enforcing that a scoped Member can only create a
 *  lead owned by themselves; this function trusts `data.owner`/`data.orgId` exactly as given,
 *  same as before Scope existed. Still takes `Scope`, not a bare orgId, for consistency with
 *  every other function here (and so the structural test covers it too). */
export function createLead(
  scope: Scope,
  data: Omit<Prisma.LeadCreateInput, 'orgId'>,
  /** Optional transaction client — passed by createLeadAction so the "assigned" notification
   *  write can share the exact same transaction as the create, not a separate statement after
   *  it. Defaults to the plain client for every other (unchanged) caller. */
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  return client.lead.create({ data: { ...data, orgId: scope.orgId } })
}

/** Case-insensitive lookup within the WHOLE org, deliberately ignoring `scope.scopeOwnerId` —
 *  mirrors getContactByEmail's identical note: email-match duplicate detection (CSV import) is an
 *  org-level question ("does this email already exist at all"), not a per-owner one. The caller
 *  decides what a scoped Member is allowed to DO with a match found outside their own scope
 *  (lib/data/import.ts never lets that match reveal the other owner's identity). */
export function getLeadByEmail(scope: Scope, email: string) {
  return prisma.lead.findFirst({
    where: { orgId: scope.orgId, email: { equals: email, mode: 'insensitive' } },
    select: { id: true, ownerId: true, name: true },
  })
}

export async function updateLeadStatus(scope: Scope, id: string, status: LeadStatus) {
  return withTransaction(async (tx) => {
    const existing = await tx.lead.findFirst({
      where: { id, orgId: scope.orgId, ...(scope.scopeOwnerId && { ownerId: scope.scopeOwnerId }) },
    })
    if (!existing) throw new Error(`Lead ${id} not found in org ${scope.orgId}`)
    return tx.lead.update({
      where: { id },
      data: { status, lastTouchedAt: new Date() },
    })
  })
}

export interface UpdateLeadInput {
  name: string
  title: string
  email: string
  phone: string
  companyId: string
  source: LeadSource
  ownerId: string
  /** Omitted (not just `null`) means "leave it alone" — CSV import's update path never maps a
   *  follow-up column, so it never passes this key at all; a direct lead edit always passes a
   *  concrete `Date | null` (null clears it). Prisma itself treats a `data` key whose value is
   *  `undefined` as "don't include this column in the update", which is exactly this distinction. */
  followUpAt?: Date | null
}

/**
 * Updates the lead's own editable fields (not its status/conversion), bumps lastTouchedAt, and logs
 * an "edited" activity with a short summary of which fields actually changed — all in one
 * transaction, so a failed write can never leave an orphan activity. A no-op save (nothing actually
 * differs) skips the write and the activity entirely, rather than bumping lastTouchedAt and logging
 * an empty "edited" entry for a save that changed nothing.
 *
 * When `data.ownerId` differs from the lead's current owner, this is a reassignment: every
 * Activity already attached to this lead is cascaded to the new owner in the same transaction
 * (see cascadeActivityOwner) — Activity.ownerId must never lag the subject's real current owner,
 * or a reassigned-away rep would keep seeing this lead's history in OWN mode. The scoped read
 * above already guarantees a scoped Member can only be reassigning a lead they currently own —
 * the destination owner is never restricted here (that's enforced one layer up, in the action).
 */
export async function updateLead(
  scope: Scope,
  id: string,
  data: UpdateLeadInput,
  actorId: string,
  /** Client-generated id for the "edited" activity — see Activity's id param on logActivity for
   *  why this matters: without it, a client that logs two edits with identical "Changed: ..."
   *  text has no way to tell its own two distinct optimistic rows apart from one real row. */
  activityId: string,
) {
  return withTransaction(async (tx) => {
    const existing = await tx.lead.findFirst({
      where: { id, orgId: scope.orgId, ...(scope.scopeOwnerId && { ownerId: scope.scopeOwnerId }) },
    })
    if (!existing) throw new Error(`Lead ${id} not found in org ${scope.orgId}`)

    const changed: string[] = []
    if (existing.name !== data.name) changed.push('name')
    if (existing.title !== data.title) changed.push('title')
    if (existing.email !== data.email) changed.push('email')
    if (existing.phone !== data.phone) changed.push('phone')
    if (existing.companyId !== data.companyId) changed.push('company')
    if (existing.source !== data.source) changed.push('source')
    if (existing.ownerId !== data.ownerId) changed.push('owner')
    if (
      data.followUpAt !== undefined &&
      (existing.followUpAt?.getTime() ?? null) !== (data.followUpAt?.getTime() ?? null)
    ) {
      changed.push('follow-up date')
    }

    if (changed.length === 0) return existing

    // An inactive owner can't be a NEW assignment — but editing other fields on a record an
    // inactive owner already owns must still work (ownerId unchanged), which is exactly why this
    // is gated on the reassignment branch, not a blanket check on every save. See PROGRESS.md's
    // "Deliberately not built in this pass" note on Owner.active for the original reasoning.
    if (existing.ownerId !== data.ownerId) {
      const newOwnerActive = await tx.owner.findFirst({ where: { id: data.ownerId, orgId: scope.orgId, active: true } })
      if (!newOwnerActive) throw new Error('Owner not found')
    }

    const updated = await tx.lead.update({
      where: { id },
      data: { ...data, lastTouchedAt: new Date() },
    })

    if (existing.ownerId !== data.ownerId) {
      await cascadeActivityOwner(tx, 'leadId', id, data.ownerId)
      await retractAssignedNotifications(tx, {
        orgId: scope.orgId, formerRecipientId: existing.ownerId, subjectType: 'lead', subjectId: id,
      })
      await writeAssignedNotification(tx, {
        orgId: scope.orgId, recipientId: data.ownerId, actorId,
        subjectType: 'lead', subjectId: id, dedupeKey: activityId,
      })
    }

    await tx.activity.create({
      data: {
        id: activityId,
        orgId: scope.orgId,
        kind: 'edited',
        title: `edited ${updated.name}`,
        body: `Changed: ${changed.join(', ')}`,
        actorId,
        ownerId: updated.ownerId,
        subjectType: 'lead',
        subjectLabel: updated.name,
        leadId: id,
      },
    })

    return updated
  })
}

export type BulkReassignOutcome = 'moved' | 'skipped' | 'failed'
export interface BulkReassignLeadResult {
  leadId: string
  outcome: BulkReassignOutcome
}

/** One request-scoped transaction covers at most this many leads — keeps each transaction short
 *  (no long-held locks, no risk of the interactive-transaction timeout) regardless of how large a
 *  selection the caller passes in. A 100-lead selection runs as 4 sequential chunk transactions,
 *  not one giant one. */
const BULK_REASSIGN_CHUNK_SIZE = 25

/**
 * Reassigns many leads to one new owner, chunked into transactions of
 * `BULK_REASSIGN_CHUNK_SIZE`, writing exactly one coalesced "N leads assigned to you" notification
 * for the new owner at the end instead of one per lead — the whole point of a bulk action is that
 * the recipient doesn't get flooded.
 *
 * Unlike a single-record `updateLead`, a lead id outside `scope` (a cross-tenant id, or — for a
 * scoped Member — a lead outside their own OWN-mode reach) does NOT reject the whole batch —
 * parity with the UI's old behavior of calling `updateLeadAction` once per lead, where one lead
 * failing never blocked the others. It's reported back as `'failed'` in `results`, with no detail
 * beyond that (nothing about the out-of-scope lead — its name, its real owner, or why it failed —
 * is ever revealed), and nothing is written for it. A lead already owned by `newOwnerId` is
 * reported `'skipped'` (a legitimate no-op, not a scope violation). Only a lead reported `'moved'`
 * counts toward the coalesced notification. Each moved lead still gets its own cascaded activity
 * ownership, its own "edited" activity entry, and its own notification retraction from its former
 * owner — only the new-owner notification is coalesced across the whole call.
 */
export async function bulkReassignLeads(
  scope: Scope,
  input: {
    leadIds: string[]
    newOwnerId: string
    actorId: string
    /** Client-generated id for the whole bulk operation — see updateLead's activityId doc. Each
     *  lead's own activity row uses `${activityId}:${leadId}` (same suffixing convention as
     *  convertLeadToDeal) and the coalesced notification uses `bulk-reassign:${activityId}`. */
    activityId: string
  },
): Promise<{ results: BulkReassignLeadResult[]; movedCount: number }> {
  const newOwner = await prisma.owner.findFirst({
    where: { id: input.newOwnerId, orgId: scope.orgId, active: true },
  })
  if (!newOwner) throw new Error('Owner not found')

  const results: BulkReassignLeadResult[] = []
  let movedCount = 0

  for (let i = 0; i < input.leadIds.length; i += BULK_REASSIGN_CHUNK_SIZE) {
    const chunk = input.leadIds.slice(i, i + BULK_REASSIGN_CHUNK_SIZE)
    const chunkResults = await withTransaction(async (tx) => {
      const out: BulkReassignLeadResult[] = []
      for (const leadId of chunk) {
        const existing = await tx.lead.findFirst({
          where: { id: leadId, orgId: scope.orgId, ...(scope.scopeOwnerId && { ownerId: scope.scopeOwnerId }) },
        })
        if (!existing) {
          out.push({ leadId, outcome: 'failed' })
          continue
        }
        if (existing.ownerId === input.newOwnerId) {
          out.push({ leadId, outcome: 'skipped' })
          continue
        }

        const updated = await tx.lead.update({
          where: { id: leadId },
          data: { ownerId: input.newOwnerId, lastTouchedAt: new Date() },
        })
        await cascadeActivityOwner(tx, 'leadId', leadId, input.newOwnerId)
        await retractAssignedNotifications(tx, {
          orgId: scope.orgId, formerRecipientId: existing.ownerId, subjectType: 'lead', subjectId: leadId,
        })
        await tx.activity.create({
          data: {
            id: `${input.activityId}:${leadId}`,
            orgId: scope.orgId,
            kind: 'edited',
            title: `edited ${updated.name}`,
            body: 'Changed: owner',
            actorId: input.actorId,
            ownerId: updated.ownerId,
            subjectType: 'lead',
            subjectLabel: updated.name,
            leadId,
          },
        })
        out.push({ leadId, outcome: 'moved' })
      }
      return out
    })
    results.push(...chunkResults)
    movedCount += chunkResults.filter((r) => r.outcome === 'moved').length
  }

  if (movedCount > 0) {
    await withTransaction(async (tx) => {
      await writeCoalescedAssignedNotification(tx, {
        orgId: scope.orgId, recipientId: input.newOwnerId, actorId: input.actorId,
        subjectType: 'lead', count: movedCount, dedupeKey: `bulk-reassign:${input.activityId}`,
      })
    })
  }

  return { results, movedCount }
}

/** Optional deal-creation piece of a lead conversion. `stage` must already be tenant-checked by
 *  the caller (getStageById), same convention as ownerId. */
export interface ConvertLeadDealInput {
  name: string
  value: number
  stage: { id: string; probability: number }
  closeDate: Date
  priority: Priority
}

/**
 * Converts a lead — always creates a Contact (and marks the lead qualified);
 * additionally creates a Deal only when `deal` is provided. Mirrors
 * `convertLead` in `src/store/crm.tsx` on the frontend mock store.
 *
 * When `input.ownerId` differs from the lead's own current owner, the lead's `ownerId` moves to
 * match in this same transaction, and every activity already on the lead cascades to the new
 * owner too — the new contact/deal and the lead end up under one effective owner, and the lead's
 * own history moves with it. A scoped Member can only ever convert to themselves (enforced one
 * layer up, in the action), so this reassign-on-convert path is only ever reachable by an Admin
 * or in an ALL-mode org.
 */
export async function convertLeadToDeal(
  scope: Scope,
  leadId: string,
  input: {
    ownerId: string
    /** Who performed the conversion (for the activity entry). */
    actorId: string
    /** Client-generated ids so the optimistic UI rows are the real rows. */
    contactId?: string
    dealId?: string
    /** Client-generated id for the "converted..." activity — same reason as updateLead's. */
    activityId: string
    /** Omit to convert to a Contact only. Provide to also open a Deal. */
    deal?: ConvertLeadDealInput
  },
) {
  return withTransaction(async (tx) => {
    const lead = await tx.lead.findFirst({
      where: { id: leadId, orgId: scope.orgId, ...(scope.scopeOwnerId && { ownerId: scope.scopeOwnerId }) },
    })
    if (!lead) throw new Error(`Lead ${leadId} not found in org ${scope.orgId}`)

    const contact = await tx.contact.create({
      data: {
        ...(input.contactId && { id: input.contactId }),
        orgId: scope.orgId,
        name: lead.name,
        title: lead.title,
        companyId: lead.companyId,
        email: lead.email,
        phone: lead.phone,
        ownerId: input.ownerId,
        originLeadId: lead.id,
        tags: ['Converted lead', lead.source],
        lifecycle: 'Prospect',
        location: lead.location,
      },
    })

    let deal: Awaited<ReturnType<typeof tx.deal.create>> | null = null
    if (input.deal) {
      deal = await tx.deal.create({
        data: {
          ...(input.dealId && { id: input.dealId }),
          orgId: scope.orgId,
          name: input.deal.name,
          companyId: lead.companyId,
          value: input.deal.value,
          stageId: input.deal.stage.id,
          ownerId: input.ownerId,
          priority: input.deal.priority,
          source: lead.source,
          probability: input.deal.stage.probability,
          closeDate: input.deal.closeDate,
          leadId: lead.id,
          contactId: contact.id,
        },
      })
    }

    const leadOwnerChanged = lead.ownerId !== input.ownerId
    await tx.lead.update({
      where: { id: leadId },
      data: {
        status: 'qualified',
        lastTouchedAt: new Date(),
        ...(leadOwnerChanged && { ownerId: input.ownerId }),
      },
    })
    if (leadOwnerChanged) {
      await cascadeActivityOwner(tx, 'leadId', leadId, input.ownerId)
      await retractAssignedNotifications(tx, {
        orgId: scope.orgId, formerRecipientId: lead.ownerId, subjectType: 'lead', subjectId: leadId,
      })
      await writeAssignedNotification(tx, {
        orgId: scope.orgId, recipientId: input.ownerId, actorId: input.actorId,
        subjectType: 'lead', subjectId: leadId, dedupeKey: `${input.activityId}:lead`,
      })
    }
    // Distinct dedupe keys (suffixed off the one activityId the caller provides) — the new
    // contact, the optional new deal, and the lead reassignment above are three independently
    // notifiable events that can all land on the SAME recipient in one conversion; a shared key
    // would make the second and third writes look like duplicates of the first and get silently
    // dropped.
    await writeAssignedNotification(tx, {
      orgId: scope.orgId, recipientId: input.ownerId, actorId: input.actorId,
      subjectType: 'contact', subjectId: contact.id, dedupeKey: `${input.activityId}:contact`,
    })
    if (deal) {
      await writeAssignedNotification(tx, {
        orgId: scope.orgId, recipientId: input.ownerId, actorId: input.actorId,
        subjectType: 'deal', subjectId: deal.id, dedupeKey: `${input.activityId}:deal`,
      })
    }

    await tx.activity.create({
      data: {
        id: input.activityId,
        orgId: scope.orgId,
        kind: 'created',
        title: input.deal
          ? `converted ${lead.name} into ${input.deal.name}`
          : `converted ${lead.name} to a contact`,
        actorId: input.actorId,
        ownerId: input.ownerId,
        subjectType: 'lead',
        subjectLabel: lead.name,
        leadId: lead.id,
      },
    })

    return { contact, deal }
  })
}
