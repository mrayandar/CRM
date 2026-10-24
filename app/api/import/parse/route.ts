import { NextResponse } from 'next/server'
import { requireAuth } from '@lib/auth'
import {
  decodeImportFile,
  parseImportCsv,
  suggestColumnMapping,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_ROWS,
} from '@lib/data/import'
import type { ImportEntityType } from '@prisma/client'

/**
 * A Route Handler, not a Server Action, for the same reason GET /api/crm-refetch is one: file
 * upload plus CSV parsing is heavier than the Action-dispatch queue is built for, and shouldn't
 * block a concurrent mutation from the same client. Pure parsing + mapping suggestion — never
 * touches the database, so there is nothing to undo if the user abandons the import here.
 *
 * Returns every parsed row (not just a preview slice) so the client can drive the mapping/preview
 * UI without a third round trip — bounded by MAX_IMPORT_ROWS/MAX_IMPORT_FILE_BYTES, so this is
 * never a large payload.
 */
export const dynamic = 'force-dynamic'

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

const ENTITY_TYPES: ImportEntityType[] = ['lead', 'contact']

export async function POST(request: Request) {
  try {
    await requireAuth()
  } catch {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401, headers: NO_STORE_HEADERS })
  }

  try {
    // Fast-fail on a declared oversized body before buffering anything — 10% slack for multipart
    // boundary/field overhead around the actual file bytes.
    const contentLength = Number(request.headers.get('content-length') ?? 0)
    if (contentLength > MAX_IMPORT_FILE_BYTES * 1.1) {
      return NextResponse.json(
        { error: `File exceeds the ${MAX_IMPORT_FILE_BYTES / (1024 * 1024)}MB limit` },
        { status: 400, headers: NO_STORE_HEADERS },
      )
    }

    const formData = await request.formData()
    const entityType = formData.get('entityType')
    if (typeof entityType !== 'string' || !ENTITY_TYPES.includes(entityType as ImportEntityType)) {
      return NextResponse.json({ error: 'Invalid entityType' }, { status: 400, headers: NO_STORE_HEADERS })
    }

    const file = formData.get('file')
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400, headers: NO_STORE_HEADERS })
    }
    // The authoritative size check — Content-Length above can be absent or wrong.
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      return NextResponse.json(
        { error: `File exceeds the ${MAX_IMPORT_FILE_BYTES / (1024 * 1024)}MB limit` },
        { status: 400, headers: NO_STORE_HEADERS },
      )
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const { text, encodingFallback } = decodeImportFile(buffer)
    const { headers, rows } = parseImportCsv(text)

    if (rows.length > MAX_IMPORT_ROWS) {
      return NextResponse.json(
        {
          error: `This file has ${rows.length} rows, which is over the ${MAX_IMPORT_ROWS}-row limit. Please split it into smaller files and import them separately.`,
        },
        { status: 400, headers: NO_STORE_HEADERS },
      )
    }

    const suggestedMapping = suggestColumnMapping(headers, entityType as ImportEntityType)

    return NextResponse.json(
      { headers, rows, suggestedMapping, rowCount: rows.length, encodingFallback },
      { headers: NO_STORE_HEADERS },
    )
  } catch (err) {
    // Never logs row contents — only the (generic, non-sensitive) failure reason.
    console.error('CSV import parse failed:', err instanceof Error ? err.message : 'unknown error')
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Could not read this file' },
      { status: 400, headers: NO_STORE_HEADERS },
    )
  }
}
