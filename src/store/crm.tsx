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
import { useRouter } from 'next/navigation'
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
import {
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

interface CrmProviderProps {
  children: ReactNode
  initialData: CrmInitialData
  orgId: string
}

export function CrmProvider({ children, initialData }: CrmProviderProps) {
  const router = useRouter()
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
      startTransition(async () => {
        await logActivityAction(kind, title, subject, body)
        router.refresh()
      })
    },
    [currentUser.id, router],
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
      pushActivity(kind, title, { type: 'deal', id: deal.id, label: deal.name })

      startTransition(async () => {
        await moveDealAction(dealId, stage)
        router.refresh()
      })
    },
    [deals, pushActivity, router],
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
      startTransition(async () => {
        await setLeadStatusAction(leadId, status)
        router.refresh()
      })
    },
    [leads, pushActivity, router],
  )

  const convertLead = useCallback(
    (leadId: string, input: ConvertLeadInput) => {
      const lead = leads.find((l) => l.id === leadId)!
      const contactId = nextId('c')
      const now = new Date().toISOString()
      const dealId = input.deal ? nextId('d') : null

      // Optimistic: add contact locally
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

      // Optimistic: add deal locally if provided
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

      // Persist server-side
      startTransition(async () => {
        await convertLeadAction(leadId, {
          ownerId: input.ownerId,
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
        router.refresh()
      })

      return { contactId, dealId }
    },
    [leads, pushActivity, router],
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

      const task = tasks.find((t) => t.id === taskId)
      startTransition(async () => {
        await toggleTaskAction(taskId, !(task?.done ?? false))
        router.refresh()
      })
    },
    [tasks, pushActivity, router],
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
      startTransition(async () => {
        await addTaskAction({ title, dueDate, priority, subject })
        router.refresh()
      })
    },
    [currentUser.id, router],
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
      startTransition(async () => {
        await addNoteAction(subject, body)
        router.refresh()
      })
    },
    [pushActivity, router],
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
