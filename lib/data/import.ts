// Server-only data access for the CSV-import feature. Mirrors the rest of lib/data/*.ts's own
// conventions (every function takes orgId/Scope and filters by it) plus the shared field-
// validation rules in lib/validation.ts, so an imported row is held to exactly the same standard
// as one created through the single-record form.
import { prisma, withTransaction } from '@lib/prisma'
import type { Scope } from '@lib/scope'
import { assertOwnerInScope } from '@lib/scope'
import { getCompanyByName, createCompany } from '@lib/data/companies'
import { getLeadByEmail, createLead as dbCreateLead, updateLead as dbUpdateLead, updateLeadStatus as dbUpdateLeadStatus } from '@lib/data/leads'
import { getContactByEmail, createContact as dbCreateContact, updateContact as dbUpdateContact } from '@lib/data/contacts'
import { getOwnerByEmailInsensitive } from '@lib/data/owners'
import { writeCoalescedAssignedNotification } from '@lib/data/notifications'
import {
  EMAIL_RE,
  LEAD_SOURCES,
  LEAD_STATUSES,
  MAX_EMAIL_LENGTH,
  MAX_NAME_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_PHONE_LENGTH,
  MAX_TITLE_LENGTH,
  assertClientId,
} from '@lib/validation'
import { Prisma, type ImportEntityType, type LeadSource, type LeadStatus } from '@prisma/client'
import Papa from 'papaparse'

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024
export const MAX_IMPORT_ROWS = 2000

/** Default/max commit chunk size — a client never has to guess this, and the server enforces the
 *  same number as a hard ceiling (app/api/import/commit's MAX_CHUNK_ROWS). See that route's own
 *  doc comment for the real per-row write-cost measurement this is sized from. */
export const DEFAULT_COMMIT_CHUNK_SIZE = 10

/** A fixed ceiling on how many leads/contacts a single org may hold (checked at commit time, not
 *  parse/validate time — a cap this app-level, not DB-level, so the message can name the actual
 *  numbers rather than surfacing a raw constraint error). Deliberately generous for any
 *  realistically-sized team using this app today; revisit per-org if a real customer needs more. */
export const PER_ORG_RECORD_CAP = { lead: 5000, contact: 5000 } as const

// ---------------------------------------------------------------------------
// Encoding + parsing
// ---------------------------------------------------------------------------

export type EncodingFallback = 'windows-1252' | null

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

/**
 * Strips a leading UTF-8 BOM, then tries a strict UTF-8 decode (throws on any invalid byte
 * sequence, unlike Node's lenient default decode, which silently inserts replacement
 * characters). Falls back to Windows-1252 — the common encoding for a CSV saved from Excel on
 * Windows — which never throws (every byte maps to *something* in a single-byte encoding), so a
 * heuristic catches the case where that fallback produced mostly garbage (a non-text file, e.g. a
 * renamed .xlsx) and rejects outright instead of silently importing it.
 */
export function decodeImportFile(buffer: Buffer): { text: string; encodingFallback: EncodingFallback } {
  const stripped = buffer.subarray(0, 3).equals(UTF8_BOM) ? buffer.subarray(3) : buffer

  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(stripped), encodingFallback: null }
  } catch {
    // Fall through to the Windows-1252 attempt below.
  }

  const text = new TextDecoder('windows-1252').decode(stripped)
  const controlChars = text.match(/[\x00-\x08\x0e-\x1f\x7f]/g) ?? []
  if (controlChars.length / Math.max(text.length, 1) > 0.01) {
    throw new Error('Couldn\'t read this file as text. Please save it as "CSV UTF-8" and try again.')
  }
  return { text, encodingFallback: 'windows-1252' }
}

/**
 * Delimiter auto-detected by Papa Parse (handles comma vs. semicolon, the common alternative in
 * European-locale Excel exports) and RFC4180-correct quoted multi-line fields — both require
 * parsing the whole decoded text at once, never splitting it into lines first. Returns raw rows
 * (no header-based object mapping) so column mapping stays an explicit, user-adjustable step
 * rather than a guess baked into the parse itself.
 */
export function parseImportCsv(text: string): { headers: string[]; rows: string[][] } {
  const result = Papa.parse<string[]>(text, { delimiter: '', skipEmptyLines: true })
  const data = result.data
  if (data.length === 0) throw new Error('The file has no rows')
  const [headers, ...rows] = data
  return { headers: headers.map((h) => h.trim()), rows }
}

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

export type LeadImportField = 'name' | 'email' | 'phone' | 'company' | 'source' | 'status' | 'notes' | 'owner'
export type ContactImportField = 'name' | 'email' | 'phone' | 'company' | 'title' | 'notes' | 'owner'
export type ImportField = LeadImportField | ContactImportField

const FIELD_ALIASES: Record<ImportField, string[]> = {
  name: ['name', 'fullname', 'leadname', 'contactname'],
  email: ['email', 'emailaddress'],
  phone: ['phone', 'phonenumber', 'mobile', 'cell'],
  company: ['company', 'companyname', 'organization', 'org'],
  title: ['title', 'jobtitle', 'position'],
  source: ['source', 'leadsource'],
  status: ['status', 'leadstatus'],
  notes: ['notes', 'note', 'comments', 'description'],
  owner: ['owner', 'owneremail', 'assignedto', 'rep'],
}

const ALLOWED_FIELDS: Record<ImportEntityType, ImportField[]> = {
  lead: ['name', 'email', 'phone', 'company', 'source', 'status', 'notes', 'owner'],
  contact: ['name', 'email', 'phone', 'company', 'title', 'notes', 'owner'],
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Maps each header's index to a suggested field, or null if nothing matches. Purely a
 *  convenience default — the caller (the UI, then validate/commit) can override any entry. */
export function suggestColumnMapping(
  headers: string[],
  entityType: ImportEntityType,
): Record<number, ImportField | null> {
  const allowed = ALLOWED_FIELDS[entityType]
  const mapping: Record<number, ImportField | null> = {}
  const used = new Set<ImportField>()
  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header)
    const match = allowed.find(
      (field) => !used.has(field) && FIELD_ALIASES[field].includes(normalized),
    )
    mapping[index] = match ?? null
    if (match) used.add(match)
  })
  return mapping
}

export type ImportMapping = Record<number, ImportField | null>

/** Pulls the mapped cell for `field` out of one raw CSV row — '' if unmapped or genuinely blank. */
function cell(row: string[], mapping: ImportMapping, field: ImportField): string {
  const index = Object.entries(mapping).find(([, f]) => f === field)?.[0]
  if (index === undefined) return ''
  return (row[Number(index)] ?? '').trim()
}

// ---------------------------------------------------------------------------
// Field-level validation (pure — no DB access)
// ---------------------------------------------------------------------------

export const DEFAULT_LEAD_SOURCE: LeadSource = 'Inbound'
export const DEFAULT_LEAD_STATUS: LeadStatus = 'new'

export interface ImportFieldValue {
  /** The raw, trimmed cell text — '' if blank or unmapped. Never coerced/defaulted. Commit uses
   *  this (not `value`) to decide whether an update would overwrite an existing value: a blank
   *  cell must never erase data the record already has. */
  raw: string
  /** The resolved value actually written — identical to `raw` except for an enum field whose raw
   *  text didn't match any allowed value, which falls back to a default (see `defaulted`). */
  value: string
  defaulted: boolean
}

export interface FieldValidatedRow {
  rowNumber: number
  name: ImportFieldValue
  email: ImportFieldValue
  phone: ImportFieldValue
  companyName: ImportFieldValue
  notes: ImportFieldValue
  title: ImportFieldValue
  source: ImportFieldValue
  status: ImportFieldValue
  ownerEmail: ImportFieldValue
  /** Blocking field-level errors — a row with any of these is never written, regardless of
   *  duplicate strategy. */
  errors: string[]
}

function plain(raw: string): ImportFieldValue {
  return { raw, value: raw, defaulted: false }
}

/**
 * Validates one row's mapped cells against exactly the same rules createLeadAction/
 * createContactAction enforce (length caps, EMAIL_RE, enum membership) — no DB access, so this
 * runs identically during preview (validate) and at commit time. An unrecognized source/status
 * value is never a blocking error — it's silently defaulted (see DEFAULT_LEAD_SOURCE/STATUS) and
 * flagged via `defaulted`, so the per-row report can count it without failing the row outright.
 */
export function validateRowFields(
  entityType: ImportEntityType,
  row: string[],
  mapping: ImportMapping,
  rowNumber: number,
): FieldValidatedRow {
  const errors: string[] = []

  const name = cell(row, mapping, 'name')
  if (!name || name.length > MAX_NAME_LENGTH) errors.push('Name is required')

  const email = cell(row, mapping, 'email')
  if (email && (email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email))) errors.push('Invalid email')

  const phone = cell(row, mapping, 'phone')
  if (phone.length > MAX_PHONE_LENGTH) errors.push('Invalid phone')

  const companyName = cell(row, mapping, 'company')
  if (!companyName || companyName.length > MAX_NAME_LENGTH) errors.push('Company is required')

  const notes = cell(row, mapping, 'notes')
  if (notes.length > MAX_NOTES_LENGTH) errors.push('Notes are too long')

  const title = cell(row, mapping, 'title')
  if (title.length > MAX_TITLE_LENGTH) errors.push('Title is too long')

  const ownerEmail = cell(row, mapping, 'owner')

  let source: ImportFieldValue = plain('')
  let status: ImportFieldValue = plain('')
  if (entityType === 'lead') {
    const rawSource = cell(row, mapping, 'source')
    source = LEAD_SOURCES.includes(rawSource as LeadSource)
      ? plain(rawSource)
      : { raw: rawSource, value: DEFAULT_LEAD_SOURCE, defaulted: rawSource !== '' }

    const rawStatus = cell(row, mapping, 'status')
    status = LEAD_STATUSES.includes(rawStatus as LeadStatus)
      ? plain(rawStatus)
      : { raw: rawStatus, value: DEFAULT_LEAD_STATUS, defaulted: rawStatus !== '' }
  }

  return {
    rowNumber,
    name: plain(name),
    email: plain(email),
    phone: plain(phone),
    companyName: plain(companyName),
    notes: plain(notes),
    title: plain(title),
    source,
    status,
    ownerEmail: plain(ownerEmail),
    errors,
  }
}

// ---------------------------------------------------------------------------
// DB-backed resolution (company/owner/duplicate) — used by both validate and commit
// ---------------------------------------------------------------------------

export interface ResolvedCompany {
  id: string
  name: string
  /** False means this call created it — surfaced so a batch of rows referencing the same new
   *  name only ever reports "created" once, on the row that actually triggered it (see the
   *  dedup cache parameter below). */
  existing: boolean
}

export interface PreviewedCompany {
  /** Null means no matching company exists yet — commit would create one. Never creates it here:
   *  this is the read-only preview path (app/api/import/validate), which must never write. */
  id: string | null
  name: string
  existing: boolean
}

/** Read-only counterpart to `resolveCompany`, for the preview/validate step — looks up but never
 *  creates. Dedup cache works the same way (avoids a redundant lookup for a name repeated across
 *  many rows in the same preview request). */
export async function previewCompanyResolution(
  orgId: string,
  name: string,
  cache: Map<string, PreviewedCompany>,
): Promise<PreviewedCompany> {
  const key = name.toLowerCase()
  const cached = cache.get(key)
  if (cached) return cached

  const existing = await getCompanyByName(orgId, name)
  const resolved = existing
    ? { id: existing.id, name: existing.name, existing: true }
    : { id: null, name, existing: false }
  cache.set(key, resolved)
  return resolved
}

/**
 * Resolves (or creates) the Company for one row's company-name cell, deduped within the caller's
 * own in-memory `cache` for the lifetime of one request/chunk — without it, N rows naming a
 * company that doesn't exist yet would each independently pass getCompanyByName's check (finding
 * nothing) and each create their own row, since there is no DB-level unique constraint on
 * (orgId, name) backing this (see getCompanyByName's own doc comment). The cache only needs to
 * cover one request: a later chunk resolving the same name calls getCompanyByName fresh and finds
 * the row THIS chunk (or an earlier one) already created — the DB itself is what stays consistent
 * across chunks, not this cache.
 */
export async function resolveCompany(
  orgId: string,
  name: string,
  cache: Map<string, ResolvedCompany>,
): Promise<ResolvedCompany> {
  const key = name.toLowerCase()
  const cached = cache.get(key)
  if (cached) return cached

  const existing = await getCompanyByName(orgId, name)
  if (existing) {
    const resolved = { id: existing.id, name: existing.name, existing: true }
    cache.set(key, resolved)
    return resolved
  }

  const created = await createCompany(orgId, { id: crypto.randomUUID(), name })
  const resolved = { id: created.id, name: created.name, existing: false }
  cache.set(key, resolved)
  return resolved
}

export type ResolvedOwner = { id: string; name: string } | { unknownEmail: string } | null

/** Admin-only capability (the caller decides whether to invoke this at all) — an owner-column
 *  email that doesn't match any Owner in this org is reported, never silently defaulted to the
 *  importer. */
export async function resolveOwnerByEmail(orgId: string, email: string): Promise<ResolvedOwner> {
  if (!email) return null
  const owner = await getOwnerByEmailInsensitive(orgId, email)
  if (!owner) return { unknownEmail: email }
  return { id: owner.id, name: owner.name }
}

/** `recordId`/`name` only EXIST on the editable variant — a match outside the caller's own Scope
 *  (an OWN-mode Member matching another rep's record) is `{ editable: false }` and nothing else,
 *  at the type level, so there's no field left to accidentally leak downstream. */
export type DuplicateMatch = { editable: true; recordId: string; name: string } | { editable: false }

/** Blank emails never match (an empty cell can't collide with anything) — checked by the caller
 *  before calling this, same as the single-record create paths. */
export async function findDuplicateByEmail(
  scope: Scope,
  entityType: ImportEntityType,
  email: string,
): Promise<DuplicateMatch | null> {
  const found =
    entityType === 'lead' ? await getLeadByEmail(scope, email) : await getContactByEmail(scope, email)
  if (!found) return null
  const editable = scope.scopeOwnerId === null || found.ownerId === scope.scopeOwnerId
  return editable ? { editable: true, recordId: found.id, name: found.name } : { editable: false }
}

// ---------------------------------------------------------------------------
// Per-org record cap
// ---------------------------------------------------------------------------

export async function countOrgRecords(orgId: string, entityType: ImportEntityType): Promise<number> {
  return entityType === 'lead'
    ? prisma.lead.count({ where: { orgId } })
    : prisma.contact.count({ where: { orgId } })
}

// ---------------------------------------------------------------------------
// ImportBatch lifecycle
// ---------------------------------------------------------------------------

export function createImportBatch(orgId: string, importedById: string, entityType: ImportEntityType, totalRows: number) {
  return prisma.importBatch.create({ data: { orgId, importedById, entityType, totalRows } })
}

/** Null if the batch doesn't exist, belongs to a different org/importer, or is already closed —
 *  every one of those is reported identically by the caller (a single "can't commit to this
 *  import" message), never distinguishing which, so a client can't use this to probe batch ids
 *  it doesn't own. */
export async function getOpenImportBatch(orgId: string, importedById: string, batchId: string) {
  const batch = await prisma.importBatch.findFirst({ where: { id: batchId, orgId, importedById } })
  if (!batch || batch.committedAt) return null
  return batch
}

export function recordChunkResults(
  batchId: string,
  counts: { created: number; updated: number; skipped: number; failed: number },
  isFinalChunk: boolean,
) {
  return prisma.importBatch.update({
    where: { id: batchId },
    data: {
      createdCount: { increment: counts.created },
      updatedCount: { increment: counts.updated },
      skippedCount: { increment: counts.skipped },
      failedCount: { increment: counts.failed },
      ...(isFinalChunk && { committedAt: new Date() }),
    },
  })
}

/**
 * Writes ONE coalesced "assigned" notification per distinct recipient of a just-finished import
 * batch — never one per row, which is exactly the flood a bulk import would otherwise cause (see
 * writeCoalescedAssignedNotification's own doc comment). Called once, at isFinalChunk time, after
 * `recordChunkResults` has closed the batch. Groups the rows this batch actually created by their
 * `ownerId`, excludes the importer themselves (self-assignment never notifies), and is naturally
 * idempotent against a retried final chunk: `dedupeKey` is scoped to the batch + recipient, so a
 * retry collides on the unique constraint and is swallowed as a no-op rather than double-counting.
 */
export async function writeImportBatchSummaryNotifications(
  batch: { id: string; orgId: string; entityType: ImportEntityType },
  importerId: string,
): Promise<void> {
  const grouped =
    batch.entityType === 'lead'
      ? await prisma.lead.groupBy({
          by: ['ownerId'],
          where: { orgId: batch.orgId, importBatchId: batch.id },
          _count: { _all: true },
        })
      : await prisma.contact.groupBy({
          by: ['ownerId'],
          where: { orgId: batch.orgId, importBatchId: batch.id },
          _count: { _all: true },
        })

  const recipients = grouped.filter((g) => g.ownerId !== importerId && g._count._all > 0)
  if (recipients.length === 0) return

  await withTransaction(async (tx) => {
    for (const g of recipients) {
      await writeCoalescedAssignedNotification(tx, {
        orgId: batch.orgId,
        recipientId: g.ownerId,
        actorId: importerId,
        subjectType: batch.entityType,
        count: g._count._all,
        dedupeKey: `import:${batch.id}:${g.ownerId}`,
      })
    }
  })
}

// ---------------------------------------------------------------------------
// Chunked commit
// ---------------------------------------------------------------------------

export interface ImportRowInput {
  rowNumber: number
  /** Client-generated UUID — becomes the new row's primary key if this row is created. Also what
   *  makes a retried chunk idempotent: see the pre-write existence check below. */
  id: string
  cells: string[]
}

export type ImportOutcome = 'created' | 'updated' | 'skipped' | 'failed'
export type DuplicateStrategy = 'skip' | 'update' | 'create'

export interface ImportRowResult {
  rowNumber: number
  outcome: ImportOutcome
  recordId?: string
  error?: string
  defaultedFields?: Array<'source' | 'status'>
}

function isIdCollision(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002' &&
    Array.isArray(err.meta?.target) &&
    (err.meta!.target as string[]).includes('id')
  )
}

async function createImportRow(
  scope: Scope,
  batchId: string,
  entityType: ImportEntityType,
  rowId: string,
  fields: FieldValidatedRow,
  companyId: string,
  ownerId: string,
  actorId: string,
) {
  const name = fields.name.value
  const activityId = crypto.randomUUID()
  const noteActivityId = fields.notes.value ? crypto.randomUUID() : undefined
  const activities = {
    create: [
      {
        id: activityId,
        orgId: scope.orgId,
        kind: 'created' as const,
        title: `created ${entityType} ${name}`,
        actorId,
        ownerId,
        subjectType: entityType,
        subjectLabel: name,
      },
      ...(noteActivityId
        ? [
            {
              id: noteActivityId,
              orgId: scope.orgId,
              kind: 'note' as const,
              title: `added a note on ${name}`,
              body: fields.notes.value,
              actorId,
              ownerId,
              subjectType: entityType,
              subjectLabel: name,
            },
          ]
        : []),
    ],
  }

  if (entityType === 'lead') {
    return dbCreateLead(scope, {
      id: rowId,
      name,
      title: '',
      email: fields.email.value,
      phone: fields.phone.value,
      location: '',
      status: fields.status.value as LeadStatus,
      source: fields.source.value as LeadSource,
      importBatchId: batchId,
      company: { connect: { id: companyId } },
      owner: { connect: { id: ownerId } },
      activities,
    })
  }
  return dbCreateContact(scope, {
    id: rowId,
    name,
    title: fields.title.value,
    email: fields.email.value,
    phone: fields.phone.value,
    location: '',
    tags: [],
    lifecycle: 'Prospect',
    importBatchId: batchId,
    company: { connect: { id: companyId } },
    owner: { connect: { id: ownerId } },
    activities,
  })
}

/**
 * Updates an existing duplicate-matched row from an import row's values. Deliberately narrow:
 * only name/email/phone/company (+ a lead's source — already part of UpdateLeadInput) are ever
 * changed; ownerId and a lead's status are never touched by an import update (reassignment and
 * workflow-state changes are a bigger, separately-scoped decision than "refresh this contact's
 * info from a spreadsheet"). A blank cell always preserves the existing value — never overwrites
 * with an empty string — and an unrecognized (not blank, not valid) source value also preserves
 * the existing value rather than silently applying DEFAULT_LEAD_SOURCE, which only makes sense
 * for a brand-new row with no "existing" to fall back to.
 */
async function applyImportUpdate(
  scope: Scope,
  entityType: ImportEntityType,
  id: string,
  fields: FieldValidatedRow,
  companyId: string,
  actorId: string,
) {
  if (entityType === 'lead') {
    const existing = await prisma.lead.findFirst({ where: { id, orgId: scope.orgId } })
    if (!existing) throw new Error(`Lead ${id} not found in org ${scope.orgId}`)

    const updated = await dbUpdateLead(
      scope,
      id,
      {
        name: fields.name.value,
        title: existing.title,
        email: fields.email.raw ? fields.email.value : existing.email,
        phone: fields.phone.raw ? fields.phone.value : existing.phone,
        companyId,
        source: fields.source.raw && !fields.source.defaulted ? (fields.source.value as LeadSource) : existing.source,
        ownerId: existing.ownerId,
      },
      actorId,
      crypto.randomUUID(),
    )

    if (fields.status.raw && !fields.status.defaulted && fields.status.value !== existing.status) {
      await dbUpdateLeadStatus(scope, id, fields.status.value as LeadStatus)
    }
    return updated
  }

  const existing = await prisma.contact.findFirst({ where: { id, orgId: scope.orgId } })
  if (!existing) throw new Error(`Contact ${id} not found in org ${scope.orgId}`)

  return dbUpdateContact(
    scope,
    id,
    {
      name: fields.name.value,
      title: fields.title.raw ? fields.title.value : existing.title,
      email: fields.email.raw ? fields.email.value : existing.email,
      phone: fields.phone.raw ? fields.phone.value : existing.phone,
      companyId,
      ownerId: existing.ownerId,
    },
    actorId,
    crypto.randomUUID(),
  )
}

/**
 * Processes one chunk of an already-open import batch. Never trusts anything the client
 * annotated during preview — every row is re-validated and re-resolved from scratch here, the
 * same as app/api/import/validate, so a stale or tampered client-held row can't skip a check.
 *
 * Row order within the rules below matters: the idempotent-retry check (does a row with this
 * exact client-generated id already exist under this batch?) runs FIRST, before even duplicate-
 * email detection — a retried chunk's own already-created row would otherwise look like a
 * pre-existing "duplicate" of itself on the second attempt and get diverted into the skip/update
 * path. It also runs before the per-org cap check, so retrying an already-succeeded chunk never
 * gets wrongly rejected by a cap that filled up in between — a row that already exists under
 * this exact batch never consumes a new slot, because it isn't a new write at all.
 */
export async function commitImportChunk(
  session: { orgId: string; ownerId: string; role: string; scopeOwnerId: string | null },
  batch: { id: string; entityType: ImportEntityType },
  mapping: ImportMapping,
  duplicateStrategy: DuplicateStrategy,
  rows: ImportRowInput[],
): Promise<ImportRowResult[]> {
  const scope: Scope = { orgId: session.orgId, scopeOwnerId: session.scopeOwnerId }
  const isAdmin = session.role === 'Admin'
  const companyCache = new Map<string, ResolvedCompany>()
  const cap = PER_ORG_RECORD_CAP[batch.entityType]
  let currentCount = await countOrgRecords(session.orgId, batch.entityType)

  const results: ImportRowResult[] = []

  for (const row of rows) {
    const fields = validateRowFields(batch.entityType, row.cells, mapping, row.rowNumber)
    if (fields.errors.length > 0) {
      results.push({ rowNumber: row.rowNumber, outcome: 'failed', error: fields.errors.join('; ') })
      continue
    }
    try {
      assertClientId(row.id)
    } catch {
      results.push({ rowNumber: row.rowNumber, outcome: 'failed', error: 'Invalid row id' })
      continue
    }

    const defaultedFields: Array<'source' | 'status'> = []
    if (fields.source.defaulted) defaultedFields.push('source')
    if (fields.status.defaulted) defaultedFields.push('status')
    const withDefaulted = defaultedFields.length > 0 ? { defaultedFields } : {}

    // Idempotent-retry check runs FIRST, before anything else — a row that already succeeded as
    // a create in this exact batch must short-circuit here, before duplicate-email detection
    // even runs. Otherwise a retried chunk's own successful create would make its own email look
    // like a pre-existing "duplicate" on the second attempt (the row IS the match), diverting it
    // into the skip/update path instead of being recognized as the same row coming back around.
    const existingRow =
      batch.entityType === 'lead'
        ? await prisma.lead.findFirst({ where: { id: row.id, orgId: session.orgId }, select: { id: true, importBatchId: true } })
        : await prisma.contact.findFirst({ where: { id: row.id, orgId: session.orgId }, select: { id: true, importBatchId: true } })

    if (existingRow) {
      if (existingRow.importBatchId === batch.id) {
        results.push({ rowNumber: row.rowNumber, outcome: 'created', recordId: existingRow.id, ...withDefaulted })
      } else {
        results.push({ rowNumber: row.rowNumber, outcome: 'failed', error: 'Could not create record' })
      }
      continue
    }

    // Owner resolution — admin-only; everyone else always imports as themselves.
    let ownerId = session.ownerId
    if (isAdmin && fields.ownerEmail.value) {
      const resolvedOwner = await resolveOwnerByEmail(session.orgId, fields.ownerEmail.value)
      if (resolvedOwner && 'unknownEmail' in resolvedOwner) {
        results.push({ rowNumber: row.rowNumber, outcome: 'failed', error: `Unknown owner email: ${resolvedOwner.unknownEmail}` })
        continue
      }
      if (resolvedOwner) ownerId = resolvedOwner.id
    }
    // Defense in depth — an Admin is always unscoped (computeScopeOwnerId), so this only ever
    // matters if that invariant is ever violated; never silently assign outside scope either way.
    try {
      assertOwnerInScope(scope, ownerId)
    } catch {
      ownerId = session.ownerId
    }

    const duplicate = fields.email.value ? await findDuplicateByEmail(scope, batch.entityType, fields.email.value) : null

    if (duplicate && !duplicate.editable) {
      // A scoped Member's match on another rep's record — skipped unconditionally, regardless of
      // the chosen duplicateStrategy, revealing nothing about the other record.
      results.push({ rowNumber: row.rowNumber, outcome: 'skipped', error: 'A record with this email already exists', ...withDefaulted })
      continue
    }

    if (duplicate && duplicate.editable && duplicateStrategy !== 'create') {
      if (duplicateStrategy === 'skip') {
        results.push({ rowNumber: row.rowNumber, outcome: 'skipped', recordId: duplicate.recordId, ...withDefaulted })
        continue
      }
      const company = await resolveCompany(session.orgId, fields.companyName.value, companyCache)
      const updated = await applyImportUpdate(scope, batch.entityType, duplicate.recordId, fields, company.id, session.ownerId)
      results.push({ rowNumber: row.rowNumber, outcome: 'updated', recordId: updated.id, ...withDefaulted })
      continue
    }

    // Create path.
    if (currentCount >= cap) {
      results.push({
        rowNumber: row.rowNumber,
        outcome: 'failed',
        error: `This org has reached its ${cap}-record limit for ${batch.entityType}s. Contact support to raise it.`,
      })
      continue
    }

    try {
      const company = await resolveCompany(session.orgId, fields.companyName.value, companyCache)
      const created = await createImportRow(scope, batch.id, batch.entityType, row.id, fields, company.id, ownerId, session.ownerId)
      currentCount++
      results.push({ rowNumber: row.rowNumber, outcome: 'created', recordId: created.id, ...withDefaulted })
    } catch (err) {
      if (isIdCollision(err)) {
        results.push({ rowNumber: row.rowNumber, outcome: 'failed', error: 'Could not create record' })
      } else {
        throw err
      }
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

export const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000

export function getImportBatchById(orgId: string, batchId: string) {
  return prisma.importBatch.findFirst({ where: { id: batchId, orgId } })
}

export function markBatchUndone(batchId: string, undoneById: string) {
  return prisma.importBatch.update({ where: { id: batchId }, data: { undoneAt: new Date(), undoneById } })
}

/**
 * Removes every row from this batch that is both (a) untouched since import — no Activity beyond
 * the single `created` one logged at import time, a deliberately literal reading that also, on
 * the safe side, excludes a row imported WITH a note (two activities instead of one) from ever
 * being undoable, rather than trying to distinguish "the import's own note" from "a note added
 * later" — and (b) has no dependents (a lead's conversion into a contact/deal, or any Task linked
 * to it; a contact's own linked Deals or Tasks). Everything else is kept, never deleted. Company
 * rows created as a side effect of the import are never touched either way.
 */
export async function undoImportBatch(batch: {
  id: string
  orgId: string
  entityType: ImportEntityType
}): Promise<{ removed: number; kept: number }> {
  let removed = 0
  let kept = 0

  if (batch.entityType === 'lead') {
    const rows = await prisma.lead.findMany({
      where: { orgId: batch.orgId, importBatchId: batch.id },
      include: { _count: { select: { activities: true, tasks: true } }, convertedDeal: { select: { id: true } }, convertedContact: { select: { id: true } } },
    })
    for (const row of rows) {
      const onlyCreatedActivity = row._count.activities <= 1
      const hasDependents = row._count.tasks > 0 || row.convertedDeal !== null || row.convertedContact !== null
      if (onlyCreatedActivity && !hasDependents) {
        await withTransaction(async (tx) => {
          await tx.activity.deleteMany({ where: { leadId: row.id } })
          await tx.lead.delete({ where: { id: row.id } })
        })
        removed++
      } else {
        kept++
      }
    }
  } else {
    const rows = await prisma.contact.findMany({
      where: { orgId: batch.orgId, importBatchId: batch.id },
      include: { _count: { select: { activities: true, tasks: true, deals: true } } },
    })
    for (const row of rows) {
      const onlyCreatedActivity = row._count.activities <= 1
      const hasDependents = row._count.tasks > 0 || row._count.deals > 0
      if (onlyCreatedActivity && !hasDependents) {
        await withTransaction(async (tx) => {
          await tx.activity.deleteMany({ where: { contactId: row.id } })
          await tx.contact.delete({ where: { id: row.id } })
        })
        removed++
      } else {
        kept++
      }
    }
  }

  return { removed, kept }
}

// withTransaction is re-exported for callers (app/api/import/commit's route, lib/actions/
// import.ts) that need it directly, matching every other write in lib/data/*.ts.
export { withTransaction }
