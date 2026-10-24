// Server-only data access. Do not import this module from a Client
// Component — it pulls in `@prisma/client`, which only runs in Node.
//
// Every function takes a `Scope` (orgId + the caller's scopeOwnerId) as its first argument and
// includes both in every `where` clause. Never call these with a bare orgId or an id alone —
// that would let a client read or write across tenants, or across reps within the same org.
import type { Prisma } from '@prisma/client'
import { prisma, withTransaction } from '@lib/prisma'
import type { Scope } from '@lib/scope'
import { cascadeActivityOwner } from '@lib/data/activities'
import { retractAssignedNotifications, writeAssignedNotification } from '@lib/data/notifications'

export interface ListContactsOptions {
  /** A free filter, meaningful only when `scope.scopeOwnerId` is null — see ListLeadsOptions'
   *  identical field in lib/data/leads.ts for why this is ignored once the caller is scoped. */
  ownerId?: string
  tag?: string
  search?: string
}

export function listContacts(scope: Scope, options: ListContactsOptions = {}) {
  const { ownerId, tag, search } = options

  const where: Prisma.ContactWhereInput = {
    orgId: scope.orgId,
    ...(scope.scopeOwnerId ? { ownerId: scope.scopeOwnerId } : ownerId ? { ownerId } : {}),
    ...(tag && { tags: { has: tag } }),
    ...(search && {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { company: { name: { contains: search, mode: 'insensitive' } } },
        { email: { contains: search, mode: 'insensitive' } },
      ],
    }),
  }

  return prisma.contact.findMany({
    where,
    include: { owner: true, company: true, _count: { select: { deals: true } } },
    orderBy: { lastInteractionAt: 'desc' },
  })
}

export function getContactById(scope: Scope, id: string) {
  return prisma.contact.findFirst({
    where: {
      id,
      orgId: scope.orgId,
      ...(scope.scopeOwnerId && { ownerId: scope.scopeOwnerId }),
    },
    include: { owner: true, company: true, deals: true, originLead: true },
  })
}

/** Case-insensitive lookup within one org; used to reject duplicate emails. Deliberately searches
 *  the WHOLE org regardless of scope — email uniqueness is an org-level invariant, not a
 *  per-owner one, so a scoped Member must still be blocked from creating a duplicate of a contact
 *  they can't otherwise see. Still takes `Scope`, not a bare orgId, for consistency with every
 *  other function here (and so the structural test covers it too). */
export function getContactByEmail(scope: Scope, email: string) {
  return prisma.contact.findFirst({
    where: { orgId: scope.orgId, email: { equals: email, mode: 'insensitive' } },
    select: { id: true, ownerId: true, name: true },
  })
}

/** Creation has nothing yet to scope a read against — `scope.scopeOwnerId` isn't used here. The
 *  caller (createContactAction) is responsible for enforcing that a scoped Member can only create
 *  a contact owned by themselves — see createLead's identical note in lib/data/leads.ts. */
export function createContact(
  scope: Scope,
  data: Omit<Prisma.ContactCreateInput, 'orgId'>,
  /** Optional transaction client — see createLead's identical param in lib/data/leads.ts. */
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  return client.contact.create({ data: { ...data, orgId: scope.orgId } })
}

export interface UpdateContactInput {
  name: string
  title: string
  email: string
  phone: string
  companyId: string
  ownerId: string
}

/**
 * Updates the contact's own editable fields, bumps lastInteractionAt, and logs an "edited" activity
 * with a short summary of which fields actually changed — all in one transaction, so a failed write
 * can never leave an orphan activity. A no-op save (nothing actually differs) skips the write and
 * the activity entirely, rather than bumping lastInteractionAt and logging an empty "edited" entry
 * for a save that changed nothing. Mirrors updateLead in lib/data/leads.ts, including the
 * reassignment cascade: when `data.ownerId` differs from the contact's current owner, every
 * Activity already attached to it moves to the new owner in the same transaction.
 */
export async function updateContact(
  scope: Scope,
  id: string,
  data: UpdateContactInput,
  actorId: string,
  /** Client-generated id for the "edited" activity — see updateLead's identical param. */
  activityId: string,
) {
  return withTransaction(async (tx) => {
    const existing = await tx.contact.findFirst({
      where: { id, orgId: scope.orgId, ...(scope.scopeOwnerId && { ownerId: scope.scopeOwnerId }) },
    })
    if (!existing) throw new Error(`Contact ${id} not found in org ${scope.orgId}`)

    const changed: string[] = []
    if (existing.name !== data.name) changed.push('name')
    if (existing.title !== data.title) changed.push('title')
    if (existing.email !== data.email) changed.push('email')
    if (existing.phone !== data.phone) changed.push('phone')
    if (existing.companyId !== data.companyId) changed.push('company')
    if (existing.ownerId !== data.ownerId) changed.push('owner')

    if (changed.length === 0) return existing

    // See updateLead's identical note — active is only required for an actual reassignment,
    // never for a plain field edit on a record an inactive owner already owns.
    if (existing.ownerId !== data.ownerId) {
      const newOwnerActive = await tx.owner.findFirst({ where: { id: data.ownerId, orgId: scope.orgId, active: true } })
      if (!newOwnerActive) throw new Error('Owner not found')
    }

    const updated = await tx.contact.update({
      where: { id },
      data: { ...data, lastInteractionAt: new Date() },
    })

    if (existing.ownerId !== data.ownerId) {
      await cascadeActivityOwner(tx, 'contactId', id, data.ownerId)
      await retractAssignedNotifications(tx, {
        orgId: scope.orgId, formerRecipientId: existing.ownerId, subjectType: 'contact', subjectId: id,
      })
      await writeAssignedNotification(tx, {
        orgId: scope.orgId, recipientId: data.ownerId, actorId,
        subjectType: 'contact', subjectId: id, dedupeKey: activityId,
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
        subjectType: 'contact',
        subjectLabel: updated.name,
        contactId: id,
      },
    })

    return updated
  })
}

export function addContactTag(scope: Scope, id: string, tag: string) {
  return withTransaction(async (tx) => {
    const contact = await tx.contact.findFirst({
      where: { id, orgId: scope.orgId, ...(scope.scopeOwnerId && { ownerId: scope.scopeOwnerId }) },
    })
    if (!contact) throw new Error(`Contact ${id} not found in org ${scope.orgId}`)
    if (contact.tags.includes(tag)) return contact
    return tx.contact.update({
      where: { id },
      data: { tags: { push: tag } },
    })
  })
}
