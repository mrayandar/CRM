import { NextResponse } from 'next/server'
import { requireAuth } from '@lib/auth'
import { commitImportChunk, getOpenImportBatch, recordChunkResults, type DuplicateStrategy, type ImportMapping, type ImportRowInput } from '@lib/data/import'
import type { ImportEntityType } from '@prisma/client'

/**
 * Processes one chunk of an already-created import batch (see POST /api/import/batches) and
 * writes real rows — the one endpoint in this feature that isn't read-only. Route Handler, same
 * reasoning as the rest of the import endpoints.
 *
 * Couldn't reach a deployed Vercel preview for this measurement: previews are behind Vercel's
 * deployment-protection wall, and generating a bypass secret would have weakened that protection
 * project-wide — out of scope to decide unilaterally, so that door was left closed.
 *
 * Measured directly against the real production Neon DB instead (same write path, same
 * database, just without the deployed edge network in front of it): creating one lead with its
 * nested "created" activity took 2.0-4.3s across 20 consecutive calls (median 2.7s, mean 2.8s) —
 * not network noise, this is genuine write-path cost from Lead's two GIN trigram indexes
 * (name/email search) being maintained on every insert, on a leads table that has grown past
 * 5,000 rows from accumulated use. A full commitImportChunk row (existence check + duplicate
 * lookup + the create) measured ~3.6s/row end to end. This means every lead/contact creation in
 * this app already pays this cost today, not just bulk import — worth a dedicated look
 * independent of this feature; not something to fix inside this change (see PROGRESS.md).
 *
 * MAX_CHUNK_ROWS is sized from that real number with margin, not guessed: 10 rows × ~3.6s ≈ 36s,
 * comfortably inside a 60s maxDuration even with slower rows or a cold start. A consequence worth
 * being explicit about: a full 2,000-row import is ~200 sequential chunk requests, which at this
 * measured rate is on the order of two hours of real wall-clock time — which is exactly why the
 * approved design's progress bar isn't just a nice-to-have, it's load-bearing UX here.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }
const ENTITY_TYPES: ImportEntityType[] = ['lead', 'contact']
const DUPLICATE_STRATEGIES: DuplicateStrategy[] = ['skip', 'update', 'create']
const MAX_CHUNK_ROWS = 10

interface CommitBody {
  batchId: string
  entityType: ImportEntityType
  mapping: ImportMapping
  duplicateStrategy: DuplicateStrategy
  rows: ImportRowInput[]
  isFinalChunk: boolean
}

function isValidRows(rows: unknown): rows is ImportRowInput[] {
  return (
    Array.isArray(rows) &&
    rows.length > 0 &&
    rows.length <= MAX_CHUNK_ROWS &&
    rows.every(
      (r) =>
        r &&
        typeof r.rowNumber === 'number' &&
        typeof r.id === 'string' &&
        Array.isArray(r.cells) &&
        r.cells.every((c: unknown) => typeof c === 'string'),
    )
  )
}

export async function POST(request: Request) {
  let session: Awaited<ReturnType<typeof requireAuth>>
  try {
    session = await requireAuth()
  } catch {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401, headers: NO_STORE_HEADERS })
  }

  let body: CommitBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400, headers: NO_STORE_HEADERS })
  }

  if (
    typeof body.batchId !== 'string' ||
    !ENTITY_TYPES.includes(body.entityType) ||
    !DUPLICATE_STRATEGIES.includes(body.duplicateStrategy) ||
    typeof body.mapping !== 'object' ||
    body.mapping === null ||
    !isValidRows(body.rows) ||
    typeof body.isFinalChunk !== 'boolean'
  ) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400, headers: NO_STORE_HEADERS })
  }

  const batch = await getOpenImportBatch(session.orgId, session.ownerId, body.batchId)
  if (!batch || batch.entityType !== body.entityType) {
    return NextResponse.json(
      { error: "This import can't be continued — it may be finished, expired, or not yours." },
      { status: 400, headers: NO_STORE_HEADERS },
    )
  }

  // The owner-column mapping is admin-only — never trusted from the client alone (see
  // app/api/import/validate's identical stripping).
  const mapping: ImportMapping = { ...body.mapping }
  if (session.role !== 'Admin') {
    for (const key of Object.keys(mapping)) {
      if (mapping[Number(key)] === 'owner') mapping[Number(key)] = null
    }
  }

  try {
    const results = await commitImportChunk(
      { orgId: session.orgId, ownerId: session.ownerId, role: session.role, scopeOwnerId: session.scopeOwnerId },
      { id: batch.id, entityType: batch.entityType },
      mapping,
      body.duplicateStrategy,
      body.rows,
    )

    const counts = results.reduce(
      (acc, r) => {
        acc[r.outcome]++
        return acc
      },
      { created: 0, updated: 0, skipped: 0, failed: 0 },
    )
    await recordChunkResults(batch.id, counts, body.isFinalChunk)

    return NextResponse.json({ results, batchClosed: body.isFinalChunk }, { headers: NO_STORE_HEADERS })
  } catch (err) {
    // Never logs row contents — only the failure reason, same discipline as parse/validate.
    console.error('CSV import commit failed:', err instanceof Error ? err.message : 'unknown error')
    return NextResponse.json({ error: 'Could not commit this chunk' }, { status: 500, headers: NO_STORE_HEADERS })
  }
}
