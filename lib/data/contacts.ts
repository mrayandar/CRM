// Server-only data access. Do not import this module from a Client
// Component — it pulls in `@prisma/client`, which only runs in Node.
import type { Prisma } from '@prisma/client'
import { prisma } from '@lib/prisma'

export interface ListContactsOptions {
  ownerId?: string
  tag?: string
  search?: string
}

export function listContacts(options: ListContactsOptions = {}) {
  const { ownerId, tag, search } = options

  const where: Prisma.ContactWhereInput = {
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

export function getContactById(id: string) {
  return prisma.contact.findUnique({
    where: { id },
    include: { owner: true, deals: true, originLead: true },
  })
}

export function createContact(data: Prisma.ContactCreateInput) {
  return prisma.contact.create({ data })
}

export function addContactTag(id: string, tag: string) {
  return prisma.$transaction(async (tx) => {
    const contact = await tx.contact.findUniqueOrThrow({ where: { id } })
    if (contact.tags.includes(tag)) return contact
    return tx.contact.update({
      where: { id },
      data: { tags: { push: tag } },
    })
  })
}
