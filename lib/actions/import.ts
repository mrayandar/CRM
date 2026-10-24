'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@lib/auth'
import { tryAdminSession, FORBIDDEN, type ForbiddenResult } from '@lib/actions/shared'
import { getImportBatchById, markBatchUndone, undoImportBatch, UNDO_WINDOW_MS } from '@lib/data/import'
import { prisma } from '@lib/prisma'

/**
 * Admin-only, same tier as deleteCompanyAction/deleteStageAction — reversing a bulk import is as
 * consequential as any other admin-gated destructive action. Returns a typed result rather than
 * throwing for every rejection reason (not found, outside the 24h window, already undone), not
 * just the auth check — a client needs to tell these apart, and Next redacts a thrown Server
 * Action error's message in production either way (see lib/actions/shared.ts).
 */
export async function undoImportBatchAction(
  batchId: string,
): Promise<{ ok: true; removed: number; kept: number } | { ok: false; error: string } | ForbiddenResult> {
  const session = await tryAdminSession(requireAdmin)
  if (!session) return FORBIDDEN

  const batch = await getImportBatchById(session.orgId, batchId)
  if (!batch) return { ok: false, error: "This import wasn't found." }
  if (batch.undoneAt) return { ok: false, error: 'This import has already been undone.' }
  if (!batch.committedAt) return { ok: false, error: "This import hasn't finished yet." }
  if (Date.now() - batch.createdAt.getTime() > UNDO_WINDOW_MS) {
    return { ok: false, error: 'This import is more than 24 hours old and can no longer be undone.' }
  }

  const { removed, kept } = await undoImportBatch({ id: batch.id, orgId: batch.orgId, entityType: batch.entityType })
  await markBatchUndone(batch.id, session.ownerId)
  revalidatePath('/', 'layout')
  return { ok: true, removed, kept }
}

export interface OrgRecordCounts {
  leads: number
  contacts: number
  deals: number
  tasks: number
  activities: number
  companies: number
}

/**
 * Admin-only, own org only — see PROGRESS.md's CSV-import entry for why this isn't a cross-org
 * platform view (no such role exists in this app; see scripts/org-counts.js for the operator's
 * own cross-org tool instead).
 */
export async function getOrgRecordCountsAction(): Promise<{ ok: true; counts: OrgRecordCounts } | ForbiddenResult> {
  const session = await tryAdminSession(requireAdmin)
  if (!session) return FORBIDDEN

  const [leads, contacts, deals, tasks, activities, companies] = await Promise.all([
    prisma.lead.count({ where: { orgId: session.orgId } }),
    prisma.contact.count({ where: { orgId: session.orgId } }),
    prisma.deal.count({ where: { orgId: session.orgId } }),
    prisma.task.count({ where: { orgId: session.orgId } }),
    prisma.activity.count({ where: { orgId: session.orgId } }),
    prisma.company.count({ where: { orgId: session.orgId } }),
  ])

  return { ok: true, counts: { leads, contacts, deals, tasks, activities, companies } }
}
