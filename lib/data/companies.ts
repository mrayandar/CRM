// Server-only data access. Do not import this module from a Client
// Component — it pulls in `@prisma/client`, which only runs in Node.
//
// Every function requires `orgId` as its first argument and includes it in
// every `where` clause. Never call these with an id alone — that would let
// a client that guessed/enumerated an id read across tenants.
import { prisma } from '@lib/prisma'

export interface ListCompaniesOptions {
  search?: string
  /** REQUIRED, not optional — an earlier version let this default to `undefined` when a caller
   *  forgot it, which silently fell through to the unscoped branch below and returned every
   *  rep's rollup counts. Every caller must now write `scopeOwnerId: null` explicitly for an
   *  unscoped (Admin / ALL-mode) read, so "I forgot to scope this" can never compile. Company
   *  identity (name/website/industry/notes) stays org-wide and unscoped regardless — shared
   *  company names are not per-rep data — only the rollup `_count` below is narrowed. Kept as a
   *  plain required field rather than a `Scope` object, since this module's call sites
   *  (companies aren't in Stage 1a's Scope-replacement list) still pass a bare orgId. */
  scopeOwnerId: string | null
}

export function listCompanies(orgId: string, options: ListCompaniesOptions) {
  const { search, scopeOwnerId } = options
  return prisma.company.findMany({
    where: {
      orgId,
      ...(search && { name: { contains: search, mode: 'insensitive' } }),
    },
    include: {
      _count: {
        select: {
          leads: scopeOwnerId ? { where: { ownerId: scopeOwnerId } } : true,
          contacts: scopeOwnerId ? { where: { ownerId: scopeOwnerId } } : true,
          deals: scopeOwnerId ? { where: { ownerId: scopeOwnerId } } : true,
        },
      },
    },
    orderBy: { name: 'asc' },
  })
}

export function getCompanyById(orgId: string, id: string) {
  return prisma.company.findFirst({ where: { id, orgId } })
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
