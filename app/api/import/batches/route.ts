import { NextResponse } from 'next/server'
import { requireAuth } from '@lib/auth'
import { createImportBatch, MAX_IMPORT_ROWS } from '@lib/data/import'
import type { ImportEntityType } from '@prisma/client'

/**
 * Creates the ImportBatch up front, before any chunk is committed — every subsequent
 * POST /api/import/commit call against this batchId re-verifies it belongs to the same org and
 * importer and is still open (see getOpenImportBatch's doc comment). Route Handler, same
 * reasoning as the rest of the import endpoints (POST /api/import/parse's doc comment).
 */
export const dynamic = 'force-dynamic'

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }
const ENTITY_TYPES: ImportEntityType[] = ['lead', 'contact']

export async function POST(request: Request) {
  let session: Awaited<ReturnType<typeof requireAuth>>
  try {
    session = await requireAuth()
  } catch {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401, headers: NO_STORE_HEADERS })
  }

  let body: { entityType?: ImportEntityType; totalRows?: number }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400, headers: NO_STORE_HEADERS })
  }

  if (
    !body.entityType ||
    !ENTITY_TYPES.includes(body.entityType) ||
    typeof body.totalRows !== 'number' ||
    !Number.isInteger(body.totalRows) ||
    body.totalRows <= 0 ||
    body.totalRows > MAX_IMPORT_ROWS
  ) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400, headers: NO_STORE_HEADERS })
  }

  const batch = await createImportBatch(session.orgId, session.ownerId, body.entityType, body.totalRows)
  return NextResponse.json({ batchId: batch.id }, { headers: NO_STORE_HEADERS })
}
