// Server-only data access. Do not import this module from a Client
// Component — it pulls in `@prisma/client`, which only runs in Node.
//
// Every function requires `orgId` as its first argument and includes it in
// every `where` clause. Never call these with an id alone — that would let
// a client that guessed/enumerated an id read across tenants.
import type { Prisma } from '@prisma/client'
import { prisma } from '@lib/prisma'

export function listOwners(orgId: string) {
  return prisma.owner.findMany({
    where: { orgId },
    orderBy: { name: 'asc' },
  })
}

export function getOwnerById(orgId: string, id: string) {
  return prisma.owner.findFirst({ where: { id, orgId } })
}

export function getOwnerByEmail(orgId: string, email: string) {
  // Uses the compound unique @@unique([orgId, email]).
  return prisma.owner.findUnique({
    where: { orgId_email: { orgId, email } },
  })
}

export function getOwnerByClerkUserId(orgId: string, clerkUserId: string) {
  return prisma.owner.findUnique({
    where: { orgId_clerkUserId: { orgId, clerkUserId } },
  })
}

export function createOwner(
  orgId: string,
  data: Omit<Prisma.OwnerCreateInput, 'orgId'>,
) {
  return prisma.owner.create({ data: { ...data, orgId } })
}

/**
 * Updates the caller's own profile fields (name, timezone). `id` always comes from
 * `requireAuth()`'s own `ownerId` — never a client-supplied id — so this can only ever
 * write the caller's own row; the `orgId` check is kept anyway for the same defense-in-depth
 * every other write in this file uses.
 */
export function updateOwnerProfile(
  orgId: string,
  id: string,
  data: { name: string; timezone: string | null },
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.owner.findFirst({ where: { id, orgId } })
    if (!existing) throw new Error(`Owner ${id} not found in org ${orgId}`)
    return tx.owner.update({ where: { id }, data })
  })
}

/** Upsert an Owner from Clerk user data — used during auth resolution and
 *  webhook-driven member sync. */
export function upsertOwnerFromClerk(
  orgId: string,
  clerkUserId: string,
  data: { name: string; email: string; role: string; avatarUrl?: string | null },
) {
  return prisma.owner.upsert({
    where: { orgId_clerkUserId: { orgId, clerkUserId } },
    create: {
      orgId,
      clerkUserId,
      name: data.name,
      email: data.email,
      role: data.role,
      avatarUrl: data.avatarUrl ?? null,
    },
    update: {
      name: data.name,
      email: data.email,
      // A role change (organizationMembership.updated) must reach the Owner row.
      role: data.role,
      avatarUrl: data.avatarUrl ?? null,
    },
  })
}
