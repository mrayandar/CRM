// Server-only data access. Do not import this module from a Client
// Component — it pulls in `@prisma/client`, which only runs in Node.
import { prisma } from '@lib/prisma'

export function listOwners() {
  return prisma.owner.findMany({ orderBy: { name: 'asc' } })
}

export function getOwnerById(id: string) {
  return prisma.owner.findUnique({ where: { id } })
}

export function getOwnerByEmail(email: string) {
  return prisma.owner.findUnique({ where: { email } })
}
