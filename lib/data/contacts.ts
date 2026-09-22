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
        { company: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ],
    }),
  }

  return prisma.contact.findMany({
    where,
    include: { owner: true, _count: { select: { deals: true } } },
    orderBy: { lastInteractionAt: 'desc' },
  })
}

export function getContactById(orgId: string, id: string) {
  return prisma.contact.findFirst({
    where: { id, orgId },
    include: { owner: true, deals: true, originLead: true },
  })
}

export function createContact(
  orgId: string,
  data: Omit<Prisma.ContactCreateInput, 'orgId'>,
) {
  return prisma.contact.create({ data: { ...data, orgId } })
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
