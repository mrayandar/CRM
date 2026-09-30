import { prisma } from '@lib/prisma'
import type { PlanTier } from '@prisma/client'

export function getOrgByClerkId(clerkOrgId: string) {
  return prisma.organization.findUnique({ where: { clerkOrgId } })
}

export function getOrgById(id: string) {
  return prisma.organization.findUnique({ where: { id } })
}

/**
 * Atomically create-or-return an Organization for a Clerk org.
 * Uses upsert so concurrent calls (on-demand auth sync racing the webhook,
 * or two simultaneous requests for the same new org) can never produce a
 * P2002 unique-constraint error. If the row already exists `update: {}`
 * is a no-op.
 */
export function upsertOrg(data: {
  clerkOrgId: string
  name: string
  plan?: PlanTier
}) {
  return prisma.organization.upsert({
    where: { clerkOrgId: data.clerkOrgId },
    create: {
      clerkOrgId: data.clerkOrgId,
      name: data.name,
      plan: data.plan ?? 'free',
    },
    update: {},          // no-op: the row already exists, keep what we have
  })
}

/** Kept for callers that explicitly know the org is new (e.g. tests). */
export function createOrg(data: {
  clerkOrgId: string
  name: string
  plan?: PlanTier
}) {
  return prisma.organization.create({
    data: {
      clerkOrgId: data.clerkOrgId,
      name: data.name,
      plan: data.plan ?? 'free',
    },
  })
}

export function updateOrg(
  clerkOrgId: string,
  data: { name?: string; plan?: PlanTier; stripeCustomerId?: string },
) {
  return prisma.organization.update({
    where: { clerkOrgId },
    data,
  })
}

export function deleteOrg(clerkOrgId: string) {
  return prisma.organization.delete({ where: { clerkOrgId } })
}

/**
 * Sets (or clears, with `null`) the org's quarterly revenue quota. `orgId` always comes from
 * `requireAuth()`'s own resolved org — never a client-supplied id — so this can only ever write
 * the caller's own organization; there's no separate tenant dimension to double-check here the
 * way there is for a sub-resource like an Owner or a Deal, since the org row itself is the
 * tenant boundary.
 */
export function updateOrgQuota(orgId: string, quarterlyQuota: number | null) {
  return prisma.organization.update({
    where: { id: orgId },
    data: { quarterlyQuota },
  })
}
