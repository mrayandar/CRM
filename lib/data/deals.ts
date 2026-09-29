// Server-only data access. Do not import this module from a Client
// Component — it pulls in `@prisma/client`, which only runs in Node.
//
// Every function requires `orgId` as its first argument and includes it in
// every `where` clause. Never call these with an id alone — that would let
// a client that guessed/enumerated an id read across tenants.
import type { DealStage, Prisma } from '@prisma/client'
import { prisma } from '@lib/prisma'

export interface ListDealsOptions {
  stage?: DealStage
  ownerId?: string
  search?: string
}

export function listDeals(orgId: string, options: ListDealsOptions = {}) {
  const { stage, ownerId, search } = options

  const where: Prisma.DealWhereInput = {
    orgId,
    ...(stage && { stage }),
    ...(ownerId && { ownerId }),
    ...(search && {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { company: { contains: search, mode: 'insensitive' } },
      ],
    }),
  }

  return prisma.deal.findMany({
    where,
    include: { owner: true, contact: true },
    orderBy: { value: 'desc' },
  })
}

/** Deal count + total value per stage — backs the pipeline board's column headers. */
export async function getPipelineTotals(orgId: string) {
  const grouped = await prisma.deal.groupBy({
    by: ['stage'],
    where: { orgId },
    _count: { _all: true },
    _sum: { value: true },
  })

  return grouped.map((row) => ({
    stage: row.stage,
    count: row._count._all,
    totalValue: row._sum.value ?? 0,
  }))
}

export function getDealById(orgId: string, id: string) {
  return prisma.deal.findFirst({
    where: { id, orgId },
    include: { owner: true, contact: true, lead: true },
  })
}

export function createDeal(
  orgId: string,
  data: Omit<Prisma.DealCreateInput, 'orgId'>,
) {
  return prisma.deal.create({ data: { ...data, orgId } })
}

/**
 * Whether entering `nextStage` from `previousStage` should stamp the close date to now (it becomes
 * the *actual* close date once a deal is won — see "Won this month" on the dashboard). Leaving Won
 * preserves whatever the date currently is: closeDate is non-nullable and the previous expected date
 * isn't stored, so there's nothing better to restore. Shared by moveDealToStage (drag) and updateDeal
 * (edit modal) so a stage change is stamped identically regardless of how it was made.
 */
function closeDateOnStageChange(previousStage: DealStage, nextStage: DealStage): Date | undefined {
  return nextStage === 'won' && previousStage !== 'won' ? new Date() : undefined
}

/** Moves a deal to a new stage — what a kanban drag-and-drop drop handler would call. */
export async function moveDealToStage(
  orgId: string,
  id: string,
  stage: DealStage,
  probability: number,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.deal.findFirst({ where: { id, orgId } })
    if (!existing) throw new Error(`Deal ${id} not found in org ${orgId}`)
    const closeDate = closeDateOnStageChange(existing.stage, stage)
    return tx.deal.update({
      where: { id },
      data: { stage, probability, ...(closeDate && { closeDate }) },
    })
  })
}

export interface UpdateDealInput {
  name: string
  value: number
  stage: DealStage
  probability: number
  closeDate: Date
  contactId: string | null
  ownerId: string
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

    // The submitted close date is honored unless the stage change forces "now" — same precedence
    // moveDealToStage applies, just computed here instead of by a second, potentially-diverging copy.
    const stampedCloseDate = closeDateOnStageChange(existing.stage, data.stage)
    const closeDate = stampedCloseDate ?? data.closeDate

    const changed: string[] = []
    if (existing.name !== data.name) changed.push('name')
    if (existing.value !== data.value) changed.push('value')
    if (existing.stage !== data.stage) changed.push('stage')
    if (+existing.closeDate !== +closeDate) changed.push('close date')
    if (existing.contactId !== data.contactId) changed.push('contact')
    if (existing.ownerId !== data.ownerId) changed.push('owner')

    if (changed.length === 0) return existing

    const updated = await tx.deal.update({
      where: { id },
      data: {
        name: data.name,
        value: data.value,
        stage: data.stage,
        probability: data.probability,
        closeDate,
        contactId: data.contactId,
        ownerId: data.ownerId,
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
