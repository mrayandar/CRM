import { NextResponse } from 'next/server'
import { requireAuth } from '@lib/auth'
import type { Scope } from '@lib/scope'
import {
  validateRowFields,
  previewCompanyResolution,
  resolveOwnerByEmail,
  findDuplicateByEmail,
  type ImportMapping,
  type ImportField,
  type PreviewedCompany,
} from '@lib/data/import'
import type { ImportEntityType } from '@prisma/client'

/**
 * Read-only preview for the CSV-import mapping/preview screen — same reasoning as
 * POST /api/import/parse for being a Route Handler, not a Server Action. Re-run (debounced)
 * whenever the user adjusts the column mapping. Never writes anything: company resolution here
 * only ever looks up (see previewCompanyResolution), never creates.
 */
export const dynamic = 'force-dynamic'

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

const ENTITY_TYPES: ImportEntityType[] = ['lead', 'contact']

interface ValidateBody {
  entityType: ImportEntityType
  rows: string[][]
  mapping: ImportMapping
}

function isValidMapping(mapping: unknown): mapping is ImportMapping {
  return typeof mapping === 'object' && mapping !== null && !Array.isArray(mapping)
}

export async function POST(request: Request) {
  let session: Awaited<ReturnType<typeof requireAuth>>
  try {
    session = await requireAuth()
  } catch {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401, headers: NO_STORE_HEADERS })
  }

  let body: ValidateBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400, headers: NO_STORE_HEADERS })
  }

  if (
    !ENTITY_TYPES.includes(body.entityType) ||
    !Array.isArray(body.rows) ||
    body.rows.length === 0 ||
    body.rows.length > 2000 ||
    !isValidMapping(body.mapping)
  ) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400, headers: NO_STORE_HEADERS })
  }

  // The owner-column mapping is an admin-only capability — a non-admin's mapping is never
  // trusted to omit it on its own, so it's stripped server-side regardless of what the client
  // sent.
  const mapping: ImportMapping = { ...body.mapping }
  const isAdmin = session.role === 'Admin'
  if (!isAdmin) {
    for (const key of Object.keys(mapping)) {
      if (mapping[Number(key)] === ('owner' as ImportField)) mapping[Number(key)] = null
    }
  }

  const scope: Scope = { orgId: session.orgId, scopeOwnerId: session.scopeOwnerId }
  const companyCache = new Map<string, PreviewedCompany>()

  try {
    const results = await Promise.all(
      body.rows.map(async (row, index) => {
        const fields = validateRowFields(body.entityType, row, mapping, index + 1)

        const resolvedCompany = fields.companyName.value
          ? await previewCompanyResolution(session.orgId, fields.companyName.value, companyCache)
          : null

        const resolvedOwner = isAdmin ? await resolveOwnerByEmail(session.orgId, fields.ownerEmail.value) : null

        const duplicate = fields.email.value
          ? await findDuplicateByEmail(scope, body.entityType, fields.email.value)
          : null

        return {
          rowNumber: fields.rowNumber,
          errors: fields.errors,
          fields: {
            name: fields.name,
            email: fields.email,
            phone: fields.phone,
            companyName: fields.companyName,
            notes: fields.notes,
            title: fields.title,
            source: fields.source,
            status: fields.status,
            ownerEmail: fields.ownerEmail,
          },
          resolvedCompany,
          resolvedOwner,
          duplicate,
        }
      }),
    )

    return NextResponse.json({ rows: results }, { headers: NO_STORE_HEADERS })
  } catch (err) {
    console.error('CSV import validate failed:', err instanceof Error ? err.message : 'unknown error')
    return NextResponse.json({ error: 'Could not validate this file' }, { status: 400, headers: NO_STORE_HEADERS })
  }
}
