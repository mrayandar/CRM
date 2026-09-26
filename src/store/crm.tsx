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
import {
  createLeadAction,
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
  setLeadStatus: (leadId: string, status: LeadStatus) => void
  convertLead: (
    leadId: string,
    input: ConvertLeadInput,
  ) => { contactId: string; dealId: string | null }
  toggleTask: (taskId: string) => void
  addTask: (task: { title: string; dueDate: string; priority: Priority; subject?: SubjectRef }) => void
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
   * state and the optimistic activity is dropped. The activity is only persisted *after* the
   * mutation succeeded, so a failed change never leaves a log entry in the database. Pass a null
   * `run` for a standalone activity.
   */
  const persist = useCallback(
    (run: (() => Promise<unknown>) | null, rollback: () => void, activity?: Activity) => {
      startTransition(async () => {
        if (run) {
          try {
            await run()
          } catch {
            rollback()
            if (activity) removeActivity(activity.id)
            return
          }
        }
        if (activity) {
          try {
            await logActivityAction(activity.kind, activity.title, activity.subject, activity.body)
          } catch {
            removeActivity(activity.id)
          }
        }
      })
    },
    [removeActivity],
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
      setDeals((prev) =>
        prev.map((d) =>
          d.id === dealId
            ? { ...d, stage, probability, updatedAt: new Date().toISOString() }
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
                ? { ...d, stage: deal.stage, probability: deal.probability, updatedAt: deal.updatedAt }
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

      startTransition(async () => {
        try {
          await convertLeadAction(leadId, {
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
          })
        } catch {
          // Nothing was written: drop the rows that never existed and restore the lead.
          setContacts((prev) => prev.filter((c) => c.id !== contactId))
          if (dealId) setDeals((prev) => prev.filter((d) => d.id !== dealId))
          setActivities((prev) => prev.filter((a) => a.id !== activity.id))
          setLeads((prev) => prev.map((l) => (l.id === leadId ? lead : l)))
        }
      })

      return { contactId, dealId }
    },
    [leads, currentUser.id],
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
      persist(
        () => toggleTaskAction(taskId, done),
        () => setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, done: task.done } : t))),
        activity,
      )
    },
    [tasks, addLocalActivity, persist],
  )

  const addTask = useCallback<CrmState['addTask']>(
    ({ title, dueDate, priority, subject }) => {
      const id = newEntityId()
      setTasks((prev) => [
        {
          id,
          title,
          dueDate,
          done: false,
          priority,
          ownerId: currentUser.id,
          relatedTo: subject,
          type: 'todo',
        },
        ...prev,
      ])
      startTransition(async () => {
        try {
          await addTaskAction({ id, title, dueDate, priority, subject })
        } catch {
          setTasks((prev) => prev.filter((t) => t.id !== id))
        }
      })
    },
    [currentUser.id],
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
      setLeadStatus,
      convertLead,
      toggleTask,
      addTask,
      addNote,
      pushActivity,
    ],
  )

  return <CrmContext.Provider value={value}>{children}</CrmContext.Provider>
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
