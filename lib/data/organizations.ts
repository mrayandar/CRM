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
