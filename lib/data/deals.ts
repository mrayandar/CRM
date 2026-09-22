// Server-only data access. Do not import this module from a Client
// Component — it pulls in `@prisma/client`, which only runs in Node.
import type { DealStage, Prisma } from '@prisma/client'
import { prisma } from '@lib/prisma'

export interface ListDealsOptions {
  stage?: DealStage
  ownerId?: string
  search?: string
}

export function listDeals(options: ListDealsOptions = {}) {
  const { stage, ownerId, search } = options

  const where: Prisma.DealWhereInput = {
    ...(stage && { stage }),
    ...(ownerId && { ownerId }),
    ...(search && {
      OR: [{ name: { contains: search, mode: 'insensitive' } }, { company: { contains: search, mode: 'insensitive' } }],
    }),
  }

  return prisma.deal.findMany({
    where,
    include: { owner: true, contact: true },
    orderBy: { value: 'desc' },
  })
}

/** Deal count + total value per stage — backs the pipeline board's column headers. */
export async function getPipelineTotals() {
  const grouped = await prisma.deal.groupBy({
    by: ['stage'],
    _count: { _all: true },
    _sum: { value: true },
  })

  return grouped.map((row) => ({
    stage: row.stage,
    count: row._count._all,
    totalValue: row._sum.value ?? 0,
  }))
}

export function getDealById(id: string) {
  return prisma.deal.findUnique({
    where: { id },
    include: { owner: true, contact: true, lead: true },
  })
}

export function createDeal(data: Prisma.DealCreateInput) {
  return prisma.deal.create({ data })
}

/** Moves a deal to a new stage — what a kanban drag-and-drop drop handler would call. */
export function moveDealToStage(id: string, stage: DealStage, probability: number) {
  return prisma.deal.update({
    where: { id },
    data: { stage, probability },
  })
}
