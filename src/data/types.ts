export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'unqualified' | 'lost'

export type LeadSource =
  | 'Inbound'
  | 'Outbound'
  | 'Referral'
  | 'Event'
  | 'Partner'
  | 'Website'

export type DealStage =
  | 'discovery'
  | 'proposal'
  | 'negotiation'
  | 'contract'
  | 'won'
  | 'lost'

export type Priority = 'low' | 'medium' | 'high'

export interface Owner {
  id: string
  name: string
  initials: string
  role: string
  email: string
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
  stage: DealStage
  ownerId: string
  probability: number
  closeDate: string
  updatedAt: string
  priority: Priority
  source: LeadSource
}

export interface Task {
  id: string
  title: string
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

export const DEAL_STAGE_ORDER: DealStage[] = [
  'discovery',
  'proposal',
  'negotiation',
  'contract',
  'won',
  'lost',
]

export const PIPELINE_STAGES: DealStage[] = [
  'discovery',
  'proposal',
  'negotiation',
  'contract',
  'won',
]

export const DEAL_STAGE_LABEL: Record<DealStage, string> = {
  discovery: 'Discovery',
  proposal: 'Proposal',
  negotiation: 'Negotiation',
  contract: 'Contract Sent',
  won: 'Won',
  lost: 'Lost',
}
