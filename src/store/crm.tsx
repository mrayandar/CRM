'use client'

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useTransition,
  type ReactNode,
} from 'react'
import type {
  Activity,
  ActivityKind,
  Contact,
  Deal,
  DealStage,
  Lead,
  LeadSource,
  LeadStatus,
  Owner,
  Priority,
  Task,
} from '@/data/types'
import { DEAL_STAGE_LABEL } from '@/data/types'
import { ToastViewport, type ToastItem } from '@/components/ui/Toast'
import {
  createLeadAction,
  updateLeadAction,
  createDealAction,
  updateDealAction,
  createContactAction,
  updateContactAction,
  moveDealAction,
  setLeadStatusAction,
  convertLeadAction,
  toggleTaskAction,
  addTaskAction,
  addNoteAction,
  logActivityAction,
} from '@lib/actions/crm'
import type { CrmInitialData } from '@lib/data-loader'

type SubjectRef = NonNullable<Activity['subject']>

/** Optional deal-creation piece of a lead conversion. */
export interface ConvertLeadDealInput {
  name: string
  value: number
  stage: DealStage
  closeDate: string
  priority: Priority
}

export interface ConvertLeadInput {
  ownerId: string
  /** Omit to convert to a Contact only. Provide to also open a Deal. */
  deal?: ConvertLeadDealInput
}

export interface UpdateLeadInput {
  name: string
  title: string
  email: string
  phone: string
  company: string
  source: LeadSource
  ownerId: string
}

export interface NewLeadInput {
  name: string
  email: string
  phone: string
  company: string
  source: LeadSource
  status: LeadStatus
  ownerId: string
  notes?: string
}

export interface NewContactInput {
  name: string
  email: string
  phone: string
  company: string
  title: string
  ownerId: string
}

export interface UpdateContactInput {
  name: string
  title: string
  email: string
  phone: string
  company: string
  ownerId: string
}

export type NewContactResult = { ok: true; id: string } | { ok: false; error: string }

export interface NewDealInput {
  name: string
  company: string
  value: number
  stage: DealStage
  /** ISO timestamp */
  closeDate: string
  ownerId: string
  contactId?: string
}

export interface UpdateDealInput {
  name: string
  value: number
  stage: DealStage
  /** ISO timestamp */
  closeDate: string
  ownerId: string
  contactId?: string
}

interface CrmState {
  owners: Owner[]
  currentUser: Owner
  leads: Lead[]
  contacts: Contact[]
  deals: Deal[]
  tasks: Task[]
  activities: Activity[]
  ownerById: (id: string) => Owner
  moveDeal: (dealId: string, stage: DealStage) => void
  /** Adds the lead to local state immediately; resolves once persisted, rejects (after rolling back) if the save fails. */
  addLead: (input: NewLeadInput) => Promise<Lead>
  /**
   * Adds the contact to local state immediately and resolves once it's saved. If it isn't (duplicate
   * email, or any failure) the optimistic contact is rolled back and the result carries the message
   * for the modal to display.
   */
  addContact: (input: NewContactInput) => Promise<NewContactResult>
  /** Adds the deal to local state immediately; rolls back and shows a toast if the save fails. Returns the new deal's id. */
  addDeal: (input: NewDealInput) => string
  /** Updates a lead's own fields (not status/conversion); rolls back and shows a toast if the save fails. */
  updateLead: (leadId: string, input: UpdateLeadInput) => void
  /** Updates a contact's own fields; rolls back and shows a toast if the save fails. A no-op (nothing changed) does nothing. */
  updateContact: (contactId: string, input: UpdateContactInput) => void
  /**
   * Updates a deal's own fields; rolls back and shows a toast if the save fails. A no-op (nothing
   * changed) does nothing. If `stage` changes, the close date follows the same rule moveDeal uses
   * (entering Won stamps today) — this mirrors the server, which is the actual source of truth.
   */
  updateDeal: (dealId: string, input: UpdateDealInput) => void
  setLeadStatus: (leadId: string, status: LeadStatus) => void
  convertLead: (
    leadId: string,
    input: ConvertLeadInput,
  ) => { contactId: string; dealId: string | null }
  toggleTask: (taskId: string) => void
  addTask: (task: {
    title: string
    dueDate: string
    priority: Priority
    type?: Task['type']
    /** Assignee; defaults to the current user. */
    ownerId?: string
    subject?: SubjectRef
  }) => void
  addNote: (subject: SubjectRef, body: string) => void
  logActivity: (kind: ActivityKind, title: string, subject?: SubjectRef, body?: string) => void
}

const CrmContext = createContext<CrmState | null>(null)

// Activities are display-only until the next load and are never referenced by id, so a local
// counter is enough. Anything that *is* referenced by id (leads, contacts, deals, tasks) must use
// a real UUID that the server stores as the row id — never a counter (see `newEntityId`).
let sequence = 1000
const nextId = (prefix: string) => `${prefix}${++sequence}`
const newEntityId = () => crypto.randomUUID()

const SAVE_FAILED = "Couldn't save change, please try again."
const DUPLICATE_EMAIL = "A contact with this email already exists"
const LOG_FAILED = "Change saved, but couldn't add it to the activity log."

interface CrmProviderProps {
  children: ReactNode
  initialData: CrmInitialData
  orgId: string
}

export function CrmProvider({ children, initialData }: CrmProviderProps) {
  const [, startTransition] = useTransition()

  const [leads, setLeads] = useState<Lead[]>(initialData.leads)
  const [contacts, setContacts] = useState<Contact[]>(initialData.contacts)
  const [deals, setDeals] = useState<Deal[]>(initialData.deals)
  const [tasks, setTasks] = useState<Task[]>(initialData.tasks)
  const [activities, setActivities] = useState<Activity[]>(initialData.activities)
  const [owners] = useState<Owner[]>(initialData.owners)
  const [currentUser] = useState<Owner>(initialData.currentUser)
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const dismissToast = useCallback(
    (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id)),
    [],
  )

  const notifyError = useCallback(
    (message: string) => {
      const id = newEntityId()
      // A burst of identical failures shows one toast, not a stack.
      setToasts((prev) => [...prev.filter((t) => t.message !== message), { id, message }].slice(-3))
      window.setTimeout(() => dismissToast(id), 6000)
    },
    [dismissToast],
  )

  const ownerById = useCallback(
    (id: string) => owners.find((o) => o.id === id) ?? currentUser,
    [owners, currentUser],
  )

  const removeActivity = useCallback(
    (id: string) => setActivities((prev) => prev.filter((a) => a.id !== id)),
    [],
  )

  const addLocalActivity = useCallback(
    (kind: ActivityKind, title: string, subject?: SubjectRef, body?: string): Activity => {
      const activity: Activity = {
        id: nextId('a'),
        kind,
        title,
        body,
        at: new Date().toISOString(),
        actorId: currentUser.id,
        subject,
      }
      setActivities((prev) => [activity, ...prev])
      return activity
    },
    [currentUser.id],
  )

  /**
   * Runs a server mutation for an optimistic change. If it fails, `rollback` reverts the local
   * state, the optimistic activity is dropped and the user is told via a toast. The activity is
   * only persisted *after* the mutation succeeded, so a failed change never leaves a log entry in
   * the database. Pass a null `run` for a standalone activity.
   */
  const persist = useCallback(
    (
      run: (() => Promise<unknown>) | null,
      rollback: () => void,
      activity?: Activity,
      failureMessage = SAVE_FAILED,
    ) => {
      startTransition(async () => {
        if (run) {
          try {
            await run()
          } catch {
            rollback()
            if (activity) removeActivity(activity.id)
            notifyError(failureMessage)
            return
          }
        }
        if (activity) {
          try {
            await logActivityAction(activity.kind, activity.title, activity.subject, activity.body)
          } catch {
            removeActivity(activity.id)
            // Only the activity-log write failed; the change itself was saved.
            notifyError(run ? LOG_FAILED : failureMessage)
          }
        }
      })
    },
    [removeActivity, notifyError],
  )

  const pushActivity = useCallback(
    (kind: ActivityKind, title: string, subject?: SubjectRef, body?: string) => {
      persist(null, () => {}, addLocalActivity(kind, title, subject, body))
    },
    [addLocalActivity, persist],
  )

  const moveDeal = useCallback(
    (dealId: string, stage: DealStage) => {
      const deal = deals.find((d) => d.id === dealId)
      if (!deal || deal.stage === stage) return

      const probability =
        stage === 'won' ? 100 : stage === 'lost' ? 0 : STAGE_PROBABILITY[stage]
      const now = new Date().toISOString()
      const closedNow = stage === 'won'
      setDeals((prev) =>
        prev.map((d) =>
          d.id === dealId
            ? { ...d, stage, probability, updatedAt: now, ...(closedNow && { closeDate: now }) }
            : d,
        ),
      )

      const kind: ActivityKind = stage === 'won' ? 'won' : stage === 'lost' ? 'lost' : 'stage'
      const title =
        stage === 'won'
          ? `marked ${deal.name} as Won`
          : stage === 'lost'
            ? `marked ${deal.name} as Lost`
            : `moved ${deal.name} to ${DEAL_STAGE_LABEL[stage]}`
      const activity = addLocalActivity(kind, title, { type: 'deal', id: deal.id, label: deal.name })

      persist(
        () => moveDealAction(dealId, stage),
        () =>
          setDeals((prev) =>
            prev.map((d) =>
              d.id === dealId
                ? {
                    ...d,
                    stage: deal.stage,
                    probability: deal.probability,
                    updatedAt: deal.updatedAt,
                    closeDate: deal.closeDate,
                  }
                : d,
            ),
          ),
        activity,
      )
    },
    [deals, addLocalActivity, persist],
  )

  const addLead = useCallback(
    async (input: NewLeadInput): Promise<Lead> => {
      const id = newEntityId()
      const now = new Date().toISOString()
      const name = input.name.trim()
      const notes = input.notes?.trim()
      const lead: Lead = {
        id,
        name,
        title: '',
        company: input.company.trim(),
        email: input.email.trim(),
        phone: input.phone.trim(),
        status: input.status,
        source: input.source,
        ownerId: input.ownerId,
        score: 0,
        estValue: 0,
        location: '',
        createdAt: now,
        lastTouchedAt: now,
      }
      const subject: SubjectRef = { type: 'lead', id, label: name }
      const optimisticActivities: Activity[] = [
        ...(notes
          ? [{ id: nextId('a'), kind: 'note' as const, title: `added a note on ${name}`, body: notes, at: now, actorId: currentUser.id, subject }]
          : []),
        { id: nextId('a'), kind: 'created', title: `created lead ${name}`, at: now, actorId: currentUser.id, subject },
      ]
      const activityIds = new Set(optimisticActivities.map((a) => a.id))

      setLeads((prev) => [lead, ...prev])
      setActivities((prev) => [...optimisticActivities, ...prev])

      try {
        // The server stores the row under this same id, so the optimistic lead is already the real one.
        await createLeadAction({ ...input, id, name, notes })
        return lead
      } catch (err) {
        setLeads((prev) => prev.filter((l) => l.id !== id))
        setActivities((prev) => prev.filter((a) => !activityIds.has(a.id)))
        throw err
      }
    },
    [currentUser.id],
  )

  const addContact = useCallback(
    async (input: NewContactInput): Promise<NewContactResult> => {
      const email = input.email.trim()
      // Instant feedback from local state; the server re-checks (other users / stale clients).
      if (email && contacts.some((c) => c.email.toLowerCase() === email.toLowerCase())) {
        return { ok: false, error: DUPLICATE_EMAIL }
      }

      const id = newEntityId()
      const now = new Date().toISOString()
      const name = input.name.trim()
      const contact: Contact = {
        id,
        name,
        title: input.title.trim(),
        company: input.company.trim(),
        email,
        phone: input.phone.trim(),
        ownerId: input.ownerId,
        tags: [],
        lifecycle: 'Prospect',
        location: '',
        lastInteractionAt: now,
        createdAt: now,
        openDeals: 0,
        accountValue: 0,
      }
      // Written to Postgres in the same nested create as the contact (see createContactAction).
      const activity: Activity = {
        id: nextId('a'),
        kind: 'created',
        title: `created contact ${name}`,
        at: now,
        actorId: currentUser.id,
        subject: { type: 'contact', id, label: name },
      }

      setContacts((prev) => [contact, ...prev])
      setActivities((prev) => [activity, ...prev])
      const rollback = () => {
        setContacts((prev) => prev.filter((c) => c.id !== id))
        setActivities((prev) => prev.filter((a) => a.id !== activity.id))
      }

      try {
        const result = await createContactAction({
          id,
          name,
          title: contact.title,
          company: contact.company,
          email: contact.email,
          phone: contact.phone,
          ownerId: input.ownerId,
        })
        if (!result.ok) {
          rollback()
          return { ok: false, error: result.error }
        }
        return { ok: true, id }
      } catch {
        rollback()
        return { ok: false, error: "Couldn't create the contact, please try again." }
      }
    },
    [contacts, currentUser.id],
  )

  const addDeal = useCallback(
    (input: NewDealInput): string => {
      const id = newEntityId()
      const now = new Date().toISOString()
      const name = input.name.trim()
      const contact = input.contactId ? contacts.find((c) => c.id === input.contactId) : undefined
      const company = input.company.trim() || contact?.company || ''
      // Deal.source is required; inherit it from the contact's originating lead when there is one.
      const originLead = contact?.leadId ? leads.find((l) => l.id === contact.leadId) : undefined
      const source: LeadSource = originLead?.source ?? 'Inbound'
      const priority: Priority = 'medium'

      const deal: Deal = {
        id,
        name,
        company,
        contactId: contact?.id,
        value: input.value,
        stage: input.stage,
        ownerId: input.ownerId,
        probability: STAGE_PROBABILITY[input.stage],
        closeDate: input.closeDate,
        updatedAt: now,
        priority,
        source,
      }
      // Written to Postgres in the same nested create as the deal (see createDealAction).
      const activity: Activity = {
        id: nextId('a'),
        kind: 'created',
        title: `created deal ${name}`,
        at: now,
        actorId: currentUser.id,
        subject: { type: 'deal', id, label: name },
      }

      setDeals((prev) => [deal, ...prev])
      setActivities((prev) => [activity, ...prev])
      if (contact) {
        setContacts((prev) =>
          prev.map((c) => (c.id === contact.id ? { ...c, openDeals: c.openDeals + 1 } : c)),
        )
      }

      persist(
        () =>
          createDealAction({
            id,
            name,
            company,
            value: input.value,
            stage: input.stage,
            closeDate: input.closeDate,
            ownerId: input.ownerId,
            contactId: contact?.id,
            source,
            priority,
          }),
        () => {
          setDeals((prev) => prev.filter((d) => d.id !== id))
          setActivities((prev) => prev.filter((a) => a.id !== activity.id))
          if (contact) {
            setContacts((prev) =>
              prev.map((c) => (c.id === contact.id ? { ...c, openDeals: contact.openDeals } : c)),
            )
          }
        },
        undefined,
        "Couldn't create the deal, please try again.",
      )
      return id
    },
    [contacts, leads, currentUser.id, persist],
  )

  const updateLead = useCallback(
    (leadId: string, input: UpdateLeadInput) => {
      const lead = leads.find((l) => l.id === leadId)
      if (!lead) return

      const trimmed = {
        name: input.name.trim(),
        title: input.title.trim(),
        email: input.email.trim(),
        phone: input.phone.trim(),
        company: input.company.trim(),
        source: input.source,
        ownerId: input.ownerId,
      }

      const changed: string[] = []
      if (lead.name !== trimmed.name) changed.push('name')
      if (lead.title !== trimmed.title) changed.push('title')
      if (lead.email !== trimmed.email) changed.push('email')
      if (lead.phone !== trimmed.phone) changed.push('phone')
      if (lead.company !== trimmed.company) changed.push('company')
      if (lead.source !== trimmed.source) changed.push('source')
      if (lead.ownerId !== trimmed.ownerId) changed.push('owner')

      // A no-op save: nothing actually differs. Matches the data layer, which also skips the write
      // and the activity rather than bump lastTouchedAt / log an empty "edited" entry for it.
      if (changed.length === 0) return

      const now = new Date().toISOString()
      const next: Lead = { ...lead, ...trimmed, lastTouchedAt: now }

      // Written to Postgres inside the same transaction as the field update (see updateLead in
      // lib/data/leads.ts) — not routed through persist()'s post-success activity log, which would
      // write it a second time (the same duplicate-write bug addNote had before it was fixed).
      const activity: Activity = {
        id: nextId('a'),
        kind: 'edited',
        title: `edited ${next.name}`,
        body: `Changed: ${changed.join(', ')}`,
        at: now,
        actorId: currentUser.id,
        subject: { type: 'lead', id: leadId, label: next.name },
      }

      setLeads((prev) => prev.map((l) => (l.id === leadId ? next : l)))
      setActivities((prev) => [activity, ...prev])

      persist(
        () => updateLeadAction({ id: leadId, ...input }),
        () => {
          setLeads((prev) => prev.map((l) => (l.id === leadId ? lead : l)))
          setActivities((prev) => prev.filter((a) => a.id !== activity.id))
        },
        undefined,
        "Couldn't save the changes, please try again.",
      )
    },
    [leads, currentUser.id, persist],
  )

  const updateContact = useCallback(
    (contactId: string, input: UpdateContactInput) => {
      const contact = contacts.find((c) => c.id === contactId)
      if (!contact) return

      const trimmed = {
        name: input.name.trim(),
        title: input.title.trim(),
        email: input.email.trim(),
        phone: input.phone.trim(),
        company: input.company.trim(),
        ownerId: input.ownerId,
      }

      const changed: string[] = []
      if (contact.name !== trimmed.name) changed.push('name')
      if (contact.title !== trimmed.title) changed.push('title')
      if (contact.email !== trimmed.email) changed.push('email')
      if (contact.phone !== trimmed.phone) changed.push('phone')
      if (contact.company !== trimmed.company) changed.push('company')
      if (contact.ownerId !== trimmed.ownerId) changed.push('owner')

      // A no-op save: nothing actually differs. Matches the data layer, which also skips the write
      // and the activity rather than bump lastInteractionAt / log an empty "edited" entry for it.
      if (changed.length === 0) return

      const now = new Date().toISOString()
      const next: Contact = { ...contact, ...trimmed, lastInteractionAt: now }

      // Written to Postgres inside the same transaction as the field update (see updateContact in
      // lib/data/contacts.ts) — not routed through persist()'s post-success activity log, which
      // would write it a second time (the same duplicate-write bug addNote had before it was fixed).
      const activity: Activity = {
        id: nextId('a'),
        kind: 'edited',
        title: `edited ${next.name}`,
        body: `Changed: ${changed.join(', ')}`,
        at: now,
        actorId: currentUser.id,
        subject: { type: 'contact', id: contactId, label: next.name },
      }

      setContacts((prev) => prev.map((c) => (c.id === contactId ? next : c)))
      setActivities((prev) => [activity, ...prev])

      persist(
        () => updateContactAction({ id: contactId, ...input }),
        () => {
          setContacts((prev) => prev.map((c) => (c.id === contactId ? contact : c)))
          setActivities((prev) => prev.filter((a) => a.id !== activity.id))
        },
        undefined,
        "Couldn't save the changes, please try again.",
      )
    },
    [contacts, currentUser.id, persist],
  )

  const updateDeal = useCallback(
    (dealId: string, input: UpdateDealInput) => {
      const deal = deals.find((d) => d.id === dealId)
      if (!deal) return

      const trimmed = {
        name: input.name.trim(),
        value: input.value,
        stage: input.stage,
        closeDate: input.closeDate,
        contactId: input.contactId,
        ownerId: input.ownerId,
      }

      // Same close-date rule the server applies in updateDeal/moveDealToStage (lib/data/deals.ts):
      // entering Won stamps today, overriding whatever was submitted for the field; every other
      // case — including leaving Won — uses the submitted value as-is.
      const now = new Date().toISOString()
      const closedNow = trimmed.stage === 'won' && deal.stage !== 'won'
      const closeDate = closedNow ? now : trimmed.closeDate
      const probability = STAGE_PROBABILITY[trimmed.stage]

      const changed: string[] = []
      if (deal.name !== trimmed.name) changed.push('name')
      if (deal.value !== trimmed.value) changed.push('value')
      if (deal.stage !== trimmed.stage) changed.push('stage')
      if (deal.closeDate !== closeDate) changed.push('close date')
      if ((deal.contactId ?? '') !== (trimmed.contactId ?? '')) changed.push('contact')
      if (deal.ownerId !== trimmed.ownerId) changed.push('owner')

      // A no-op save: nothing actually differs. Matches the data layer, which also skips the write
      // and the activity rather than log an empty "edited" entry for it.
      if (changed.length === 0) return

      const next: Deal = {
        ...deal,
        name: trimmed.name,
        value: trimmed.value,
        stage: trimmed.stage,
        probability,
        closeDate,
        contactId: trimmed.contactId,
        ownerId: trimmed.ownerId,
        updatedAt: now,
      }

      // Written to Postgres inside the same transaction as the field update (see updateDeal in
      // lib/data/deals.ts) — not routed through persist()'s post-success activity log, which would
      // write it a second time (the same duplicate-write bug addNote had before it was fixed).
      const activity: Activity = {
        id: nextId('a'),
        kind: 'edited',
        title: `edited ${next.name}`,
        body: `Changed: ${changed.join(', ')}`,
        at: now,
        actorId: currentUser.id,
        subject: { type: 'deal', id: dealId, label: next.name },
      }

      setDeals((prev) => prev.map((d) => (d.id === dealId ? next : d)))
      setActivities((prev) => [activity, ...prev])

      persist(
        () => updateDealAction({ id: dealId, ...input }),
        () => {
          setDeals((prev) => prev.map((d) => (d.id === dealId ? deal : d)))
          setActivities((prev) => prev.filter((a) => a.id !== activity.id))
        },
        undefined,
        "Couldn't save the changes, please try again.",
      )
    },
    [deals, currentUser.id, persist],
  )

  const setLeadStatus = useCallback(
    (leadId: string, status: LeadStatus) => {
      const lead = leads.find((l) => l.id === leadId)
      if (!lead) return
      setLeads((prev) =>
        prev.map((l) =>
          l.id === leadId ? { ...l, status, lastTouchedAt: new Date().toISOString() } : l,
        ),
      )
      const activity = addLocalActivity('stage', `set ${lead.name} to ${status}`, {
        type: 'lead',
        id: lead.id,
        label: lead.name,
      })
      persist(
        () => setLeadStatusAction(leadId, status),
        () =>
          setLeads((prev) =>
            prev.map((l) =>
              l.id === leadId ? { ...l, status: lead.status, lastTouchedAt: lead.lastTouchedAt } : l,
            ),
          ),
        activity,
      )
    },
    [leads, addLocalActivity, persist],
  )

  const convertLead = useCallback(
    (leadId: string, input: ConvertLeadInput) => {
      const lead = leads.find((l) => l.id === leadId)!
      const contactId = newEntityId()
      const now = new Date().toISOString()
      const dealId = input.deal ? newEntityId() : null

      // Optimistic rows use the same UUIDs the server stores, so they are the real rows.
      const contact: Contact = {
        id: contactId,
        name: lead.name,
        title: lead.title,
        company: lead.company,
        email: lead.email,
        phone: lead.phone,
        ownerId: input.ownerId,
        leadId,
        tags: ['Converted lead', lead.source],
        lifecycle: 'Prospect',
        location: lead.location,
        lastInteractionAt: now,
        createdAt: now,
        openDeals: input.deal ? 1 : 0,
        accountValue: 0,
      }
      const deal: Deal | null =
        input.deal && dealId
          ? {
              id: dealId,
              name: input.deal.name,
              company: lead.company,
              contactId,
              leadId,
              value: input.deal.value,
              stage: input.deal.stage,
              ownerId: input.ownerId,
              probability: STAGE_PROBABILITY[input.deal.stage] ?? 25,
              closeDate: input.deal.closeDate,
              updatedAt: now,
              priority: input.deal.priority,
              source: lead.source,
            }
          : null
      // Written to Postgres inside the same transaction as the contact/deal (see convertLeadToDeal).
      const activity: Activity = {
        id: nextId('a'),
        kind: 'created',
        title: input.deal
          ? `converted ${lead.name} into ${input.deal.name}`
          : `converted ${lead.name} to a contact`,
        at: now,
        actorId: currentUser.id,
        subject: { type: 'lead', id: leadId, label: lead.name },
      }

      setContacts((prev) => [contact, ...prev])
      if (deal) setDeals((prev) => [deal, ...prev])
      setLeads((prev) =>
        prev.map((l) =>
          l.id === leadId
            ? { ...l, status: 'qualified', convertedDealId: dealId ?? undefined, lastTouchedAt: now }
            : l,
        ),
      )
      setActivities((prev) => [activity, ...prev])

      persist(
        () =>
          convertLeadAction(leadId, {
            ownerId: input.ownerId,
            contactId,
            dealId: dealId ?? undefined,
            deal: input.deal
              ? {
                  name: input.deal.name,
                  value: input.deal.value,
                  stage: input.deal.stage,
                  closeDate: input.deal.closeDate,
                  priority: input.deal.priority,
                }
              : undefined,
          }),
        () => {
          // Nothing was written: drop the rows that never existed and restore the lead.
          setContacts((prev) => prev.filter((c) => c.id !== contactId))
          if (dealId) setDeals((prev) => prev.filter((d) => d.id !== dealId))
          setActivities((prev) => prev.filter((a) => a.id !== activity.id))
          setLeads((prev) => prev.map((l) => (l.id === leadId ? lead : l)))
        },
        undefined,
        "Couldn't convert the lead, please try again.",
      )

      return { contactId, dealId }
    },
    [leads, currentUser.id, persist],
  )

  const toggleTask = useCallback(
    (taskId: string) => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) return
      const done = !task.done
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, done } : t)))
      const activity = done
        ? addLocalActivity('task', `completed ${task.title}`, task.relatedTo)
        : undefined
      // Logging the "completed" activity also moves the parent's last-activity time (server side).
      const parent = done ? task.relatedTo : undefined
      const now = new Date().toISOString()
      const prevLead = parent?.type === 'lead' ? leads.find((l) => l.id === parent.id) : undefined
      const prevContact = parent?.type === 'contact' ? contacts.find((c) => c.id === parent.id) : undefined
      if (prevLead) setLeads((prev) => prev.map((l) => (l.id === prevLead.id ? { ...l, lastTouchedAt: now } : l)))
      if (prevContact) setContacts((prev) => prev.map((c) => (c.id === prevContact.id ? { ...c, lastInteractionAt: now } : c)))
      persist(
        () => toggleTaskAction(taskId, done),
        () => {
          setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, done: task.done } : t)))
          if (prevLead) setLeads((prev) => prev.map((l) => (l.id === prevLead.id ? { ...l, lastTouchedAt: prevLead.lastTouchedAt } : l)))
          if (prevContact) setContacts((prev) => prev.map((c) => (c.id === prevContact.id ? { ...c, lastInteractionAt: prevContact.lastInteractionAt } : c)))
        },
        activity,
      )
    },
    [tasks, leads, contacts, addLocalActivity, persist],
  )

  const addTask = useCallback<CrmState['addTask']>(
    ({ title, dueDate, priority, type = 'todo', ownerId, subject }) => {
      const id = newEntityId()
      setTasks((prev) => [
        {
          id,
          title,
          dueDate,
          done: false,
          priority,
          ownerId: ownerId ?? currentUser.id,
          relatedTo: subject,
          type,
        },
        ...prev,
      ])
      persist(
        () => addTaskAction({ id, title, dueDate, priority, type, ownerId, subject }),
        () => setTasks((prev) => prev.filter((t) => t.id !== id)),
        undefined,
        "Couldn't add the task, please try again.",
      )
    },
    [currentUser.id, persist],
  )

  const addNote = useCallback(
    (subject: SubjectRef, body: string) => {
      // addNoteAction logs the note activity itself; don't also call logActivityAction (that saved every note twice).
      const activity = addLocalActivity('note', `added a note on ${subject.label}`, subject, body)
      const now = new Date().toISOString()
      const prevContact = subject.type === 'contact' ? contacts.find((c) => c.id === subject.id) : undefined
      const prevLead = subject.type === 'lead' ? leads.find((l) => l.id === subject.id) : undefined
      if (prevContact) {
        setContacts((prev) =>
          prev.map((c) => (c.id === subject.id ? { ...c, lastInteractionAt: now } : c)),
        )
      }
      if (prevLead) {
        setLeads((prev) =>
          prev.map((l) => (l.id === subject.id ? { ...l, lastTouchedAt: now } : l)),
        )
      }
      persist(
        () => addNoteAction(subject, body),
        () => {
          removeActivity(activity.id)
          if (prevContact) {
            setContacts((prev) =>
              prev.map((c) =>
                c.id === subject.id ? { ...c, lastInteractionAt: prevContact.lastInteractionAt } : c,
              ),
            )
          }
          if (prevLead) {
            setLeads((prev) =>
              prev.map((l) =>
                l.id === subject.id ? { ...l, lastTouchedAt: prevLead.lastTouchedAt } : l,
              ),
            )
          }
        },
      )
    },
    [contacts, leads, addLocalActivity, persist, removeActivity],
  )

  const value = useMemo<CrmState>(
    () => ({
      owners,
      currentUser,
      leads,
      contacts,
      deals,
      tasks,
      activities,
      ownerById,
      moveDeal,
      addLead,
      updateLead,
      addContact,
      updateContact,
      addDeal,
      updateDeal,
      setLeadStatus,
      convertLead,
      toggleTask,
      addTask,
      addNote,
      logActivity: pushActivity,
    }),
    [
      owners,
      currentUser,
      leads,
      contacts,
      deals,
      tasks,
      activities,
      ownerById,
      moveDeal,
      addLead,
      updateLead,
      addContact,
      updateContact,
      addDeal,
      updateDeal,
      setLeadStatus,
      convertLead,
      toggleTask,
      addTask,
      addNote,
      pushActivity,
    ],
  )

  return (
    <CrmContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
    </CrmContext.Provider>
  )
}

const STAGE_PROBABILITY: Record<DealStage, number> = {
  discovery: 20,
  proposal: 45,
  negotiation: 65,
  contract: 85,
  won: 100,
  lost: 0,
}

export function useCrm(): CrmState {
  const ctx = useContext(CrmContext)
  if (!ctx) throw new Error('useCrm must be used inside <CrmProvider>')
  return ctx
}
