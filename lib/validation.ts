// The one place lib/actions/crm.ts and the CSV-import feature (lib/data/import.ts,
// app/api/import/*) both get the exact same field rules from — a lead/contact created through a
// bulk import must be validated identically to one created through the single-record form, or
// the two paths quietly drift and an import could write a row the UI would have rejected.
import type { LeadSource, LeadStatus } from '@prisma/client'

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const LEAD_SOURCES: LeadSource[] = ['Inbound', 'Outbound', 'Referral', 'Event', 'Partner', 'Website']
export const LEAD_STATUSES: LeadStatus[] = ['new', 'contacted', 'qualified', 'unqualified', 'lost']

export const MAX_NAME_LENGTH = 200
export const MAX_TITLE_LENGTH = 200
export const MAX_EMAIL_LENGTH = 320
export const MAX_PHONE_LENGTH = 60
export const MAX_NOTES_LENGTH = 5000

/** Client-generated primary keys (optimistic-UI rows, or an import row's id) must be a real UUID
 *  — anything else is rejected before it ever reaches a `prisma.create`. */
export function assertClientId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new Error('Invalid id')
}
