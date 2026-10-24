// Server-only data access for the CSV-import feature. Mirrors the rest of lib/data/*.ts's own
// conventions (every function takes orgId/Scope and filters by it) plus the shared field-
// validation rules in lib/validation.ts, so an imported row is held to exactly the same standard
// as one created through the single-record form.
import { prisma, withTransaction } from '@lib/prisma'
import type { Scope } from '@lib/scope'
import { getCompanyByName, createCompany } from '@lib/data/companies'
import { getLeadByEmail } from '@lib/data/leads'
import { getContactByEmail } from '@lib/data/contacts'
import { getOwnerByEmailInsensitive } from '@lib/data/owners'
import {
  EMAIL_RE,
  LEAD_SOURCES,
  LEAD_STATUSES,
  MAX_EMAIL_LENGTH,
  MAX_NAME_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_PHONE_LENGTH,
  MAX_TITLE_LENGTH,
} from '@lib/validation'
import type { ImportEntityType, LeadSource, LeadStatus } from '@prisma/client'
import Papa from 'papaparse'

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024
export const MAX_IMPORT_ROWS = 2000

/** Default commit chunk size — a client never has to guess this; see app/api/import/commit's own
 *  doc comment for how it was measured against a real deployed region. */
export const DEFAULT_COMMIT_CHUNK_SIZE = 100

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

// withTransaction is re-exported for the commit route (lib/actions/import.ts) to use for each
// row's create/update, matching every other write in lib/data/*.ts.
export { withTransaction }
