'use server'

import { revalidatePath } from 'next/cache'
import { requireAuth } from '@lib/auth'
import {
  createLead as dbCreateLead,
  updateLeadStatus as dbUpdateLeadStatus,
  convertLeadToDeal as dbConvertLeadToDeal,
} from '@lib/data/leads'
import { getOwnerById } from '@lib/data/owners'
import { getContactById } from '@lib/data/contacts'
import { createDeal as dbCreateDeal, moveDealToStage as dbMoveDealToStage } from '@lib/data/deals'
import { toggleTaskDone as dbToggleTaskDone, createTask as dbCreateTask } from '@lib/data/tasks'
import { logActivity as dbLogActivity } from '@lib/data/activities'
import type { DealStage, LeadSource, LeadStatus, Priority, ActivityKind } from '@prisma/client'

const LEAD_STATUSES: LeadStatus[] = ['new', 'contacted', 'qualified', 'unqualified', 'lost']
const DEAL_STAGES: DealStage[] = ['discovery', 'proposal', 'negotiation', 'contract', 'won', 'lost']
const PRIORITIES: Priority[] = ['low', 'medium', 'high']
const LEAD_SOURCES: LeadSource[] = ['Inbound', 'Outbound', 'Referral', 'Event', 'Partner', 'Website']
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Optimistic creates use a client-generated UUID as the row id; reject anything else. */
function assertClientId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new Error('Invalid id')
}

const STAGE_PROBABILITY: Record<string, number> = {
  discovery: 20,
  proposal: 45,
  negotiation: 65,
  contract: 85,
  won: 100,
  lost: 0,
}

export async function moveDealAction(dealId: string, stage: DealStage) {
  const { orgId } = await requireAuth()
  await dbMoveDealToStage(orgId, dealId, stage, STAGE_PROBABILITY[stage] ?? 25)
  revalidatePath('/', 'layout')
}

export async function createLeadAction(input: {
  id: string
  name: string
  email: string
  phone: string
  company: string
  source: LeadSource
  status: LeadStatus
  ownerId: string
  notes?: string
}) {
  const { orgId, ownerId: actorId } = await requireAuth()
  assertClientId(input.id)

  const name = input.name.trim()
  const company = input.company.trim()
  const email = input.email.trim()
  const phone = input.phone.trim()
  const notes = input.notes?.trim()
  if (!name || name.length > 200) throw new Error('Name is required')
  if (!company || company.length > 200) throw new Error('Company is required')
  if (email && (email.length > 320 || !EMAIL_RE.test(email))) throw new Error('Invalid email')
  if (phone.length > 60) throw new Error('Invalid phone')
  if (notes && notes.length > 5000) throw new Error('Notes are too long')
  if (!LEAD_SOURCES.includes(input.source)) throw new Error('Invalid source')
  if (!LEAD_STATUSES.includes(input.status)) throw new Error('Invalid status')

  // ownerId comes from the client — make sure it belongs to this org before connecting it.
  const owner = await getOwnerById(orgId, input.ownerId)
  if (!owner) throw new Error('Owner not found')

  const subject = { subjectType: 'lead' as const, subjectLabel: name }
  const lead = await dbCreateLead(orgId, {
    id: input.id,
    name,
    title: '',
    company,
    email,
    phone,
    location: '',
    status: input.status,
    source: input.source,
    owner: { connect: { id: owner.id } },
    activities: {
      create: [
        {
          orgId,
          kind: 'created',
          title: `created lead ${name}`,
          actor: { connect: { id: actorId } },
          ...subject,
        },
        ...(notes
          ? [
              {
                orgId,
                kind: 'note' as const,
                title: `added a note on ${name}`,
                body: notes,
                actor: { connect: { id: actorId } },
                ...subject,
              },
            ]
          : []),
      ],
    },
  })
  revalidatePath('/', 'layout')
  return { id: lead.id, createdAt: lead.createdAt.toISOString() }
}

export async function createDealAction(input: {
  id: string
  name: string
  company: string
  value: number
  stage: DealStage
  closeDate: string
  ownerId: string
  contactId?: string
  source: LeadSource
  priority: Priority
}) {
  const { orgId, ownerId: actorId } = await requireAuth()
  assertClientId(input.id)

  const name = input.name.trim()
  const companyInput = input.company.trim()
  const closeDate = new Date(input.closeDate)
  if (!name || name.length > 200) throw new Error('Name is required')
  if (companyInput.length > 200) throw new Error('Company is too long')
  if (!Number.isInteger(input.value) || input.value <= 0 || input.value > 1_000_000_000) {
    throw new Error('Invalid value')
  }
  if (!DEAL_STAGES.includes(input.stage)) throw new Error('Invalid stage')
  if (!LEAD_SOURCES.includes(input.source)) throw new Error('Invalid source')
  if (!PRIORITIES.includes(input.priority)) throw new Error('Invalid priority')
  if (Number.isNaN(closeDate.getTime())) throw new Error('Invalid close date')

  // ownerId and contactId come from the client — both must belong to this org.
  const owner = await getOwnerById(orgId, input.ownerId)
  if (!owner) throw new Error('Owner not found')
  let contact = null
  if (input.contactId) {
    contact = await getContactById(orgId, input.contactId)
    if (!contact) throw new Error('Contact not found')
  }

  const company = companyInput || contact?.company || ''
  if (!company) throw new Error('Company is required')

  const deal = await dbCreateDeal(orgId, {
    id: input.id,
    name,
    company,
    value: input.value,
    stage: input.stage,
    priority: input.priority,
    source: input.source,
    probability: STAGE_PROBABILITY[input.stage] ?? 25,
    closeDate,
    owner: { connect: { id: owner.id } },
    ...(contact && { contact: { connect: { id: contact.id } } }),
    activities: {
      create: [
        {
          orgId,
          kind: 'created',
          title: `created deal ${name}`,
          actor: { connect: { id: actorId } },
          subjectType: 'deal',
          subjectLabel: name,
        },
      ],
    },
  })
  revalidatePath('/', 'layout')
  return { id: deal.id }
}

export async function setLeadStatusAction(leadId: string, status: LeadStatus) {
  const { orgId } = await requireAuth()
  await dbUpdateLeadStatus(orgId, leadId, status)
  revalidatePath('/', 'layout')
}

export async function convertLeadAction(
  leadId: string,
  input: {
    ownerId: string
    contactId: string
    dealId?: string
    deal?: {
      name: string
      value: number
      stage: DealStage
      closeDate: string
      priority: Priority
    }
  },
) {
  const { orgId, ownerId: actorId } = await requireAuth()
  assertClientId(input.contactId)
  if (input.deal) assertClientId(input.dealId)

  // ownerId comes from the client — make sure it belongs to this org before using it.
  if (!(await getOwnerById(orgId, input.ownerId))) throw new Error('Owner not found')

  const result = await dbConvertLeadToDeal(orgId, leadId, {
    ownerId: input.ownerId,
    actorId,
    contactId: input.contactId,
    dealId: input.deal ? input.dealId : undefined,
    deal: input.deal
      ? {
          ...input.deal,
          closeDate: new Date(input.deal.closeDate),
        }
      : undefined,
  })
  revalidatePath('/', 'layout')
  return {
    contactId: result.contact.id,
    dealId: result.deal?.id ?? null,
  }
}

export async function toggleTaskAction(taskId: string, done: boolean) {
  const { orgId } = await requireAuth()
  await dbToggleTaskDone(orgId, taskId, done)
  revalidatePath('/', 'layout')
}

export async function addTaskAction(input: {
  id: string
  title: string
  dueDate: string
  priority: Priority
  subject?: { type: 'lead' | 'contact' | 'deal'; id: string; label: string }
}) {
  const { orgId, ownerId } = await requireAuth()
  assertClientId(input.id)
  await dbCreateTask(orgId, {
    id: input.id,
    title: input.title,
    dueDate: new Date(input.dueDate),
    priority: input.priority,
    type: 'todo',
    owner: { connect: { id: ownerId } },
    ...(input.subject?.type === 'lead' && {
      relatedToType: 'lead',
      relatedToLabel: input.subject.label,
      lead: { connect: { id: input.subject.id } },
    }),
    ...(input.subject?.type === 'contact' && {
      relatedToType: 'contact',
      relatedToLabel: input.subject.label,
      contact: { connect: { id: input.subject.id } },
    }),
    ...(input.subject?.type === 'deal' && {
      relatedToType: 'deal',
      relatedToLabel: input.subject.label,
      deal: { connect: { id: input.subject.id } },
    }),
  })
  revalidatePath('/', 'layout')
}

export async function logActivityAction(
  kind: ActivityKind,
  title: string,
  subject?: { type: 'lead' | 'contact' | 'deal'; id: string; label: string },
  body?: string,
) {
  const { orgId, ownerId } = await requireAuth()
  await dbLogActivity(orgId, {
    kind,
    title,
    body,
    actor: { connect: { id: ownerId } },
    ...(subject?.type === 'lead' && {
      subjectType: 'lead',
      subjectLabel: subject.label,
      lead: { connect: { id: subject.id } },
    }),
    ...(subject?.type === 'contact' && {
      subjectType: 'contact',
      subjectLabel: subject.label,
      contact: { connect: { id: subject.id } },
    }),
    ...(subject?.type === 'deal' && {
      subjectType: 'deal',
      subjectLabel: subject.label,
      deal: { connect: { id: subject.id } },
    }),
  })
  revalidatePath('/', 'layout')
}

export async function addNoteAction(
  subject: { type: 'lead' | 'contact' | 'deal'; id: string; label: string },
  body: string,
) {
  await logActivityAction('note', `added a note on ${subject.label}`, subject, body)
}
