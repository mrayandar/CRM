'use client'

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  activities as seedActivities,
  contacts as seedContacts,
  currentUser,
  deals as seedDeals,
  leads as seedLeads,
  owners,
  tasks as seedTasks,
} from '@/data/mock'
import type {
  Activity,
  ActivityKind,
  Contact,
  Deal,
  DealStage,
  Lead,
  LeadStatus,
  Owner,
  Priority,
  Task,
} from '@/data/types'
import { DEAL_STAGE_LABEL } from '@/data/types'

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

let sequence = 1000
const nextId = (prefix: string) => `${prefix}${++sequence}`

export function CrmProvider({ children }: { children: ReactNode }) {
  const [leads, setLeads] = useState<Lead[]>(seedLeads)
  const [contacts, setContacts] = useState<Contact[]>(seedContacts)
  const [deals, setDeals] = useState<Deal[]>(seedDeals)
  const [tasks, setTasks] = useState<Task[]>(seedTasks)
  const [activities, setActivities] = useState<Activity[]>(seedActivities)

  const ownerById = useCallback(
    (id: string) => owners.find((o) => o.id === id) ?? currentUser,
    [],
  )

  const pushActivity = useCallback(
    (kind: ActivityKind, title: string, subject?: SubjectRef, body?: string) => {
      setActivities((prev) => [
        {
          id: nextId('a'),
          kind,
          title,
          body,
          at: new Date().toISOString(),
          actorId: currentUser.id,
          subject,
        },
        ...prev,
      ])
    },
    [],
  )

  const moveDeal = useCallback(
    (dealId: string, stage: DealStage) => {
      setDeals((prev) =>
        prev.map((deal) => {
          if (deal.id !== dealId || deal.stage === stage) return deal
          const probability =
            stage === 'won' ? 100 : stage === 'lost' ? 0 : STAGE_PROBABILITY[stage]
          return { ...deal, stage, probability, updatedAt: new Date().toISOString() }
        }),
      )
      const deal = deals.find((d) => d.id === dealId)
      if (!deal || deal.stage === stage) return
      const kind: ActivityKind = stage === 'won' ? 'won' : stage === 'lost' ? 'lost' : 'stage'
      const title =
        stage === 'won'
          ? `marked ${deal.name} as Won`
          : stage === 'lost'
            ? `marked ${deal.name} as Lost`
            : `moved ${deal.name} to ${DEAL_STAGE_LABEL[stage]}`
      pushActivity(kind, title, { type: 'deal', id: deal.id, label: deal.name })
    },
    [deals, pushActivity],
  )

  const setLeadStatus = useCallback(
    (leadId: string, status: LeadStatus) => {
      setLeads((prev) =>
        prev.map((lead) =>
          lead.id === leadId
            ? { ...lead, status, lastTouchedAt: new Date().toISOString() }
            : lead,
        ),
      )
      const lead = leads.find((l) => l.id === leadId)
      if (lead) {
        pushActivity('stage', `set ${lead.name} to ${status}`, {
          type: 'lead',
          id: lead.id,
          label: lead.name,
        })
      }
    },
    [leads, pushActivity],
  )

  const convertLead = useCallback(
    (leadId: string, input: ConvertLeadInput) => {
      const lead = leads.find((l) => l.id === leadId)!
      const contactId = nextId('c')
      const now = new Date().toISOString()
      const dealId = input.deal ? nextId('d') : null

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

      setContacts((prev) => [contact, ...prev])

      if (input.deal && dealId) {
        const deal: Deal = {
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
        setDeals((prev) => [deal, ...prev])
      }

      setLeads((prev) =>
        prev.map((l) =>
          l.id === leadId
            ? {
                ...l,
                status: 'qualified',
                convertedDealId: dealId ?? undefined,
                lastTouchedAt: now,
              }
            : l,
        ),
      )

      const activityTitle = input.deal
        ? `converted ${lead.name} into ${input.deal.name}`
        : `converted ${lead.name} to a contact`
      pushActivity('created', activityTitle, {
        type: 'lead',
        id: leadId,
        label: lead.name,
      })

      return { contactId, dealId }
    },
    [leads, pushActivity],
  )

  const toggleTask = useCallback(
    (taskId: string) => {
      let completedTitle: string | null = null
      let subject: SubjectRef | undefined
      setTasks((prev) =>
        prev.map((task) => {
          if (task.id !== taskId) return task
          if (!task.done) {
            completedTitle = task.title
            subject = task.relatedTo
          }
          return { ...task, done: !task.done }
        }),
      )
      if (completedTitle) pushActivity('task', `completed ${completedTitle}`, subject)
    },
    [pushActivity],
  )

  const addTask = useCallback<CrmState['addTask']>(
    ({ title, dueDate, priority, subject }) => {
      setTasks((prev) => [
        {
          id: nextId('t'),
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
    },
    [],
  )

  const addNote = useCallback(
    (subject: SubjectRef, body: string) => {
      pushActivity('note', `added a note on ${subject.label}`, subject, body)
      const now = new Date().toISOString()
      if (subject.type === 'contact') {
        setContacts((prev) =>
          prev.map((c) => (c.id === subject.id ? { ...c, lastInteractionAt: now } : c)),
        )
      }
      if (subject.type === 'lead') {
        setLeads((prev) =>
          prev.map((l) => (l.id === subject.id ? { ...l, lastTouchedAt: now } : l)),
        )
      }
    },
    [pushActivity],
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
      setLeadStatus,
      convertLead,
      toggleTask,
      addTask,
      addNote,
      logActivity: pushActivity,
    }),
    [
      leads,
      contacts,
      deals,
      tasks,
      activities,
      ownerById,
      moveDeal,
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
