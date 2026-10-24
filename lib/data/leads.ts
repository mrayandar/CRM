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
export function createLead(scope: Scope, data: Omit<Prisma.LeadCreateInput, 'orgId'>) {
  return prisma.lead.create({ data: { ...data, orgId: scope.orgId } })
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

    if (changed.length === 0) return existing

    const updated = await tx.lead.update({
      where: { id },
      data: { ...data, lastTouchedAt: new Date() },
    })

    if (existing.ownerId !== data.ownerId) {
      await cascadeActivityOwner(tx, 'leadId', id, data.ownerId)
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
