import { prisma } from '@lib/prisma'
import type { PlanTier, RepVisibility } from '@prisma/client'

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

/**
 * Sets the org's display currency (relabels amounts, never converts them — see the model doc
 * comment). Same `orgId`-from-`requireAuth()` reasoning as `updateOrgQuota`: there's no separate
 * tenant id to double-check here, the org row itself is the tenant boundary. The admin-only check
 * happens one layer up, in the action (`requireAdmin()`), not here.
 */
export function updateOrgCurrency(orgId: string, currency: string) {
  return prisma.organization.update({
    where: { id: orgId },
    data: { currency },
  })
}

/** Sets the org's business-period timezone (won this month, quarter-to-date quota, monthly
 *  charts, MoM, closing in 30 days — see lib/timePeriods.ts) AND marks it as a real, deliberate
 *  choice (`timezoneConfigured: true`) — the only way that flag ever becomes true. Same
 *  orgId/admin-only reasoning as updateOrgCurrency. */
export function updateOrgTimezone(orgId: string, timezone: string) {
  return prisma.organization.update({
    where: { id: orgId },
    data: { timezone, timezoneConfigured: true },
  })
}

/** Sets the org's `RepVisibility` AND stamps who changed it and when — the only writer of
 *  `repVisibilityChangedBy`/`repVisibilityChangedAt`. `changedByOwnerId` is the caller's own id
 *  (from `requireLiveAdminAccess()`'s session), never a client-supplied value. Same
 *  orgId-from-auth reasoning as updateOrgCurrency/updateOrgTimezone — the admin-only check
 *  happens one layer up, in the action. */
export function updateRepVisibility(orgId: string, repVisibility: RepVisibility, changedByOwnerId: string) {
  return prisma.organization.update({
    where: { id: orgId },
    data: { repVisibility, repVisibilityChangedBy: changedByOwnerId, repVisibilityChangedAt: new Date() },
  })
}

/** Sets the org's `aiAssistEnabled` AND stamps who changed it and when — the only writer of
 *  `aiAssistEnabledChangedBy`/`aiAssistEnabledChangedAt`. Same orgId-from-auth, caller-id-not-
 *  client-supplied reasoning as updateRepVisibility — the admin-only + allowlist checks happen
 *  one layer up, in updateAiAssistEnabledAction. */
export function updateAiAssistEnabled(orgId: string, enabled: boolean, changedByOwnerId: string) {
  return prisma.organization.update({
    where: { id: orgId },
    data: { aiAssistEnabled: enabled, aiAssistEnabledChangedBy: changedByOwnerId, aiAssistEnabledChangedAt: new Date() },
  })
}
