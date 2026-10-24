'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { Prisma } from '@prisma/client'
import { clerkClient } from '@clerk/nextjs/server'
import { requireAuth, requireAdmin, requireLiveAdminAccess } from '@lib/auth'
import { tryAdminSession, FORBIDDEN, type ForbiddenResult } from '@lib/actions/shared'
import type { Scope } from '@lib/scope'
import { assertOwnerInScope } from '@lib/scope'
import { updateOrgQuota, updateOrgCurrency, updateOrgTimezone, updateRepVisibility } from '@lib/data/organizations'
import { isValidIanaTimezone } from '@lib/timezones'
import { CURRENCY_CODES } from '@/data/types'
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
import type { LeadSource, LeadStatus, Priority, ActivityKind, TaskType, RepVisibility } from '@prisma/client'
import { EMAIL_RE, LEAD_SOURCES, LEAD_STATUSES, assertClientId } from '@lib/validation'

const PRIORITIES: Priority[] = ['low', 'medium', 'high']
const TASK_TYPES: TaskType[] = ['call', 'email', 'meeting', 'todo']
const ACTIVITY_KINDS: ActivityKind[] = ['call', 'email', 'meeting', 'note', 'stage', 'created', 'edited', 'task', 'won', 'lost', 'payment']

/** A lead/contact/deal id from the client must belong to the caller's scope before it is linked —
 *  a cross-tenant id and (once scoped) another rep's id are rejected identically. Returns the
 *  found subject (so callers needing its current `ownerId` — e.g. for a denormalized
 *  Activity.ownerId — don't issue a second query), or `undefined` when no subject was given. */
async function assertSubjectInScope(
  scope: Scope,
  subject?: { type: 'lead' | 'contact' | 'deal'; id: string },
): Promise<{ ownerId: string } | undefined> {
  if (!subject) return undefined
  const found =
    subject.type === 'lead'
      ? await getLeadById(scope, subject.id)
      : subject.type === 'contact'
        ? await getContactById(scope, subject.id)
        : await getDealById(scope, subject.id)
  if (!found) throw new Error(`${subject.type} not found`)
  return found
}

/**
 * Wraps a create call that writes a client-supplied id as a row's primary key. Converts only a
 * primary-key collision (`meta.target` includes "id") into one deliberate, uniform error — the
 * same message and shape whether the id already exists in this org (e.g. a retried double-submit)
 * or in a completely different one (a guess/collision), so neither case leaks which one happened.
 * Every other unique-constraint violation (a duplicate email, say) is a real validation signal
 * and is rethrown untouched — those already have their own specific handling at each call site.
 *
 * This used to be an accident of Next's production-only error-message redaction, never
 * application code's own decision — explicit here so the guarantee holds in dev mode too, and
 * wouldn't quietly stop holding if this code ever moved to a plain API route.
 */
async function guardAgainstIdCollision<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      Array.isArray(err.meta?.target) &&
      (err.meta!.target as string[]).includes('id')
    ) {
      throw new Error('Could not create record')
    }
    throw err
  }
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

  const company = await guardAgainstIdCollision(() =>
    dbCreateCompany(orgId, { id: input.id, name, website, industry, notes }),
  )
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

/**
 * Admin-only via `requireAdmin()` — found and fixed in the Stage 1c role-rule follow-up: deleting
 * a company is destructive and org-wide (every Lead/Contact/Deal linked to it would need
 * reassigning first), unlike editing one's fields, which stays open to any Member. Creating one
 * also stays open to any Member — see createCompanyAction.
 */
export async function deleteCompanyAction(companyId: string): Promise<{ ok: true } | ForbiddenResult> {
  const session = await tryAdminSession(requireAdmin)
  if (!session) return FORBIDDEN
  await dbDeleteCompany(session.orgId, companyId)
  revalidatePath('/', 'layout')
  return { ok: true }
}

const ORG_ROLES = ['org:admin', 'org:member'] as const

/**
 * Creates a real Clerk organization invitation server-side via the Backend API, instead of the
 * client SDK's `organization.inviteMember()` — that method has no `redirectUrl` parameter, so
 * without this, Clerk falls back to its own hosted Account Portal (`<slug>.accounts.dev`) for the
 * invitation's "Accept invitation" link, bouncing the invitee to a generic Clerk-branded page
 * instead of this app's own sign-up flow. `redirectUrl` here is exactly the dashboard-level
 * setting middleware.ts's `signInUrl`/`signUpUrl` already pin for the ordinary sign-in/up flows —
 * organization invitations just aren't covered by those, and need their own.
 *
 * Admin-only via `requireAdmin()` — found and fixed during a role-rule audit: this previously
 * checked only `auth()` for a valid session, with no role check at all, so any Member could
 * invite a new member AND choose `role: 'org:admin'` for them — a Member could hand out Admin
 * access to anyone, including themselves via a second account. `input.role` is still a
 * client-chosen value (an Admin may legitimately invite either role), but only an Admin can reach
 * this action at all now.
 */
export async function inviteMemberAction(
  input: { emailAddress: string; role: 'org:admin' | 'org:member' },
): Promise<{ ok: true } | ForbiddenResult> {
  const session = await tryAdminSession(requireAdmin)
  if (!session) return FORBIDDEN
  const { clerkUserId: userId, clerkOrgId } = session

  const email = input.emailAddress.trim()
  if (!email || email.length > 320 || !EMAIL_RE.test(email)) throw new Error('Invalid email')
  if (!ORG_ROLES.includes(input.role)) throw new Error('Invalid role')

  const h = await headers()
  const host = h.get('host') ?? 'localhost:3000'
  const protocol = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https'

  const clerk = await clerkClient()
  await clerk.organizations.createOrganizationInvitation({
    organizationId: clerkOrgId,
    emailAddress: email,
    role: input.role,
    inviterUserId: userId,
    redirectUrl: `${protocol}://${host}/sign-up`,
  })
  revalidatePath('/', 'layout')
  return { ok: true }
}

export async function moveDealAction(dealId: string, stageId: string) {
  const { orgId, scopeOwnerId } = await requireAuth()
  const scope: Scope = { orgId, scopeOwnerId }
  // stageId comes from the client (the kanban column it was dropped on) — must belong to this org.
  const stage = await getStageById(orgId, stageId)
  if (!stage) throw new Error('Stage not found')
  await dbMoveDealToStage(scope, dealId, stage)
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
  /** A calendar date (e.g. "2026-03-10"), not an instant — see Lead.followUpAt's schema doc
   *  comment. Omit/empty clears it. */
  followUpAt?: string
  /** Client-generated id for the "created lead" activity (see logActivityAction's `id` param). */
  activityId: string
  /** Same, for the optional note activity — only used when `notes` is set. */
  noteActivityId?: string
}) {
  const { orgId, ownerId: actorId, scopeOwnerId } = await requireAuth()
  const scope: Scope = { orgId, scopeOwnerId }
  assertClientId(input.id)
  assertClientId(input.activityId)

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
  if (notes) assertClientId(input.noteActivityId)
  const followUpAt = input.followUpAt ? new Date(input.followUpAt) : null
  if (followUpAt && Number.isNaN(followUpAt.getTime())) throw new Error('Invalid follow-up date')

  // ownerId and companyId come from the client — both must belong to this org before connecting
  // them, and (once scoped) a Member may only create a lead owned by themselves.
  assertOwnerInScope(scope, input.ownerId)
  const owner = await getOwnerById(orgId, input.ownerId)
  if (!owner) throw new Error('Owner not found')
  const company = await getCompanyById(orgId, input.companyId)
  if (!company) throw new Error('Company not found')

  const subject = { subjectType: 'lead' as const, subjectLabel: name }
  const lead = await guardAgainstIdCollision(() =>
    dbCreateLead(scope, {
      id: input.id,
      name,
      title: '',
      company: { connect: { id: company.id } },
      email,
      phone,
      location: '',
      status: input.status,
      source: input.source,
      followUpAt,
      owner: { connect: { id: owner.id } },
      activities: {
        create: [
          {
            id: input.activityId,
            orgId,
            kind: 'created',
            title: `created lead ${name}`,
            actor: { connect: { id: actorId } },
            ownerId: owner.id,
            ...subject,
          },
          ...(notes
            ? [
                {
                  id: input.noteActivityId,
                  orgId,
                  kind: 'note' as const,
                  title: `added a note on ${name}`,
                  body: notes,
                  actor: { connect: { id: actorId } },
                  ownerId: owner.id,
                  ...subject,
                },
              ]
            : []),
        ],
      },
    }),
  )
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
  /** Client-generated id for the "created contact" activity (see logActivityAction's `id` param). */
  activityId: string
}) {
  const { orgId, ownerId: actorId, scopeOwnerId } = await requireAuth()
  const scope: Scope = { orgId, scopeOwnerId }
  assertClientId(input.id)
  assertClientId(input.activityId)

  const name = input.name.trim()
  const title = input.title.trim()
  const email = input.email.trim()
  const phone = input.phone.trim()
  if (!name || name.length > 200) throw new Error('Name is required')
  if (title.length > 200) throw new Error('Title is too long')
  if (email && (email.length > 320 || !EMAIL_RE.test(email))) throw new Error('Invalid email')
  if (phone.length > 60) throw new Error('Invalid phone')

  // ownerId and companyId come from the client — both must belong to this org before connecting
  // them, and (once scoped) a Member may only create a contact owned by themselves.
  assertOwnerInScope(scope, input.ownerId)
  const owner = await getOwnerById(orgId, input.ownerId)
  if (!owner) throw new Error('Owner not found')
  const company = await getCompanyById(orgId, input.companyId)
  if (!company) throw new Error('Company not found')

  // Email is optional; only a non-blank email can collide. Returned (not thrown) because it's an
  // expected validation failure — thrown messages are redacted from the client in production.
  if (email && (await getContactByEmail(scope, email))) {
    return { ok: false as const, error: 'A contact with this email already exists' }
  }

  const contact = await guardAgainstIdCollision(() =>
    dbCreateContact(scope, {
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
            id: input.activityId,
            orgId,
            kind: 'created',
            title: `created contact ${name}`,
            actor: { connect: { id: actorId } },
            ownerId: owner.id,
            subjectType: 'contact',
            subjectLabel: name,
          },
        ],
      },
    }),
  )
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
  /** Client-generated id for the "edited" activity (see logActivityAction's `id` param). */
  activityId: string
}) {
  const { orgId, ownerId: actorId, scopeOwnerId } = await requireAuth()
  const scope: Scope = { orgId, scopeOwnerId }
  assertClientId(input.activityId)

  const name = input.name.trim()
  const title = input.title.trim()
  const email = input.email.trim()
  const phone = input.phone.trim()
  if (!name || name.length > 200) throw new Error('Name is required')
  if (title.length > 200) throw new Error('Title is too long')
  if (email && (email.length > 320 || !EMAIL_RE.test(email))) throw new Error('Invalid email')
  if (phone.length > 60) throw new Error('Invalid phone')

  // ownerId and companyId come from the client — both must belong to this org before connecting
  // them. Reassignment (the destination owner) is unrestricted even when scoped — dbUpdateContact's
  // own scoped findFirst already guarantees a scoped Member can only be reassigning a contact they
  // currently own; see assertOwnerInScope's doc comment for why creation and reassignment differ.
  const owner = await getOwnerById(orgId, input.ownerId)
  if (!owner) throw new Error('Owner not found')
  const company = await getCompanyById(orgId, input.companyId)
  if (!company) throw new Error('Company not found')

  // Same duplicate-email guard as creation, minus the inline-error UX: the edit modal doesn't await
  // this (persist()'s toast + revert instead), so a thrown error is enough — no {ok, error} shape
  // needed here. A contact matching itself (unchanged email) is not a duplicate.
  if (email) {
    const existing = await getContactByEmail(scope, email)
    if (existing && existing.id !== input.id) throw new Error('A contact with this email already exists')
  }

  await guardAgainstIdCollision(() =>
    dbUpdateContact(
      scope,
      input.id,
      { name, title, email, phone, companyId: company.id, ownerId: owner.id },
      actorId,
      input.activityId,
    ),
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
  /** Client-generated id for the "created deal" activity (see logActivityAction's `id` param). */
  activityId: string
}) {
  const { orgId, ownerId: actorId, scopeOwnerId } = await requireAuth()
  const scope: Scope = { orgId, scopeOwnerId }
  assertClientId(input.id)
  assertClientId(input.activityId)

  const name = input.name.trim()
  const closeDate = new Date(input.closeDate)
  if (!name || name.length > 200) throw new Error('Name is required')
  if (!Number.isInteger(input.value) || input.value <= 0 || input.value > 1_000_000_000) {
    throw new Error('Invalid value')
  }
  if (!LEAD_SOURCES.includes(input.source)) throw new Error('Invalid source')
  if (!PRIORITIES.includes(input.priority)) throw new Error('Invalid priority')
  if (Number.isNaN(closeDate.getTime())) throw new Error('Invalid close date')

  // ownerId, contactId, and stageId all come from the client — every one must belong to this org,
  // and (once scoped) a Member may only create a deal owned by themselves.
  assertOwnerInScope(scope, input.ownerId)
  const owner = await getOwnerById(orgId, input.ownerId)
  if (!owner) throw new Error('Owner not found')
  const stage = await getStageById(orgId, input.stageId)
  if (!stage) throw new Error('Stage not found')
  let contact = null
  if (input.contactId) {
    contact = await getContactById(scope, input.contactId)
    if (!contact) throw new Error('Contact not found')
  }

  // Company is required on a deal; falls back to the linked contact's company when none is
  // explicitly chosen (mirrors the old company-string inheritance behavior).
  const companyId = input.companyId || contact?.companyId
  if (!companyId) throw new Error('Company is required')
  const company = await getCompanyById(orgId, companyId)
  if (!company) throw new Error('Company not found')

  const deal = await guardAgainstIdCollision(() =>
    dbCreateDeal(scope, {
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
            id: input.activityId,
            orgId,
            kind: 'created',
            title: `created deal ${name}`,
            actor: { connect: { id: actorId } },
            ownerId: owner.id,
            subjectType: 'deal',
            subjectLabel: name,
          },
        ],
      },
    }),
  )
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
  /** Client-generated id for the "edited" activity (see logActivityAction's `id` param). */
  activityId: string
}) {
  const { orgId, ownerId: actorId, scopeOwnerId } = await requireAuth()
  const scope: Scope = { orgId, scopeOwnerId }
  assertClientId(input.activityId)

  const name = input.name.trim()
  const closeDate = new Date(input.closeDate)
  if (!name || name.length > 200) throw new Error('Name is required')
  if (!Number.isInteger(input.value) || input.value <= 0 || input.value > 1_000_000_000) {
    throw new Error('Invalid value')
  }
  if (Number.isNaN(closeDate.getTime())) throw new Error('Invalid close date')

  // ownerId, contactId, stageId, and companyId all come from the client — every one must belong
  // to this org. Reassignment (the destination owner) is unrestricted even when scoped — see
  // updateContactAction's identical note.
  const owner = await getOwnerById(orgId, input.ownerId)
  if (!owner) throw new Error('Owner not found')
  const stage = await getStageById(orgId, input.stageId)
  if (!stage) throw new Error('Stage not found')
  const company = await getCompanyById(orgId, input.companyId)
  if (!company) throw new Error('Company not found')
  let contact = null
  if (input.contactId) {
    contact = await getContactById(scope, input.contactId)
    if (!contact) throw new Error('Contact not found')
  }

  await guardAgainstIdCollision(() =>
    dbUpdateDeal(
      scope,
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
      input.activityId,
    ),
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
  /** A calendar date, not an instant — see createLeadAction's identical param. Omit/empty clears
   *  it. */
  followUpAt?: string
  /** Client-generated id for the "edited" activity (see logActivityAction's `id` param). */
  activityId: string
}) {
  const { orgId, ownerId: actorId, scopeOwnerId } = await requireAuth()
  const scope: Scope = { orgId, scopeOwnerId }
  assertClientId(input.activityId)

  const name = input.name.trim()
  const title = input.title.trim()
  const email = input.email.trim()
  const phone = input.phone.trim()
  if (!name || name.length > 200) throw new Error('Name is required')
  if (title.length > 200) throw new Error('Title is too long')
  if (email && (email.length > 320 || !EMAIL_RE.test(email))) throw new Error('Invalid email')
  if (phone.length > 60) throw new Error('Invalid phone')
  if (!LEAD_SOURCES.includes(input.source)) throw new Error('Invalid source')
  const followUpAt = input.followUpAt ? new Date(input.followUpAt) : null
  if (followUpAt && Number.isNaN(followUpAt.getTime())) throw new Error('Invalid follow-up date')

  // ownerId and companyId come from the client — both must belong to this org before connecting
  // them. Reassignment (the destination owner) is unrestricted even when scoped — see
  // updateContactAction's identical note.
  const owner = await getOwnerById(orgId, input.ownerId)
  if (!owner) throw new Error('Owner not found')
  const company = await getCompanyById(orgId, input.companyId)
  if (!company) throw new Error('Company not found')

  await guardAgainstIdCollision(() =>
    dbUpdateLead(
      scope,
      input.id,
      { name, title, email, phone, companyId: company.id, source: input.source, ownerId: owner.id, followUpAt },
      actorId,
      input.activityId,
    ),
  )
  revalidatePath('/', 'layout')
}

export async function setLeadStatusAction(leadId: string, status: LeadStatus) {
  const { orgId, scopeOwnerId } = await requireAuth()
  if (!LEAD_STATUSES.includes(status)) throw new Error('Invalid status')
  await dbUpdateLeadStatus({ orgId, scopeOwnerId }, leadId, status)
  revalidatePath('/', 'layout')
}

export async function convertLeadAction(
  leadId: string,
  input: {
    ownerId: string
    contactId: string
    dealId?: string
    /** Client-generated id for the "converted..." activity (see logActivityAction's `id` param). */
    activityId: string
    deal?: {
      name: string
      value: number
      stageId: string
      closeDate: string
      priority: Priority
    }
  },
) {
  const { orgId, ownerId: actorId, scopeOwnerId } = await requireAuth()
  const scope: Scope = { orgId, scopeOwnerId }
  assertClientId(input.contactId)
  assertClientId(input.activityId)
  if (input.deal) assertClientId(input.dealId)

  // ownerId comes from the client — make sure it belongs to this org before using it, and (once
  // scoped) that a Member can only ever convert to themselves, same rule as any other creation.
  assertOwnerInScope(scope, input.ownerId)
  if (!(await getOwnerById(orgId, input.ownerId))) throw new Error('Owner not found')

  // Same for the new deal's stageId, when a deal is being opened as part of the conversion.
  const stage = input.deal ? await getStageById(orgId, input.deal.stageId) : null
  if (input.deal && !stage) throw new Error('Stage not found')

  // The opened deal's fields get the identical validation createDealAction gives the same fields
  // — nothing distinguishes "created via conversion" from "created directly" in how trustworthy
  // the client's input is.
  let convertedDealClose: Date | undefined
  if (input.deal) {
    const dealName = input.deal.name.trim()
    convertedDealClose = new Date(input.deal.closeDate)
    if (!dealName || dealName.length > 200) throw new Error('Deal name is required')
    if (!Number.isInteger(input.deal.value) || input.deal.value <= 0 || input.deal.value > 1_000_000_000) {
      throw new Error('Invalid value')
    }
    if (!PRIORITIES.includes(input.deal.priority)) throw new Error('Invalid priority')
    if (Number.isNaN(convertedDealClose.getTime())) throw new Error('Invalid close date')
  }

  const result = await guardAgainstIdCollision(() =>
    dbConvertLeadToDeal(scope, leadId, {
      ownerId: input.ownerId,
      actorId,
      contactId: input.contactId,
      dealId: input.deal ? input.dealId : undefined,
      activityId: input.activityId,
      deal:
        input.deal && stage
          ? {
              name: input.deal.name.trim(),
              value: input.deal.value,
              priority: input.deal.priority,
              stage: { id: stage.id, probability: stage.probability },
              closeDate: convertedDealClose!,
            }
          : undefined,
    }),
  )
  revalidatePath('/', 'layout')
  return {
    contactId: result.contact.id,
    dealId: result.deal?.id ?? null,
  }
}

export async function toggleTaskAction(taskId: string, done: boolean) {
  const { orgId, scopeOwnerId } = await requireAuth()
  if (typeof done !== 'boolean') throw new Error('Invalid value')
  await dbToggleTaskDone({ orgId, scopeOwnerId }, taskId, done)
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
  const { orgId, ownerId: callerId, scopeOwnerId } = await requireAuth()
  const scope: Scope = { orgId, scopeOwnerId }
  assertClientId(input.id)

  const title = input.title.trim()
  const dueDate = new Date(input.dueDate)
  const type = input.type ?? 'todo'
  if (!title || title.length > 500) throw new Error('Title is required')
  if (Number.isNaN(dueDate.getTime())) throw new Error('Invalid due date')
  if (!PRIORITIES.includes(input.priority)) throw new Error('Invalid priority')
  if (!TASK_TYPES.includes(type)) throw new Error('Invalid task type')
  if (input.subject && input.subject.label.length > 200) throw new Error('Label is too long')

  // ownerId comes from the client — an assignee other than the caller must be verified to belong
  // to this org. Task assignment is unrestricted even when scoped: a scoped Member may assign a
  // task to any teammate (unlike creating/owning a lead/contact/deal) — the thing that's scoped
  // is who can *see* the task afterward (assignee or creator — see taskVisibilityWhere in
  // lib/data/tasks.ts), not who it can be assigned to.
  let assigneeId = callerId
  if (input.ownerId && input.ownerId !== callerId) {
    const assignee = await getOwnerById(orgId, input.ownerId)
    if (!assignee) throw new Error('Owner not found')
    assigneeId = assignee.id
  }

  await assertSubjectInScope(scope, input.subject)
  await guardAgainstIdCollision(() =>
    dbCreateTask(scope, {
      id: input.id,
      title,
      dueDate,
      priority: input.priority,
      type,
      owner: { connect: { id: assigneeId } },
      createdBy: { connect: { id: callerId } },
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
    }),
  )
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
  /** Client-generated id for the "edited" activity, when this task has a related subject (see
   *  updateTask in lib/data/tasks.ts — omitted for a standalone task, same as that function). */
  activityId?: string
}) {
  const { orgId, ownerId: actorId, scopeOwnerId } = await requireAuth()
  const scope: Scope = { orgId, scopeOwnerId }
  if (input.activityId !== undefined) assertClientId(input.activityId)

  const title = input.title.trim()
  const description = input.description?.trim() || null
  const dueDate = new Date(input.dueDate)
  if (!title || title.length > 500) throw new Error('Title is required')
  if (description && description.length > 5000) throw new Error('Description is too long')
  if (Number.isNaN(dueDate.getTime())) throw new Error('Invalid due date')
  if (!PRIORITIES.includes(input.priority)) throw new Error('Invalid priority')
  if (!TASK_TYPES.includes(input.type)) throw new Error('Invalid task type')

  // ownerId comes from the client — make sure it belongs to this org before connecting it. Task
  // (re)assignment is unrestricted even when scoped — see addTaskAction's identical note.
  const owner = await getOwnerById(orgId, input.ownerId)
  if (!owner) throw new Error('Owner not found')

  await guardAgainstIdCollision(() =>
    dbUpdateTask(
      scope,
      input.id,
      { title, description, dueDate, priority: input.priority, type: input.type, ownerId: owner.id },
      actorId,
      input.activityId,
    ),
  )
  revalidatePath('/', 'layout')
}

export async function deleteTaskAction(taskId: string) {
  const { orgId, scopeOwnerId } = await requireAuth()
  await dbDeleteTask({ orgId, scopeOwnerId }, taskId)
  revalidatePath('/', 'layout')
}

export async function logActivityAction(
  id: string,
  kind: ActivityKind,
  title: string,
  subject?: { type: 'lead' | 'contact' | 'deal'; id: string; label: string },
  body?: string,
) {
  const { orgId, ownerId, scopeOwnerId } = await requireAuth()
  const scope: Scope = { orgId, scopeOwnerId }
  assertClientId(id)
  if (!ACTIVITY_KINDS.includes(kind)) throw new Error('Invalid activity kind')
  const trimmedTitle = title.trim()
  const trimmedBody = body?.trim()
  if (!trimmedTitle || trimmedTitle.length > 500) throw new Error('Title is required')
  if (trimmedBody && trimmedBody.length > 5000) throw new Error('Note is too long')
  if (subject && subject.label.length > 200) throw new Error('Label is too long')
  const foundSubject = await assertSubjectInScope(scope, subject)
  await guardAgainstIdCollision(() =>
    dbLogActivity(scope, {
      id,
      kind,
      title: trimmedTitle,
      body: trimmedBody,
      actor: { connect: { id: ownerId } },
      ownerId: foundSubject ? foundSubject.ownerId : ownerId,
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
    }),
  )
  revalidatePath('/', 'layout')
}

export async function updateProfileAction(input: { name: string; timezone: string | null }) {
  const { orgId, ownerId } = await requireAuth()

  const name = input.name.trim()
  if (!name || name.length > 200) throw new Error('Name is required')
  const timezone = input.timezone?.trim() || null
  // A real IANA zone id or null (never the old free-text display labels) — see lib/timezones.ts.
  // Clearing it is allowed (Settings prompts again rather than silently keeping a stale value).
  if (timezone && !isValidIanaTimezone(timezone)) throw new Error('Invalid time zone')

  await updateOwnerProfile(orgId, ownerId, { name, timezone })
  revalidatePath('/', 'layout')
}

export async function updateOrgTimezoneAction(input: { timezone: string }): Promise<{ ok: true } | ForbiddenResult> {
  const session = await tryAdminSession(requireAdmin)
  if (!session) return FORBIDDEN
  const timezone = input.timezone.trim()
  if (!isValidIanaTimezone(timezone)) throw new Error('Invalid time zone')

  await updateOrgTimezone(session.orgId, timezone)
  revalidatePath('/', 'layout')
  return { ok: true }
}

const REP_VISIBILITIES: RepVisibility[] = ['ALL', 'OWN']

/**
 * Stage 1c: the switch itself. Flips the whole org between "everyone sees all records" (ALL) and
 * "reps see only their own" (OWN) — see lib/scope.ts for what OWN mode actually restricts, and
 * requireLiveAdminAccess()'s doc comment for why this uses the strict live-Clerk-role check
 * (same as requirePaymentWriteAccess) rather than plain requireAdmin(): switching back to ALL
 * hands every Member visibility into every other rep's records again, which is exactly as
 * sensitive as restricting it in the first place — a stale DB `Owner.role` must never be enough
 * to make either change.
 *
 * Takes effect for every Member's next page load or refetch — the live poll
 * (src/store/livePoll.ts) runs at most 60s apart, so no open tab is more than a minute behind;
 * `QueryCacheSecurityGuard` already clears the whole TanStack Query cache the moment
 * `repVisibility` changes in the data it receives (see that component), so there's nothing extra
 * to invalidate here.
 */
export async function updateRepVisibilityAction(
  repVisibility: RepVisibility,
): Promise<{ ok: true; repVisibility: RepVisibility; changedAt: string } | ForbiddenResult> {
  const session = await tryAdminSession(requireLiveAdminAccess)
  if (!session) return FORBIDDEN
  if (!REP_VISIBILITIES.includes(repVisibility)) throw new Error('Invalid visibility setting')

  const updated = await updateRepVisibility(session.orgId, repVisibility, session.ownerId)
  revalidatePath('/', 'layout')
  return { ok: true, repVisibility: updated.repVisibility, changedAt: updated.repVisibilityChangedAt!.toISOString() }
}

/**
 * Admin-only via `requireAdmin()` — found and fixed during a role-rule audit: this previously
 * called `requireAuth()`, letting any Member set the org's quarterly quota, despite
 * `updateCurrencyAction`'s own doc comment (below) already claiming parity with this one as an
 * admin-gated org-level setting. The quota is exactly that: org-wide, not per-rep, same category
 * as currency and timezone.
 */
export async function updateQuotaAction(input: { quarterlyQuota: number | null }): Promise<{ ok: true } | ForbiddenResult> {
  const session = await tryAdminSession(requireAdmin)
  if (!session) return FORBIDDEN

  const quota = input.quarterlyQuota
  if (quota !== null && (!Number.isInteger(quota) || quota < 0 || quota > 1_000_000_000)) {
    throw new Error('Invalid quota')
  }

  await updateOrgQuota(session.orgId, quota)
  revalidatePath('/', 'layout')
  return { ok: true }
}

/**
 * Admin-only (requireAdmin throws "Admins only" for a Member — never trusts a client-supplied
 * role). `orgId` comes from `requireAuth()`'s own resolved org, same as updateQuotaAction — there's
 * no separate id to tenant-check, the org row itself is the boundary.
 */
export async function updateCurrencyAction(input: { currency: string }): Promise<{ ok: true } | ForbiddenResult> {
  const session = await tryAdminSession(requireAdmin)
  if (!session) return FORBIDDEN

  if (!CURRENCY_CODES.includes(input.currency as (typeof CURRENCY_CODES)[number])) {
    throw new Error('Unsupported currency')
  }

  await updateOrgCurrency(session.orgId, input.currency)
  revalidatePath('/', 'layout')
  return { ok: true }
}

/**
 * Pipeline stage management (create/rename/reorder/delete, all four below) is admin-only via
 * `requireAdmin()` — found and fixed in the Stage 1c role-rule follow-up: a stage's structure
 * (including its fixed isWon/isClosed flags, set once at creation and never independently
 * editable — see createStage's doc comment in lib/data/stages.ts) affects every deal in the org,
 * unlike moving an individual deal between existing stages (moveDealAction), which stays open to
 * any Member.
 */
export async function createStageAction(input: { id: string; label: string }): Promise<{ ok: true } | ForbiddenResult> {
  const session = await tryAdminSession(requireAdmin)
  if (!session) return FORBIDDEN
  assertClientId(input.id)
  const label = input.label.trim()
  if (!label || label.length > 100) throw new Error('Stage name is required')
  await guardAgainstIdCollision(() => dbCreateStage(session.orgId, { id: input.id, label }))
  revalidatePath('/', 'layout')
  return { ok: true }
}

export async function renameStageAction(stageId: string, label: string): Promise<{ ok: true } | ForbiddenResult> {
  const session = await tryAdminSession(requireAdmin)
  if (!session) return FORBIDDEN
  const trimmed = label.trim()
  if (!trimmed || trimmed.length > 100) throw new Error('Stage name is required')
  // dbRenameStage does its own findFirst({id, orgId}) check — same tenant-check convention as
  // every other update in lib/data/*.ts.
  await dbRenameStage(session.orgId, stageId, trimmed)
  revalidatePath('/', 'layout')
  return { ok: true }
}

export async function reorderStageAction(stageId: string, direction: 'up' | 'down'): Promise<{ ok: true } | ForbiddenResult> {
  const session = await tryAdminSession(requireAdmin)
  if (!session) return FORBIDDEN
  if (direction !== 'up' && direction !== 'down') throw new Error('Invalid direction')
  await dbReorderStage(session.orgId, stageId, direction)
  revalidatePath('/', 'layout')
  return { ok: true }
}

export async function deleteStageAction(stageId: string): Promise<{ ok: true } | ForbiddenResult> {
  const session = await tryAdminSession(requireAdmin)
  if (!session) return FORBIDDEN
  await dbDeleteStage(session.orgId, stageId)
  revalidatePath('/', 'layout')
  return { ok: true }
}

export async function addNoteAction(
  id: string,
  subject: { type: 'lead' | 'contact' | 'deal'; id: string; label: string },
  body: string,
) {
  await logActivityAction(id, 'note', `added a note on ${subject.label}`, subject, body)
}
