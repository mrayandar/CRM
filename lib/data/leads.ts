// Server-only data access. Do not import this module from a Client
// Component — it pulls in `@prisma/client`, which only runs in Node.
import type { DealStage, LeadStatus, Priority, Prisma } from '@prisma/client'
import { prisma } from '@lib/prisma'

export interface ListLeadsOptions {
  status?: LeadStatus
  ownerId?: string
  search?: string
}

export function listLeads(options: ListLeadsOptions = {}) {
  const { status, ownerId, search } = options

  const where: Prisma.LeadWhereInput = {
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
    include: { owner: true },
    orderBy: { lastTouchedAt: 'desc' },
  })
}

export function getLeadById(id: string) {
  return prisma.lead.findUnique({
    where: { id },
    include: { owner: true, convertedDeal: true, convertedContact: true },
  })
}

export function createLead(data: Prisma.LeadCreateInput) {
  return prisma.lead.create({ data })
}

export function updateLeadStatus(id: string, status: LeadStatus) {
  return prisma.lead.update({
    where: { id },
    data: { status, lastTouchedAt: new Date() },
  })
}

/**
 * Converts a lead into a deal + contact in a single transaction, mirroring
 * `convertLead` in `src/store/crm.tsx` on the frontend mock store.
 */
export async function convertLeadToDeal(
  leadId: string,
  input: {
    dealName: string
    value: number
    stage: DealStage
    closeDate: Date
    ownerId: string
    priority: Priority
  },
) {
  return prisma.$transaction(async (tx) => {
    const lead = await tx.lead.findUniqueOrThrow({ where: { id: leadId } })

    const contact = await tx.contact.create({
      data: {
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

    const deal = await tx.deal.create({
      data: {
        name: input.dealName,
        company: lead.company,
        value: input.value,
        stage: input.stage,
        ownerId: input.ownerId,
        priority: input.priority,
        source: lead.source,
        probability: STAGE_PROBABILITY[input.stage] ?? 25,
        closeDate: input.closeDate,
        leadId: lead.id,
        contactId: contact.id,
      },
    })

    await tx.lead.update({
      where: { id: leadId },
      data: { status: 'qualified', lastTouchedAt: new Date() },
    })

    return { deal, contact }
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
