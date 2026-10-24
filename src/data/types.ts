export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'unqualified' | 'lost'

export type LeadSource =
  | 'Inbound'
  | 'Outbound'
  | 'Referral'
  | 'Event'
  | 'Partner'
  | 'Website'

export type Priority = 'low' | 'medium' | 'high'

/** A per-org, renameable/reorderable pipeline stage — replaces the old fixed DealStage enum.
 *  `id` is what Deal.stageId points at; there's no more fixed set of keys to switch on, check
 *  `isWon`/`isClosed` instead of comparing against a specific stage. */
export interface PipelineStage {
  id: string
  label: string
  order: number
  probability: number
  isClosed: boolean
  isWon: boolean
}

export interface Owner {
  id: string
  name: string
  initials: string
  role: string
  email: string
  timezone?: string
  /** False once this person is removed from the org in Clerk — still shown (never deleted) so
   *  historical ownership/activity attribution stays accurate; just no longer assignable. */
  active: boolean
}

export interface Company {
  id: string
  name: string
  website?: string
  industry?: string
  notes?: string
  createdAt: string
  updatedAt: string
  /** Rollup counts, populated on the list/detail views; absent on freshly-created optimistic rows. */
  leadCount?: number
  contactCount?: number
  dealCount?: number
}

export interface Lead {
  id: string
  name: string
  title: string
  companyId: string
  company: string
  email: string
  phone: string
  status: LeadStatus
  source: LeadSource
  ownerId: string
  score: number
  estValue: number
  location: string
  createdAt: string
  lastTouchedAt: string
  /** A calendar date (e.g. "2026-03-10"), not an instant — see Lead.followUpAt's schema doc
   *  comment. Undefined/null means no follow-up scheduled. */
  followUpAt?: string | null
  convertedDealId?: string
  /** Set once this lead has been converted (with or without a deal) — the persisted "already converted" flag. */
  convertedContactId?: string
}

export interface Contact {
  id: string
  name: string
  title: string
  companyId: string
  company: string
  email: string
  phone: string
  ownerId: string
  /** Set when the contact was created by converting a lead. */
  leadId?: string
  tags: string[]
  lifecycle: 'Customer' | 'Prospect' | 'Champion' | 'Evaluator' | 'Churned'
  location: string
  lastInteractionAt: string
  createdAt: string
  openDeals: number
  accountValue: number
}

export interface Deal {
  id: string
  name: string
  companyId: string
  company: string
  contactId?: string
  leadId?: string
  value: number
  stageId: string
  ownerId: string
  probability: number
  closeDate: string
  createdAt: string
  updatedAt: string
  priority: Priority
  source: LeadSource
}

export interface Task {
  id: string
  title: string
  description?: string
  dueDate: string
  done: boolean
  priority: Priority
  ownerId: string
  relatedTo?: { type: 'lead' | 'contact' | 'deal'; id: string; label: string }
  /** True when this task HAD a relatedTo subject, but the server redacted it because the parent's
   *  current owner is outside the scoped viewer's visibility (see redactOutOfScopeParent in
   *  lib/data/tasks.ts). Lets the UI distinguish "no parent" from "a parent exists but you can't
   *  see which one" — always false for an unscoped (Admin / ALL-mode) viewer. */
  relatedToRedacted?: boolean
  type: 'call' | 'email' | 'meeting' | 'todo'
}

export type ActivityKind =
  | 'call'
  | 'email'
  | 'meeting'
  | 'note'
  | 'stage'
  | 'created'
  | 'edited'
  | 'task'
  | 'won'
  | 'lost'
  | 'payment'

export type PaymentStatus = 'pending' | 'paid' | 'cancelled'

export const PAYMENT_LABELS = ['Advance', 'Milestone', 'Final', 'Other'] as const
export type PaymentLabel = (typeof PAYMENT_LABELS)[number]

/** Admin-only (requirePaymentAccess/requirePaymentWriteAccess, see lib/auth.ts). Tracks a single
 *  expected/received amount against a Deal (treated as the "project" — no separate Project
 *  entity). Never changes automatically when the parent Deal's value changes — purely
 *  informational against whatever that value is when viewed; the UI flags when the sum of `paid`
 *  payments on a deal exceeds its value instead of reconciling anything. */
export interface Payment {
  id: string
  dealId: string
  amount: number
  status: PaymentStatus
  label: PaymentLabel
  /** Undefined means "awaiting milestone" — tied to work completing, not a calendar date. Never
   *  counts as overdue (see isPaymentOverdue in src/lib/utils.ts). Can be set later through the
   *  normal edit flow once the milestone date is known. */
  dueDate?: string
  /** Set only while status is 'paid', and kept even if later cancelled — see cancelPayment in
   *  lib/data/payments.ts for why. */
  paidAt?: string
  note?: string
  createdById: string
  createdAt: string
  updatedAt: string
}

export interface Activity {
  id: string
  kind: ActivityKind
  title: string
  body?: string
  at: string
  actorId: string
  subject?: { type: 'lead' | 'contact' | 'deal'; id: string; label: string }
}

export const LEAD_STATUS_ORDER: LeadStatus[] = [
  'new',
  'contacted',
  'qualified',
  'unqualified',
  'lost',
]

export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  unqualified: 'Unqualified',
  lost: 'Lost',
}

/** The org-level currency setting (Settings -> Workspace, admin-only) is validated against this
 *  fixed list, both client-side (the Select's options) and server-side (updateCurrencyAction) —
 *  a curated list rather than any valid Intl code, consistent with how this app already treats
 *  other org-wide enums (lead sources, task types) as closed sets rather than open strings. */
export const CURRENCY_CODES = ['USD', 'PKR', 'EUR', 'GBP', 'AED', 'SAR', 'CAD', 'AUD'] as const
export type CurrencyCode = (typeof CURRENCY_CODES)[number]

export const CURRENCY_LABEL: Record<CurrencyCode, string> = {
  USD: 'USD — US Dollar',
  PKR: 'PKR — Pakistani Rupee',
  EUR: 'EUR — Euro',
  GBP: 'GBP — British Pound',
  AED: 'AED — UAE Dirham',
  SAR: 'SAR — Saudi Riyal',
  CAD: 'CAD — Canadian Dollar',
  AUD: 'AUD — Australian Dollar',
}

