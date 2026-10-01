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

export interface Lead {
  id: string
  name: string
  title: string
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
  convertedDealId?: string
  /** Set once this lead has been converted (with or without a deal) — the persisted "already converted" flag. */
  convertedContactId?: string
}

export interface Contact {
  id: string
  name: string
  title: string
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

