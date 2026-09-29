// Server-only data access. Do not import this module from a Client
// Component — it pulls in `@prisma/client`, which only runs in Node.
//
// Every function requires `orgId` as its first argument and includes it in
// every `where` clause. Never call these with an id alone — that would let
// a client that guessed/enumerated an id read across tenants.
import { prisma } from '@lib/prisma'

/** The 6 stages every org used to get for free from the old DealStage enum — now the seed for
 *  every org's own, editable PipelineStage rows. */
const DEFAULT_STAGES = [
  { key: 'discovery', label: 'Discovery', order: 0, probability: 20, isClosed: false, isWon: false },
  { key: 'proposal', label: 'Proposal', order: 1, probability: 45, isClosed: false, isWon: false },
  { key: 'negotiation', label: 'Negotiation', order: 2, probability: 65, isClosed: false, isWon: false },
  { key: 'contract', label: 'Contract Sent', order: 3, probability: 85, isClosed: false, isWon: false },
  { key: 'won', label: 'Won', order: 4, probability: 100, isClosed: true, isWon: true },
  { key: 'lost', label: 'Lost', order: 5, probability: 0, isClosed: true, isWon: false },
] as const

export function listStages(orgId: string) {
  return prisma.pipelineStage.findMany({ where: { orgId }, orderBy: { order: 'asc' } })
}

export function getStageById(orgId: string, id: string) {
  return prisma.pipelineStage.findFirst({ where: { id, orgId } })
}

/** Idempotent: seeds the 6 default stages for an org that has none yet. Called on org creation
 *  (both the on-demand path in resolveAuth() and the Clerk webhook's organization.created), and
 *  safe to call again — a no-op once the org already has stages. */
export async function ensureDefaultStages(orgId: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.pipelineStage.count({ where: { orgId } })
    if (existing > 0) return
    await tx.pipelineStage.createMany({
      data: DEFAULT_STAGES.map((s) => ({ ...s, orgId })),
    })
  })
}

export interface CreateStageInput {
  id: string
  label: string
}

/** New stages are always open (not closed/won) and always sort right before the first closed
 *  stage — Won/Lost stay pinned as the last two columns, same as the old fixed enum order. */
export async function createStage(orgId: string, input: CreateStageInput) {
  return prisma.$transaction(async (tx) => {
    const stages = await tx.pipelineStage.findMany({ where: { orgId }, orderBy: { order: 'asc' } })
    const firstClosedIndex = stages.findIndex((s) => s.isClosed)
    const insertAt = firstClosedIndex === -1 ? stages.length : firstClosedIndex

    // Make room: every stage from insertAt onward shifts up by one.
    for (let i = stages.length - 1; i >= insertAt; i--) {
      await tx.pipelineStage.update({ where: { id: stages[i]!.id }, data: { order: i + 1 } })
    }

    return tx.pipelineStage.create({
      data: {
        id: input.id,
        orgId,
        key: input.id,
        label: input.label,
        order: insertAt,
        probability: 50,
        isClosed: false,
        isWon: false,
      },
    })
  })
}

/** Renames a stage. Order/isClosed/isWon are structural (only set at creation/seeding) and are
 *  not editable through this — see reorderStages for moving a stage. */
export async function renameStage(orgId: string, id: string, label: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.pipelineStage.findFirst({ where: { id, orgId } })
    if (!existing) throw new Error(`Stage ${id} not found in org ${orgId}`)
    if (existing.label === label) return existing
    return tx.pipelineStage.update({ where: { id }, data: { label } })
  })
}

/** Moves an open (non-closed) stage up or down by one position among the other open stages.
 *  Closed stages (Won/Lost) always stay pinned after every open stage, so they're not
 *  reachable through this — and an open stage can never be moved past them. */
export async function reorderStage(orgId: string, id: string, direction: 'up' | 'down') {
  return prisma.$transaction(async (tx) => {
    const stages = await tx.pipelineStage.findMany({ where: { orgId }, orderBy: { order: 'asc' } })
    const openStages = stages.filter((s) => !s.isClosed)
    const index = openStages.findIndex((s) => s.id === id)
    if (index === -1) throw new Error(`Open stage ${id} not found in org ${orgId}`)

    const swapWith = direction === 'up' ? index - 1 : index + 1
    if (swapWith < 0 || swapWith >= openStages.length) return openStages[index]

    const a = openStages[index]!
    const b = openStages[swapWith]!
    await tx.pipelineStage.update({ where: { id: a.id }, data: { order: b.order } })
    await tx.pipelineStage.update({ where: { id: b.id }, data: { order: a.order } })
    return { ...a, order: b.order }
  })
}

/** Blocks deletion outright if the stage is closed (Won/Lost are structural, not deletable),
 *  if it's the last remaining open stage (there must always be somewhere for an open deal to
 *  sit), or if any deal currently occupies it — never silently orphans a deal onto a deleted
 *  stage. */
export async function deleteStage(orgId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.pipelineStage.findFirst({ where: { id, orgId } })
    if (!existing) throw new Error(`Stage ${id} not found in org ${orgId}`)
    if (existing.isClosed) throw new Error('The Won/Lost stages cannot be deleted')

    const openCount = await tx.pipelineStage.count({ where: { orgId, isClosed: false } })
    if (openCount <= 1) throw new Error('An org must have at least one open stage')

    const dealCount = await tx.deal.count({ where: { orgId, stageId: id } })
    if (dealCount > 0) {
      throw new Error(
        `${dealCount} ${dealCount === 1 ? 'deal is' : 'deals are'} still in this stage — move ${dealCount === 1 ? 'it' : 'them'} first`,
      )
    }

    await tx.pipelineStage.delete({ where: { id } })
  })
}
