// Server-only data access. Do not import this module from a Client
// Component — it pulls in `@prisma/client`, which only runs in Node.
//
// Every function requires `orgId` as its first argument and includes it in
// every `where` clause. Never call these with an id alone — that would let
// a client that guessed/enumerated an id read across tenants.
import type { Prisma } from '@prisma/client'
import { prisma } from '@lib/prisma'

export interface ListContactsOptions {
  ownerId?: string
  tag?: string
  search?: string
}

export function listContacts(orgId: string, options: ListContactsOptions = {}) {
  const { ownerId, tag, search } = options

  const where: Prisma.ContactWhereInput = {
    orgId,
    ...(ownerId && { ownerId }),
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

export function getContactById(orgId: string, id: string) {
  return prisma.contact.findFirst({
    where: { id, orgId },
    include: { owner: true, company: true, deals: true, originLead: true },
  })
}

/** Case-insensitive lookup within one org; used to reject duplicate emails. */
export function getContactByEmail(orgId: string, email: string) {
  return prisma.contact.findFirst({
    where: { orgId, email: { equals: email, mode: 'insensitive' } },
    select: { id: true },
  })
}

export function createContact(
  orgId: string,
  data: Omit<Prisma.ContactCreateInput, 'orgId'>,
) {
  return prisma.contact.create({ data: { ...data, orgId } })
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
 * for a save that changed nothing. Mirrors updateLead in lib/data/leads.ts.
 */
export async function updateContact(
  orgId: string,
  id: string,
  data: UpdateContactInput,
  actorId: string,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.contact.findFirst({ where: { id, orgId } })
    if (!existing) throw new Error(`Contact ${id} not found in org ${orgId}`)

    const changed: string[] = []
    if (existing.name !== data.name) changed.push('name')
    if (existing.title !== data.title) changed.push('title')
    if (existing.email !== data.email) changed.push('email')
    if (existing.phone !== data.phone) changed.push('phone')
    if (existing.companyId !== data.companyId) changed.push('company')
    if (existing.ownerId !== data.ownerId) changed.push('owner')

    if (changed.length === 0) return existing

    const updated = await tx.contact.update({
      where: { id },
      data: { ...data, lastInteractionAt: new Date() },
    })

    await tx.activity.create({
      data: {
        orgId,
        kind: 'edited',
        title: `edited ${updated.name}`,
        body: `Changed: ${changed.join(', ')}`,
        actorId,
        subjectType: 'contact',
        subjectLabel: updated.name,
        contactId: id,
      },
    })

    return updated
  })
}

export function addContactTag(orgId: string, id: string, tag: string) {
  return prisma.$transaction(async (tx) => {
    const contact = await tx.contact.findFirst({ where: { id, orgId } })
    if (!contact) throw new Error(`Contact ${id} not found in org ${orgId}`)
    if (contact.tags.includes(tag)) return contact
    return tx.contact.update({
      where: { id },
      data: { tags: { push: tag } },
    })
  })
}
