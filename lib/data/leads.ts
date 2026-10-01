// Server-only data access. Do not import this module from a Client
// Component — it pulls in `@prisma/client`, which only runs in Node.
//
// Every function requires `orgId` as its first argument and includes it in
// every `where` clause. Never call these with an id alone — that would let
// a client that guessed/enumerated an id read across tenants.
import type { LeadSource, LeadStatus, Priority, Prisma } from '@prisma/client'
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
        { company: { name: { contains: search, mode: 'insensitive' } } },
        { email: { contains: search, mode: 'insensitive' } },
      ],
    }),
  }

  return prisma.lead.findMany({
    where,
    include: {
      owner: true,
      company: true,
      convertedDeal: { select: { id: true } },
      convertedContact: { select: { id: true } },
    },
    orderBy: { lastTouchedAt: 'desc' },
  })
}

export function getLeadById(orgId: string, id: string) {
  return prisma.lead.findFirst({
    where: { id, orgId },
    include: { owner: true, company: true, convertedDeal: true, convertedContact: true },
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

export interface UpdateLeadInput {
  name: string
  title: string
  email: string
  phone: string
  companyId: string
  source: LeadSource
  ownerId: string
}

/**
 * Updates the lead's own editable fields (not its status/conversion), bumps lastTouchedAt, and logs
 * an "edited" activity with a short summary of which fields actually changed — all in one
 * transaction, so a failed write can never leave an orphan activity. A no-op save (nothing actually
 * differs) skips the write and the activity entirely, rather than bumping lastTouchedAt and logging
 * an empty "edited" entry for a save that changed nothing.
 */
export async function updateLead(orgId: string, id: string, data: UpdateLeadInput, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.lead.findFirst({ where: { id, orgId } })
    if (!existing) throw new Error(`Lead ${id} not found in org ${orgId}`)

    const changed: string[] = []
    if (existing.name !== data.name) changed.push('name')
    if (existing.title !== data.title) changed.push('title')
    if (existing.email !== data.email) changed.push('email')
    if (existing.phone !== data.phone) changed.push('phone')
    if (existing.companyId !== data.companyId) changed.push('company')
    if (existing.source !== data.source) changed.push('source')
    if (existing.ownerId !== data.ownerId) changed.push('owner')

    if (changed.length === 0) return existing

    const updated = await tx.lead.update({
      where: { id },
      data: { ...data, lastTouchedAt: new Date() },
    })

    await tx.activity.create({
      data: {
        orgId,
        kind: 'edited',
        title: `edited ${updated.name}`,
        body: `Changed: ${changed.join(', ')}`,
        actorId,
        subjectType: 'lead',
        subjectLabel: updated.name,
        leadId: id,
      },
    })

    return updated
  })
}

/** Optional deal-creation piece of a lead conversion. `stage` must already be tenant-checked by
 *  the caller (getStageById), same convention as ownerId. */
export interface ConvertLeadDealInput {
  name: string
  value: number
  stage: { id: string; probability: number }
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
    /** Who performed the conversion (for the activity entry). */
    actorId: string
    /** Client-generated ids so the optimistic UI rows are the real rows. */
    contactId?: string
    dealId?: string
    /** Omit to convert to a Contact only. Provide to also open a Deal. */
    deal?: ConvertLeadDealInput
  },
) {
  return prisma.$transaction(async (tx) => {
    const lead = await tx.lead.findFirst({ where: { id: leadId, orgId } })
    if (!lead) throw new Error(`Lead ${leadId} not found in org ${orgId}`)

    const contact = await tx.contact.create({
      data: {
        ...(input.contactId && { id: input.contactId }),
        orgId,
        name: lead.name,
        title: lead.title,
        companyId: lead.companyId,
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
          ...(input.dealId && { id: input.dealId }),
          orgId,
          name: input.deal.name,
          companyId: lead.companyId,
          value: input.deal.value,
          stageId: input.deal.stage.id,
          ownerId: input.ownerId,
          priority: input.deal.priority,
          source: lead.source,
          probability: input.deal.stage.probability,
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

    await tx.activity.create({
      data: {
        orgId,
        kind: 'created',
        title: input.deal
          ? `converted ${lead.name} into ${input.deal.name}`
          : `converted ${lead.name} to a contact`,
        actorId: input.actorId,
        subjectType: 'lead',
        subjectLabel: lead.name,
        leadId: lead.id,
      },
    })

    return { contact, deal }
  })
}
