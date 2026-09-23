// Server-only data access. Do not import this module from a Client
// Component — it pulls in `@prisma/client`, which only runs in Node.
//
// Every function requires `orgId` as its first argument and includes it in
// every `where` clause. Never call these with an id alone — that would let
// a client that guessed/enumerated an id read across tenants.
import type { DealStage, LeadStatus, Priority, Prisma } from '@prisma/client'
import { prisma } from '@lib/prisma'

export interface ListLeadsOptions {
  status?: LeadStatus
  ownerId?: string
  search?: string
}

export function listLeads(orgId: string, options: ListLeadsOptions = {}) {
  const { status, ownerId, search } = options

  const where: Prisma.LeadWhereInput = {
    orgId,
    ...(status && { status }),
    ...(ownerId && { ownerId }),
    ...(search && {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { company: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ],
    }),
  }

  return prisma.lead.findMany({
    where,
    include: { owner: true, convertedDeal: { select: { id: true } } },
    orderBy: { lastTouchedAt: 'desc' },
  })
}

export function getLeadById(orgId: string, id: string) {
  return prisma.lead.findFirst({
    where: { id, orgId },
    include: { owner: true, convertedDeal: true, convertedContact: true },
  })
}

export function createLead(
  orgId: string,
  data: Omit<Prisma.LeadCreateInput, 'orgId'>,
) {
  return prisma.lead.create({ data: { ...data, orgId } })
}

export async function updateLeadStatus(
  orgId: string,
  id: string,
  status: LeadStatus,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.lead.findFirst({ where: { id, orgId } })
    if (!existing) throw new Error(`Lead ${id} not found in org ${orgId}`)
    return tx.lead.update({
      where: { id },
      data: { status, lastTouchedAt: new Date() },
    })
  })
}

/** Optional deal-creation piece of a lead conversion. */
export interface ConvertLeadDealInput {
  name: string
  value: number
  stage: DealStage
  closeDate: Date
  priority: Priority
}

/**
 * Converts a lead — always creates a Contact (and marks the lead qualified);
 * additionally creates a Deal only when `deal` is provided. Mirrors
 * `convertLead` in `src/store/crm.tsx` on the frontend mock store.
 */
export async function convertLeadToDeal(
  orgId: string,
  leadId: string,
  input: {
    ownerId: string
    /** Omit to convert to a Contact only. Provide to also open a Deal. */
    deal?: ConvertLeadDealInput
  },
) {
  return prisma.$transaction(async (tx) => {
    const lead = await tx.lead.findFirst({ where: { id: leadId, orgId } })
    if (!lead) throw new Error(`Lead ${leadId} not found in org ${orgId}`)

    const contact = await tx.contact.create({
      data: {
        orgId,
        name: lead.name,
        title: lead.title,
        company: lead.company,
        email: lead.email,
        phone: lead.phone,
        ownerId: input.ownerId,
        originLeadId: lead.id,
        tags: ['Converted lead', lead.source],
        lifecycle: 'Prospect',
        location: lead.location,
      },
    })

    let deal: Awaited<ReturnType<typeof tx.deal.create>> | null = null
    if (input.deal) {
      deal = await tx.deal.create({
        data: {
          orgId,
          name: input.deal.name,
          company: lead.company,
          value: input.deal.value,
          stage: input.deal.stage,
          ownerId: input.ownerId,
          priority: input.deal.priority,
          source: lead.source,
          probability: STAGE_PROBABILITY[input.deal.stage] ?? 25,
          closeDate: input.deal.closeDate,
          leadId: lead.id,
          contactId: contact.id,
        },
      })
    }

    await tx.lead.update({
      where: { id: leadId },
      data: { status: 'qualified', lastTouchedAt: new Date() },
    })

    return { contact, deal }
  })
}

const STAGE_PROBABILITY: Record<string, number> = {
  discovery: 20,
  proposal: 45,
  negotiation: 65,
  contract: 85,
  won: 100,
  lost: 0,
}
