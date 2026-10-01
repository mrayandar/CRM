'use server'

import { revalidatePath } from 'next/cache'
import { requireAuth } from '@lib/auth'
import { updateOrgQuota } from '@lib/data/organizations'
import {
  createLead as dbCreateLead,
  getLeadById,
  updateLead as dbUpdateLead,
  updateLeadStatus as dbUpdateLeadStatus,
  convertLeadToDeal as dbConvertLeadToDeal,
} from '@lib/data/leads'
import { getOwnerById, updateOwnerProfile } from '@lib/data/owners'
import {
  getCompanyById,
  getCompanyByName,
  createCompany as dbCreateCompany,
  updateCompany as dbUpdateCompany,
  deleteCompany as dbDeleteCompany,
} from '@lib/data/companies'
import {
  createContact as dbCreateContact,
  getContactByEmail,
  getContactById,
  updateContact as dbUpdateContact,
} from '@lib/data/contacts'
import {
  createDeal as dbCreateDeal,
  getDealById,
  moveDealToStage as dbMoveDealToStage,
  updateDeal as dbUpdateDeal,
} from '@lib/data/deals'
import {
  toggleTaskDone as dbToggleTaskDone,
  createTask as dbCreateTask,
  updateTask as dbUpdateTask,
  deleteTask as dbDeleteTask,
} from '@lib/data/tasks'
import { logActivity as dbLogActivity } from '@lib/data/activities'
import {
  getStageById,
  createStage as dbCreateStage,
  renameStage as dbRenameStage,
  reorderStage as dbReorderStage,
  deleteStage as dbDeleteStage,
} from '@lib/data/stages'
import type { LeadSource, LeadStatus, Priority, ActivityKind, TaskType } from '@prisma/client'

const LEAD_STATUSES: LeadStatus[] = ['new', 'contacted', 'qualified', 'unqualified', 'lost']
const PRIORITIES: Priority[] = ['low', 'medium', 'high']
const TASK_TYPES: TaskType[] = ['call', 'email', 'meeting', 'todo']
const LEAD_SOURCES: LeadSource[] = ['Inbound', 'Outbound', 'Referral', 'Event', 'Partner', 'Website']
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A lead/contact/deal id from the client must belong to the caller's org before it is linked. */
async function assertSubjectInOrg(orgId: string, subject?: { type: 'lead' | 'contact' | 'deal'; id: string }) {
  if (!subject) return
  const found =
    subject.type === 'lead'
      ? await getLeadById(orgId, subject.id)
      : subject.type === 'contact'
        ? await getContactById(orgId, subject.id)
        : await getDealById(orgId, subject.id)
  if (!found) throw new Error(`${subject.type} not found`)
}

/** Optimistic creates use a client-generated UUID as the row id; reject anything else. */
function assertClientId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new Error('Invalid id')
}

export async function createCompanyAction(input: {
  id: string
  name: string
  website?: string
  industry?: string
  notes?: string
}) {
  const { orgId } = await requireAuth()
  assertClientId(input.id)

  const name = input.name.trim()
  const website = input.website?.trim() || undefined
  const industry = input.industry?.trim() || undefined
  const notes = input.notes?.trim() || undefined
  if (!name || name.length > 200) throw new Error('Company name is required')
  if (website && website.length > 300) throw new Error('Website is too long')
  if (industry && industry.length > 200) throw new Error('Industry is too long')
  if (notes && notes.length > 5000) throw new Error('Notes are too long')

  // Avoid creating a second row for a name that (modulo case) already exists — the inline
  // create-or-select picker should always resolve to one company per distinct name per org.
  const existing = await getCompanyByName(orgId, name)
  if (existing) return { id: existing.id, name: existing.name, existing: true as const }

  const company = await dbCreateCompany(orgId, { id: input.id, name, website, industry, notes })
  revalidatePath('/', 'layout')
  return { id: company.id, name: company.name, existing: false as const }
}

export async function updateCompanyAction(input: {
  id: string
  name: string
  website?: string
  industry?: string
  notes?: string
}) {
  const { orgId } = await requireAuth()

  const name = input.name.trim()
  const website = input.website?.trim() || undefined
  const industry = input.industry?.trim() || undefined
  const notes = input.notes?.trim() || undefined
  if (!name || name.length > 200) throw new Error('Company name is required')
  if (website && website.length > 300) throw new Error('Website is too long')
  if (industry && industry.length > 200) throw new Error('Industry is too long')
  if (notes && notes.length > 5000) throw new Error('Notes are too long')

  await dbUpdateCompany(orgId, input.id, { name, website, industry, notes })
  revalidatePath('/', 'layout')
}

export async function deleteCompanyAction(companyId: string) {
  const { orgId } = await requireAuth()
  await dbDeleteCompany(orgId, companyId)
  revalidatePath('/', 'layout')
}

export async function moveDealAction(dealId: string, stageId: string) {
  const { orgId } = await requireAuth()
  // stageId comes from the client (the kanban column it was dropped on) — must belong to this org.
  const stage = await getStageById(orgId, stageId)
  if (!stage) throw new Error('Stage not found')
  await dbMoveDealToStage(orgId, dealId, stage)
  revalidatePath('/', 'layout')
}

export async function createLeadAction(input: {
  id: string
  name: string
  email: string
  phone: string
  companyId: string
  source: LeadSource
  status: LeadStatus
  ownerId: string
  notes?: string
}) {
  const { orgId, ownerId: actorId } = await requireAuth()
  assertClientId(input.id)

  const name = input.name.trim()
  const email = input.email.trim()
  const phone = input.phone.trim()
  const notes = input.notes?.trim()
  if (!name || name.length > 200) throw new Error('Name is required')
  if (email && (email.length > 320 || !EMAIL_RE.test(email))) throw new Error('Invalid email')
  if (phone.length > 60) throw new Error('Invalid phone')
  if (notes && notes.length > 5000) throw new Error('Notes are too long')
  if (!LEAD_SOURCES.includes(input.source)) throw new Error('Invalid source')
  if (!LEAD_STATUSES.includes(input.status)) throw new Error('Invalid status')

  // ownerId and companyId come from the client — both must belong to this org before connecting them.
  const owner = await getOwnerById(orgId, input.ownerId)
  if (!owner) throw new Error('Owner not found')
  const company = await getCompanyById(orgId, input.companyId)
  if (!company) throw new Error('Company not found')

  const subject = { subjectType: 'lead' as const, subjectLabel: name }
  const lead = await dbCreateLead(orgId, {
    id: input.id,
    name,
    title: '',
    company: { connect: { id: company.id } },
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

export async function createContactAction(input: {
  id: string
  name: string
  email: string
  phone: string
  companyId: string
  title: string
  ownerId: string
}) {
  const { orgId, ownerId: actorId } = await requireAuth()
  assertClientId(input.id)

  const name = input.name.trim()
  const title = input.title.trim()
  const email = input.email.trim()
  const phone = input.phone.trim()
  if (!name || name.length > 200) throw new Error('Name is required')
  if (title.length > 200) throw new Error('Title is too long')
  if (email && (email.length > 320 || !EMAIL_RE.test(email))) throw new Error('Invalid email')
  if (phone.length > 60) throw new Error('Invalid phone')

  // ownerId and companyId come from the client — both must belong to this org before connecting them.
  const owner = await getOwnerById(orgId, input.ownerId)
  if (!owner) throw new Error('Owner not found')
  const company = await getCompanyById(orgId, input.companyId)
  if (!company) throw new Error('Company not found')

  // Email is optional; only a non-blank email can collide. Returned (not thrown) because it's an
  // expected validation failure — thrown messages are redacted from the client in production.
  if (email && (await getContactByEmail(orgId, email))) {
    return { ok: false as const, error: 'A contact with this email already exists' }
  }

  const contact = await dbCreateContact(orgId, {
    id: input.id,
    name,
    title,
    company: { connect: { id: company.id } },
    email,
    phone,
    location: '',
    tags: [],
    lifecycle: 'Prospect',
    owner: { connect: { id: owner.id } },
    activities: {
      create: [
        {
          orgId,
          kind: 'created',
          title: `created contact ${name}`,
          actor: { connect: { id: actorId } },
          subjectType: 'contact',
          subjectLabel: name,
        },
      ],
    },
  })
  revalidatePath('/', 'layout')
  return { ok: true as const, id: contact.id }
}

export async function updateContactAction(input: {
  id: string
  name: string
  title: string
  email: string
  phone: string
  companyId: string
  ownerId: string
}) {
  const { orgId, ownerId: actorId } = await requireAuth()

  const name = input.name.trim()
  const title = input.title.trim()
  const email = input.email.trim()
  const phone = input.phone.trim()
  if (!name || name.length > 200) throw new Error('Name is required')
  if (title.length > 200) throw new Error('Title is too long')
  if (email && (email.length > 320 || !EMAIL_RE.test(email))) throw new Error('Invalid email')
  if (phone.length > 60) throw new Error('Invalid phone')

  // ownerId and companyId come from the client — both must belong to this org before connecting them.
  const owner = await getOwnerById(orgId, input.ownerId)
  if (!owner) throw new Error('Owner not found')
  const company = await getCompanyById(orgId, input.companyId)
  if (!company) throw new Error('Company not found')

  // Same duplicate-email guard as creation, minus the inline-error UX: the edit modal doesn't await
  // this (persist()'s toast + revert instead), so a thrown error is enough — no {ok, error} shape
  // needed here. A contact matching itself (unchanged email) is not a duplicate.
  if (email) {
    const existing = await getContactByEmail(orgId, email)
    if (existing && existing.id !== input.id) throw new Error('A contact with this email already exists')
  }

  await dbUpdateContact(
    orgId,
    input.id,
    { name, title, email, phone, companyId: company.id, ownerId: owner.id },
    actorId,
  )
  revalidatePath('/', 'layout')
}

export async function createDealAction(input: {
  id: string
  name: string
  companyId?: string
  value: number
  stageId: string
  closeDate: string
  ownerId: string
  contactId?: string
  source: LeadSource
  priority: Priority
}) {
  const { orgId, ownerId: actorId } = await requireAuth()
  assertClientId(input.id)

  const name = input.name.trim()
  const closeDate = new Date(input.closeDate)
  if (!name || name.length > 200) throw new Error('Name is required')
  if (!Number.isInteger(input.value) || input.value <= 0 || input.value > 1_000_000_000) {
    throw new Error('Invalid value')
  }
  if (!LEAD_SOURCES.includes(input.source)) throw new Error('Invalid source')
  if (!PRIORITIES.includes(input.priority)) throw new Error('Invalid priority')
  if (Number.isNaN(closeDate.getTime())) throw new Error('Invalid close date')

  // ownerId, contactId, and stageId all come from the client — every one must belong to this org.
  const owner = await getOwnerById(orgId, input.ownerId)
  if (!owner) throw new Error('Owner not found')
  const stage = await getStageById(orgId, input.stageId)
  if (!stage) throw new Error('Stage not found')
  let contact = null
  if (input.contactId) {
    contact = await getContactById(orgId, input.contactId)
    if (!contact) throw new Error('Contact not found')
  }

  // Company is required on a deal; falls back to the linked contact's company when none is
  // explicitly chosen (mirrors the old company-string inheritance behavior).
  const companyId = input.companyId || contact?.companyId
  if (!companyId) throw new Error('Company is required')
  const company = await getCompanyById(orgId, companyId)
  if (!company) throw new Error('Company not found')

  const deal = await dbCreateDeal(orgId, {
    id: input.id,
    name,
    company: { connect: { id: company.id } },
    value: input.value,
    stage: { connect: { id: stage.id } },
    priority: input.priority,
    source: input.source,
    probability: stage.probability,
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

export async function updateDealAction(input: {
  id: string
  name: string
  value: number
  stageId: string
  closeDate: string
  contactId?: string
  ownerId: string
  companyId: string
}) {
  const { orgId, ownerId: actorId } = await requireAuth()

  const name = input.name.trim()
  const closeDate = new Date(input.closeDate)
  if (!name || name.length > 200) throw new Error('Name is required')
  if (!Number.isInteger(input.value) || input.value <= 0 || input.value > 1_000_000_000) {
    throw new Error('Invalid value')
  }
  if (Number.isNaN(closeDate.getTime())) throw new Error('Invalid close date')

  // ownerId, contactId, stageId, and companyId all come from the client — every one must belong
  // to this org.
  const owner = await getOwnerById(orgId, input.ownerId)
  if (!owner) throw new Error('Owner not found')
  const stage = await getStageById(orgId, input.stageId)
  if (!stage) throw new Error('Stage not found')
  const company = await getCompanyById(orgId, input.companyId)
  if (!company) throw new Error('Company not found')
  let contact = null
  if (input.contactId) {
    contact = await getContactById(orgId, input.contactId)
    if (!contact) throw new Error('Contact not found')
  }

  await dbUpdateDeal(
    orgId,
    input.id,
    {
      name,
      value: input.value,
      stage: { id: stage.id, probability: stage.probability, isWon: stage.isWon },
      closeDate,
      contactId: contact?.id ?? null,
      ownerId: owner.id,
      companyId: company.id,
    },
    actorId,
  )
  revalidatePath('/', 'layout')
}

export async function updateLeadAction(input: {
  id: string
  name: string
  title: string
  email: string
  phone: string
  companyId: string
  source: LeadSource
  ownerId: string
}) {
  const { orgId, ownerId: actorId } = await requireAuth()

  const name = input.name.trim()
  const title = input.title.trim()
  const email = input.email.trim()
  const phone = input.phone.trim()
  if (!name || name.length > 200) throw new Error('Name is required')
  if (title.length > 200) throw new Error('Title is too long')
  if (email && (email.length > 320 || !EMAIL_RE.test(email))) throw new Error('Invalid email')
  if (phone.length > 60) throw new Error('Invalid phone')
  if (!LEAD_SOURCES.includes(input.source)) throw new Error('Invalid source')

  // ownerId and companyId come from the client — both must belong to this org before connecting them.
  const owner = await getOwnerById(orgId, input.ownerId)
  if (!owner) throw new Error('Owner not found')
  const company = await getCompanyById(orgId, input.companyId)
  if (!company) throw new Error('Company not found')

  await dbUpdateLead(
    orgId,
    input.id,
    { name, title, email, phone, companyId: company.id, source: input.source, ownerId: owner.id },
    actorId,
  )
  revalidatePath('/', 'layout')
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
      stageId: string
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

  // Same for the new deal's stageId, when a deal is being opened as part of the conversion.
  const stage = input.deal ? await getStageById(orgId, input.deal.stageId) : null
  if (input.deal && !stage) throw new Error('Stage not found')

  const result = await dbConvertLeadToDeal(orgId, leadId, {
    ownerId: input.ownerId,
    actorId,
    contactId: input.contactId,
    dealId: input.deal ? input.dealId : undefined,
    deal:
      input.deal && stage
        ? {
            name: input.deal.name,
            value: input.deal.value,
            priority: input.deal.priority,
            stage: { id: stage.id, probability: stage.probability },
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
  type?: TaskType
  /** Assignee; defaults to the caller. Must belong to the caller's org. */
  ownerId?: string
  subject?: { type: 'lead' | 'contact' | 'deal'; id: string; label: string }
}) {
  const { orgId, ownerId: callerId } = await requireAuth()
  assertClientId(input.id)

  const title = input.title.trim()
  const dueDate = new Date(input.dueDate)
  const type = input.type ?? 'todo'
  if (!title || title.length > 500) throw new Error('Title is required')
  if (Number.isNaN(dueDate.getTime())) throw new Error('Invalid due date')
  if (!PRIORITIES.includes(input.priority)) throw new Error('Invalid priority')
  if (!TASK_TYPES.includes(type)) throw new Error('Invalid task type')

  // ownerId comes from the client — an assignee other than the caller must be verified to belong to this org.
  let assigneeId = callerId
  if (input.ownerId && input.ownerId !== callerId) {
    const assignee = await getOwnerById(orgId, input.ownerId)
    if (!assignee) throw new Error('Owner not found')
    assigneeId = assignee.id
  }

  await assertSubjectInOrg(orgId, input.subject)
  await dbCreateTask(orgId, {
    id: input.id,
    title,
    dueDate,
    priority: input.priority,
    type,
    owner: { connect: { id: assigneeId } },
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

export async function updateTaskAction(input: {
  id: string
  title: string
  description?: string
  dueDate: string
  priority: Priority
  type: TaskType
  ownerId: string
}) {
  const { orgId, ownerId: actorId } = await requireAuth()

  const title = input.title.trim()
  const description = input.description?.trim() || null
  const dueDate = new Date(input.dueDate)
  if (!title || title.length > 500) throw new Error('Title is required')
  if (description && description.length > 5000) throw new Error('Description is too long')
  if (Number.isNaN(dueDate.getTime())) throw new Error('Invalid due date')
  if (!PRIORITIES.includes(input.priority)) throw new Error('Invalid priority')
  if (!TASK_TYPES.includes(input.type)) throw new Error('Invalid task type')

  // ownerId comes from the client — make sure it belongs to this org before connecting it.
  const owner = await getOwnerById(orgId, input.ownerId)
  if (!owner) throw new Error('Owner not found')

  await dbUpdateTask(
    orgId,
    input.id,
    { title, description, dueDate, priority: input.priority, type: input.type, ownerId: owner.id },
    actorId,
  )
  revalidatePath('/', 'layout')
}

export async function deleteTaskAction(taskId: string) {
  const { orgId } = await requireAuth()
  await dbDeleteTask(orgId, taskId)
  revalidatePath('/', 'layout')
}

export async function logActivityAction(
  kind: ActivityKind,
  title: string,
  subject?: { type: 'lead' | 'contact' | 'deal'; id: string; label: string },
  body?: string,
) {
  const { orgId, ownerId } = await requireAuth()
  await assertSubjectInOrg(orgId, subject)
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

export async function updateProfileAction(input: { name: string; timezone: string | null }) {
  const { orgId, ownerId } = await requireAuth()

  const name = input.name.trim()
  if (!name || name.length > 200) throw new Error('Name is required')
  const timezone = input.timezone?.trim() || null
  if (timezone && timezone.length > 100) throw new Error('Invalid time zone')

  await updateOwnerProfile(orgId, ownerId, { name, timezone })
  revalidatePath('/', 'layout')
}

export async function updateQuotaAction(input: { quarterlyQuota: number | null }) {
  const { orgId } = await requireAuth()

  const quota = input.quarterlyQuota
  if (quota !== null && (!Number.isInteger(quota) || quota < 0 || quota > 1_000_000_000)) {
    throw new Error('Invalid quota')
  }

  await updateOrgQuota(orgId, quota)
  revalidatePath('/', 'layout')
}

export async function createStageAction(input: { id: string; label: string }) {
  const { orgId } = await requireAuth()
  assertClientId(input.id)
  const label = input.label.trim()
  if (!label || label.length > 100) throw new Error('Stage name is required')
  await dbCreateStage(orgId, { id: input.id, label })
  revalidatePath('/', 'layout')
}

export async function renameStageAction(stageId: string, label: string) {
  const { orgId } = await requireAuth()
  const trimmed = label.trim()
  if (!trimmed || trimmed.length > 100) throw new Error('Stage name is required')
  // dbRenameStage does its own findFirst({id, orgId}) check — same tenant-check convention as
  // every other update in lib/data/*.ts.
  await dbRenameStage(orgId, stageId, trimmed)
  revalidatePath('/', 'layout')
}

export async function reorderStageAction(stageId: string, direction: 'up' | 'down') {
  const { orgId } = await requireAuth()
  await dbReorderStage(orgId, stageId, direction)
  revalidatePath('/', 'layout')
}

export async function deleteStageAction(stageId: string) {
  const { orgId } = await requireAuth()
  await dbDeleteStage(orgId, stageId)
  revalidatePath('/', 'layout')
}

export async function addNoteAction(
  subject: { type: 'lead' | 'contact' | 'deal'; id: string; label: string },
  body: string,
) {
  await logActivityAction('note', `added a note on ${subject.label}`, subject, body)
}
