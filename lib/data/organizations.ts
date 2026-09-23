import { prisma } from '@lib/prisma'
import type { PlanTier } from '@prisma/client'

export function getOrgByClerkId(clerkOrgId: string) {
  return prisma.organization.findUnique({ where: { clerkOrgId } })
}

export function getOrgById(id: string) {
  return prisma.organization.findUnique({ where: { id } })
}

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
