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
    return tx.deal.update({
      where: { id },
      data: { stage, probability },
    })
  })
}
