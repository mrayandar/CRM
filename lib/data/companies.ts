// Server-only data access. Do not import this module from a Client
// Component — it pulls in `@prisma/client`, which only runs in Node.
//
// Every function requires `orgId` as its first argument and includes it in
// every `where` clause. Never call these with an id alone — that would let
// a client that guessed/enumerated an id read across tenants.
import { prisma } from '@lib/prisma'

export interface ListCompaniesOptions {
  search?: string
}

export function listCompanies(orgId: string, options: ListCompaniesOptions = {}) {
  const { search } = options
  return prisma.company.findMany({
    where: {
      orgId,
      ...(search && { name: { contains: search, mode: 'insensitive' } }),
    },
    include: { _count: { select: { leads: true, contacts: true, deals: true } } },
    orderBy: { name: 'asc' },
  })
}

export function getCompanyById(orgId: string, id: string) {
  return prisma.company.findFirst({ where: { id, orgId } })
}

/** Full detail view: the company plus every Lead/Contact/Deal linked to it. */
export function getCompanyDetail(orgId: string, id: string) {
  return prisma.company.findFirst({
    where: { id, orgId },
    include: {
      leads: { include: { owner: true } },
      contacts: { include: { owner: true } },
      deals: { include: { owner: true, stage: true } },
    },
  })
}

/** Case-insensitive lookup within one org; used so the inline create-or-select picker doesn't
 *  create a second row for a name that (modulo case) already exists. */
export function getCompanyByName(orgId: string, name: string) {
  return prisma.company.findFirst({
    where: { orgId, name: { equals: name, mode: 'insensitive' } },
  })
}

export function createCompany(
  orgId: string,
  data: { id: string; name: string; website?: string; industry?: string; notes?: string },
) {
  return prisma.company.create({ data: { ...data, orgId } })
}

export interface UpdateCompanyInput {
  name: string
  website?: string
  industry?: string
  notes?: string
}

export async function updateCompany(orgId: string, id: string, data: UpdateCompanyInput) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.company.findFirst({ where: { id, orgId } })
    if (!existing) throw new Error(`Company ${id} not found in org ${orgId}`)

    const changed =
      existing.name !== data.name ||
      (existing.website ?? '') !== (data.website ?? '') ||
      (existing.industry ?? '') !== (data.industry ?? '') ||
      (existing.notes ?? '') !== (data.notes ?? '')
    if (!changed) return existing

    return tx.company.update({ where: { id }, data })
  })
}

/**
 * Deletion is blocked (not soft-deleted) while any Lead, Contact, or Deal is still linked to this
 * company — checked explicitly here (rather than letting the DB's ON DELETE RESTRICT throw a raw
 * constraint error) so the caller gets a clear, actionable message.
 */
export async function deleteCompany(orgId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.company.findFirst({ where: { id, orgId } })
    if (!existing) throw new Error(`Company ${id} not found in org ${orgId}`)

    const [leads, contacts, deals] = await Promise.all([
      tx.lead.count({ where: { companyId: id } }),
      tx.contact.count({ where: { companyId: id } }),
      tx.deal.count({ where: { companyId: id } }),
    ])
    const linked = leads + contacts + deals
    if (linked > 0) {
      throw new Error(
        `Can't delete this company — it's still linked to ${linked} record${linked === 1 ? '' : 's'}. Unlink or reassign them first.`,
      )
    }

    await tx.company.delete({ where: { id } })
  })
}
