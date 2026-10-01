// Server-only data access. Do not import this module from a Client
// Component — it pulls in `@prisma/client`, which only runs in Node.
//
// Every function requires `orgId` as its first argument and includes it in
// every `where` clause. Never call these with an id alone — that would let
// a client that guessed/enumerated an id read across tenants.
import type { Prisma } from '@prisma/client'
import { prisma } from '@lib/prisma'

/** A stage already resolved (and tenant-checked via getStageById) by the caller — mirrors how
 *  ownerId/contactId are handled: the action validates it belongs to this org, this module trusts
 *  that and just uses the fields it needs. */
export interface ResolvedStage {
  id: string
  probability: number
  isWon: boolean
}

export interface ListDealsOptions {
  stageId?: string
  ownerId?: string
  search?: string
}

export function listDeals(orgId: string, options: ListDealsOptions = {}) {
  const { stageId, ownerId, search } = options

  const where: Prisma.DealWhereInput = {
    orgId,
    ...(stageId && { stageId }),
    ...(ownerId && { ownerId }),
    ...(search && {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { company: { name: { contains: search, mode: 'insensitive' } } },
      ],
    }),
  }

  return prisma.deal.findMany({
    where,
    include: { owner: true, contact: true, stage: true, company: true },
    orderBy: { value: 'desc' },
  })
}

/** Deal count + total value per stage — backs the pipeline board's column headers. Currently
 *  unused (the UI computes this client-side from the loaded deals), kept for parity with the
 *  old enum-based version. */
export async function getPipelineTotals(orgId: string) {
  const grouped = await prisma.deal.groupBy({
    by: ['stageId'],
    where: { orgId },
    _count: { _all: true },
    _sum: { value: true },
  })

  return grouped.map((row) => ({
    stageId: row.stageId,
    count: row._count._all,
    totalValue: row._sum.value ?? 0,
  }))
}

export function getDealById(orgId: string, id: string) {
  return prisma.deal.findFirst({
    where: { id, orgId },
    include: { owner: true, contact: true, lead: true, stage: true, company: true },
  })
}

export function createDeal(
  orgId: string,
  data: Omit<Prisma.DealCreateInput, 'orgId'>,
) {
  return prisma.deal.create({ data: { ...data, orgId } })
}

/**
 * Whether moving into a stage flagged `isWon` from one that wasn't should stamp the close date to
 * now (it becomes the *actual* close date once a deal is won — see "Won this month" on the
 * dashboard). Leaving a Won stage preserves whatever the date currently is: closeDate is
 * non-nullable and the previous expected date isn't stored, so there's nothing better to restore.
 * Checks the stage's `isWon` flag rather than comparing against a hardcoded stage id/key, so a
 * renamed or custom "Won"-equivalent stage still triggers this correctly. Shared by
 * moveDealToStage (drag) and updateDeal (edit modal) so a stage change is stamped identically
 * regardless of how it was made.
 */
function closeDateOnStageChange(previousIsWon: boolean, nextIsWon: boolean): Date | undefined {
  return nextIsWon && !previousIsWon ? new Date() : undefined
}

/** Moves a deal to a new stage — what a kanban drag-and-drop drop handler would call. `stage`
 *  must already be tenant-checked by the caller (getStageById), same convention as owner/contact. */
export async function moveDealToStage(orgId: string, id: string, stage: ResolvedStage) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.deal.findFirst({ where: { id, orgId } })
    if (!existing) throw new Error(`Deal ${id} not found in org ${orgId}`)
    // The deal's own current stageId already belongs to this org (it was written by a
    // tenant-checked call when the deal was created/last moved), so this lookup needs no
    // additional orgId check — it's not client input.
    const previousStage = await tx.pipelineStage.findUnique({ where: { id: existing.stageId } })
    const closeDate = closeDateOnStageChange(previousStage?.isWon ?? false, stage.isWon)
    return tx.deal.update({
      where: { id },
      data: { stageId: stage.id, probability: stage.probability, ...(closeDate && { closeDate }) },
    })
  })
}

export interface UpdateDealInput {
  name: string
  value: number
  stage: ResolvedStage
  closeDate: Date
  contactId: string | null
  ownerId: string
  companyId: string
}

/**
 * Updates the deal's own editable fields, and logs an "edited" activity with a short summary of
 * which fields actually changed — all in one transaction, so a failed write can never leave an
 * orphan activity. A no-op save (nothing actually differs) skips the write and the activity
 * entirely. If `stage` changes, the close date follows the exact same rule moveDealToStage uses
 * (via the shared closeDateOnStageChange), not a separately re-derived one — so a stage change made
 * through this edit modal behaves identically to one made by dragging the card.
 */
export async function updateDeal(orgId: string, id: string, data: UpdateDealInput, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.deal.findFirst({ where: { id, orgId } })
    if (!existing) throw new Error(`Deal ${id} not found in org ${orgId}`)

    const previousStage = await tx.pipelineStage.findUnique({ where: { id: existing.stageId } })

    // The submitted close date is honored unless the stage change forces "now" — same precedence
    // moveDealToStage applies, just computed here instead of by a second, potentially-diverging copy.
    const stampedCloseDate = closeDateOnStageChange(previousStage?.isWon ?? false, data.stage.isWon)
    const closeDate = stampedCloseDate ?? data.closeDate

    const changed: string[] = []
    if (existing.name !== data.name) changed.push('name')
    if (existing.value !== data.value) changed.push('value')
    if (existing.stageId !== data.stage.id) changed.push('stage')
    if (+existing.closeDate !== +closeDate) changed.push('close date')
    if (existing.contactId !== data.contactId) changed.push('contact')
    if (existing.ownerId !== data.ownerId) changed.push('owner')
    if (existing.companyId !== data.companyId) changed.push('company')

    if (changed.length === 0) return existing

    const updated = await tx.deal.update({
      where: { id },
      data: {
        name: data.name,
        value: data.value,
        stageId: data.stage.id,
        probability: data.stage.probability,
        closeDate,
        contactId: data.contactId,
        ownerId: data.ownerId,
        companyId: data.companyId,
      },
    })

    await tx.activity.create({
      data: {
        orgId,
        kind: 'edited',
        title: `edited ${updated.name}`,
        body: `Changed: ${changed.join(', ')}`,
        actorId,
        subjectType: 'deal',
        subjectLabel: updated.name,
        dealId: id,
      },
    })

    return updated
  })
}
