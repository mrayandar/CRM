'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from 'react'
import type {
  Activity,
  ActivityKind,
  Company,
  Contact,
  Deal,
  Lead,
  LeadSource,
  LeadStatus,
  Owner,
  Payment,
  PaymentLabel,
  PipelineStage,
  Priority,
  Task,
} from '@/data/types'
import { initialsOf, shouldPromptWonPaymentSetup } from '@/lib/utils'
import { runPersist } from '@/store/persistRun'
import { ToastViewport, type ToastItem } from '@/components/ui/Toast'
import {
  createLeadAction,
  updateLeadAction,
  createDealAction,
  updateDealAction,
  createContactAction,
  updateContactAction,
  createCompanyAction,
  updateCompanyAction,
  deleteCompanyAction,
  moveDealAction,
  setLeadStatusAction,
  convertLeadAction,
  toggleTaskAction,
  addTaskAction,
  updateTaskAction,
  deleteTaskAction,
  addNoteAction,
  logActivityAction,
  updateProfileAction,
  updateQuotaAction,
  updateCurrencyAction,
  updateOrgTimezoneAction,
  createStageAction,
  renameStageAction,
  reorderStageAction,
  deleteStageAction,
} from '@lib/actions/crm'
import { isRefetchStale, startLivePoll } from '@/store/livePoll'
import {
  createPaymentAction,
  updatePaymentAction,
  markPaymentPaidAction,
  cancelPaymentAction,
  deletePaymentAction,
  splitPaymentAction,
} from '@lib/actions/payments'
import type { CrmInitialData } from '@lib/data-loader'

type SubjectRef = NonNullable<Activity['subject']>

/** Optional deal-creation piece of a lead conversion. */
export interface ConvertLeadDealInput {
  name: string
  value: number
  stageId: string
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
  companyId: string
  source: LeadSource
  ownerId: string
}

export interface NewLeadInput {
  name: string
  email: string
  phone: string
  companyId: string
  source: LeadSource
  status: LeadStatus
  ownerId: string
  notes?: string
}

export interface NewContactInput {
  name: string
  email: string
  phone: string
  companyId: string
  title: string
  ownerId: string
}

export interface UpdateContactInput {
  name: string
  title: string
  email: string
  phone: string
  companyId: string
  ownerId: string
}

export type NewContactResult = { ok: true; id: string } | { ok: false; error: string }

export interface NewDealInput {
  name: string
  companyId?: string
  value: number
  stageId: string
  /** ISO timestamp */
  closeDate: string
  ownerId: string
  contactId?: string
}

export interface UpdateDealInput {
  name: string
  value: number
  stageId: string
  /** ISO timestamp */
  closeDate: string
  ownerId: string
  contactId?: string
  companyId: string
}

export interface NewCompanyInput {
  name: string
  website?: string
  industry?: string
  notes?: string
}

export interface UpdateCompanyInput {
  name: string
  website?: string
  industry?: string
  notes?: string
}

export interface UpdateTaskInput {
  title: string
  description?: string
  /** ISO timestamp */
  dueDate: string
  priority: Priority
  type: Task['type']
  ownerId: string
}

export interface NewPaymentInput {
  dealId: string
  amount: number
  label: PaymentLabel
  /** ISO timestamp, or omit for "awaiting milestone" (no due date yet). */
  dueDate?: string
  note?: string
}

export interface UpdatePaymentInput {
  amount: number
  label: PaymentLabel
  /** ISO timestamp, or omit for "awaiting milestone". */
  dueDate?: string
  note?: string
}

export type DeletePaymentResult = { ok: true } | { ok: false; error: string }

export interface SplitPaymentPart {
  percent: number
  label: PaymentLabel
  /** ISO timestamp, or omit for "awaiting milestone". */
  dueDate?: string
}

interface CrmState {
  owners: Owner[]
  currentUser: Owner
  leads: Lead[]
  contacts: Contact[]
  deals: Deal[]
  tasks: Task[]
  activities: Activity[]
  stages: PipelineStage[]
  companies: Company[]
  /** Empty for a caller without payment access — populated server-side only, see loadCrmData. */
  payments: Payment[]
  /** Whether the current session has payment access (requirePaymentAccess, computed server-side
   *  once per request) — drives whether the Payments nav item, command palette rows, and the
   *  per-deal payments link show up. Never re-derived client-side. */
  canAccessPayments: boolean
  /** Non-null while the "set up payments for [deal]" prompt should be showing, after a deal was
   *  just confirmed moved into a Won stage (any of drag, the card menu, the edit modal, or
   *  creating directly as Won) — see openWonPaymentSetup. Rendered once, in AppLayout, not
   *  per-screen; always null for anyone without payment access. */
  wonPaymentSetupDealId: string | null
  /** The one shared trigger for all four "a deal entered Won" paths — called from moveDeal/
   *  updateDeal/addDeal's persist() onSuccess, so it only ever runs after the stage change is
   *  confirmed saved, never on a rollback. No-ops (via shouldPromptWonPaymentSetup) for a Member,
   *  or if this deal already has payments (re-winning a reopened deal doesn't re-prompt). */
  openWonPaymentSetup: (dealId: string) => void
  closeWonPaymentSetup: () => void
  /** Team-wide quarterly revenue target set from Settings -> Workspace; null until an admin sets one. */
  quarterlyQuota: number | null
  /** Org-level display currency (ISO 4217, e.g. "USD"), set from Settings -> Workspace, admin-only.
   *  Relabels every amount in the app — never converts stored values. */
  orgCurrency: string
  /** Real IANA zone id, set from Settings -> Workspace, admin-only — org-wide business periods
   *  (won this month, quarter-to-date quota, monthly charts, MoM, closing in 30 days) are
   *  computed in this zone. See lib/timePeriods.ts. */
  orgTimezone: string
  updateOrgTimezone: (timezone: string) => void
  /** Read-only — there's no "rename workspace" action in this app; see orgName's doc comment in
   *  lib/data-loader.ts for why it can lag a rename made directly in Clerk. */
  orgName: string
  ownerById: (id: string) => Owner
  stageById: (id: string) => PipelineStage
  companyById: (id: string) => Company | undefined
  /** Adds the company to local state immediately; rolls back and shows a toast if the save fails.
   *  If a company with this name (case-insensitive) already exists in the org, the server returns
   *  that existing row instead of creating a duplicate — the optimistic row is reconciled to its
   *  real id once that happens. Returns the real company. */
  addCompany: (input: NewCompanyInput) => Promise<Company>
  /** Updates a company's own fields; rolls back and shows a toast if the save fails. */
  updateCompany: (companyId: string, input: UpdateCompanyInput) => void
  /** Deletes a company outright; blocked server-side (returns {ok:false, error}) while any Lead,
   *  Contact, or Deal is still linked to it. */
  deleteCompany: (companyId: string) => Promise<{ ok: true } | { ok: false; error: string }>
  moveDeal: (dealId: string, stageId: string) => void
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
  /** Adds a new open stage, inserted right before the first closed (Won/Lost) stage. */
  addStage: (label: string) => void
  renameStage: (stageId: string, label: string) => void
  /** Moves an open stage up or down among the other open stages; Won/Lost stay pinned last. */
  moveStage: (stageId: string, direction: 'up' | 'down') => void
  /** Blocked (returns {ok:false, error}) if the stage is closed, the last open stage, or still
   *  has deals in it — never silently orphans a deal. */
  deleteStage: (stageId: string) => Promise<{ ok: true } | { ok: false; error: string }>
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
  /** Updates a task's own fields; rolls back and shows a toast if the save fails. A no-op (nothing changed) does nothing. */
  updateTask: (taskId: string, input: UpdateTaskInput) => void
  /** Deletes a task outright; rolls back (re-inserts it) and shows a toast if the delete fails. */
  deleteTask: (taskId: string) => void
  /** Adds a payment to local state immediately; rolls back and shows a toast if the save fails. */
  addPayment: (input: NewPaymentInput) => void
  /** Updates a payment's own fields; rolls back and shows a toast if the save fails. A no-op (nothing changed) does nothing. */
  updatePayment: (paymentId: string, input: UpdatePaymentInput) => void
  /** Marks a payment paid; rolls back and shows a toast if the save fails. */
  markPaymentPaid: (paymentId: string) => void
  /** Cancels a payment (the only way to undo one already marked paid); rolls back and shows a toast if the save fails. */
  cancelPayment: (paymentId: string) => void
  /** Deletes a payment outright; blocked server-side (returns {ok:false, error}) once it's marked paid — cancel it instead. */
  deletePayment: (paymentId: string) => Promise<DeletePaymentResult>
  /**
   * Splits a deal's value into installments in one server round-trip. `parts`' percentages must
   * total exactly 100 (enforced server-side; amounts are computed there too, never trusted from
   * the client). Not routed through persist()'s optimistic-then-rollback pattern — awaits the
   * server response and uses its computed amounts directly, since reinventing the rounding
   * client-side just to show an optimistic row risks it disagreeing with what's actually written.
   * Throws on failure (validation or role rejection); the caller shows the message.
   */
  splitPayment: (dealId: string, parts: SplitPaymentPart[]) => Promise<void>
  addNote: (subject: SubjectRef, body: string) => void
  logActivity: (kind: ActivityKind, title: string, subject?: SubjectRef, body?: string) => void
  /** Updates the caller's own profile (name, timezone); rolls back and shows a toast if the save fails. */
  updateProfile: (input: { name: string; timezone: string | null }) => void
  /** Sets (or clears, with null) the org's quarterly quota; rolls back and shows a toast on failure. */
  updateQuota: (quota: number | null) => void
  /** Sets the org's display currency (admin-only, rejected server-side for anyone else); rolls
   *  back and shows a toast on failure. */
  updateCurrency: (currency: string) => void
  /**
   * Generic escape hatch for mutations that don't map to the store's own optimistic CRM state —
   * e.g. Clerk org-membership calls in Team settings. Same toast-on-failure pattern as every
   * other mutation in this store: runs `run`, and on failure calls `rollback` and shows a toast
   * with `failureMessage`. Pass `undefined` for `activity` (nothing to log here).
   */
  persist: (
    run: () => Promise<unknown>,
    rollback: () => void,
    activity: undefined,
    failureMessage?: string,
  ) => void
}

const CrmContext = createContext<CrmState | null>(null)

// Every optimistic row (leads, contacts, deals, tasks, and activities) uses a real UUID that the
// server stores as the row id — so the optimistic row already is the real one, and (for
// activities specifically) a later fetch of the same row can be matched by id rather than by
// guessing from content.
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
  const [owners, setOwners] = useState<Owner[]>(initialData.owners)
  const [currentUser, setCurrentUser] = useState<Owner>(initialData.currentUser)
  const [stages, setStages] = useState<PipelineStage[]>(initialData.stages)
  const [companies, setCompanies] = useState<Company[]>(initialData.companies)
  const [payments, setPayments] = useState<Payment[]>(initialData.payments)
  // Stateful (not a plain const off initialData) so a live refetch can reflect a role change
  // (e.g. this user was demoted to Member in another tab) without a full page reload.
  const [canAccessPayments, setCanAccessPayments] = useState<boolean>(initialData.canAccessPayments)
  const [wonPaymentSetupDealId, setWonPaymentSetupDealId] = useState<string | null>(null)
  const [quarterlyQuota, setQuarterlyQuota] = useState<number | null>(initialData.quarterlyQuota)
  const [orgCurrency, setOrgCurrency] = useState<string>(initialData.orgCurrency)
  const [orgTimezone, setOrgTimezone] = useState<string>(initialData.orgTimezone)
  const [orgName, setOrgName] = useState<string>(initialData.orgName)
  const [toasts, setToasts] = useState<ToastItem[]>([])

  // --- Live-update refetch bookkeeping (see src/store/livePoll.ts for the scheduling logic) ---
  // pendingCountRef: how many of THIS tab's own mutations are currently in flight. A refetch tick
  // skips entirely while > 0 ("skip ... while any persist() mutation is pending").
  // generationRef: bumped every time a mutation starts. If it changes between when a refetch
  // request was sent and when its response arrives, that response is discarded as stale — it
  // could otherwise revert the very change that started mid-fetch, or resurrect a row that change
  // just deleted. Neither counter is React state: nothing should ever re-render because of them.
  const pendingCountRef = useRef(0)
  const generationRef = useRef(0)
  const disposedRef = useRef(false)

  const beginMutation = useCallback(() => {
    pendingCountRef.current += 1
    generationRef.current += 1
  }, [])
  const endMutation = useCallback(() => {
    pendingCountRef.current = Math.max(0, pendingCountRef.current - 1)
  }, [])

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

  const stageById = useCallback(
    (id: string) => stages.find((s) => s.id === id) ?? stages[0]!,
    [stages],
  )

  const companyById = useCallback(
    (id: string) => companies.find((c) => c.id === id),
    [companies],
  )

  const removeActivity = useCallback(
    (id: string) => setActivities((prev) => prev.filter((a) => a.id !== id)),
    [],
  )

  const addLocalActivity = useCallback(
    (kind: ActivityKind, title: string, subject?: SubjectRef, body?: string): Activity => {
      const activity: Activity = {
        id: newEntityId(),
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
   *
   * `onSuccess`, when given, fires only once the mutation is genuinely confirmed saved — never on
   * a rollback. The actual success/rollback branching lives in runPersist() (src/store/
   * persistRun.ts), kept there specifically so it has its own unit tests independent of this
   * React provider. Used by moveDeal/updateDeal/addDeal to open the "set up payments" prompt
   * after (never before, never on failure) a deal is confirmed moved into a Won stage.
   */
  const persist = useCallback(
    (
      run: (() => Promise<unknown>) | null,
      rollback: () => void,
      activity?: Activity,
      failureMessage = SAVE_FAILED,
      onSuccess?: () => void,
    ) => {
      beginMutation()
      startTransition(async () => {
        try {
          const ok = await runPersist({
            run,
            rollback,
            onSuccess,
            onFailure: () => {
              if (activity) removeActivity(activity.id)
              notifyError(failureMessage)
            },
          })
          if (!ok) return
          if (activity) {
            try {
              await logActivityAction(activity.id, activity.kind, activity.title, activity.subject, activity.body)
            } catch {
              removeActivity(activity.id)
              // Only the activity-log write failed; the change itself was saved.
              notifyError(run ? LOG_FAILED : failureMessage)
            }
          }
        } finally {
          endMutation()
        }
      })
    },
    [removeActivity, notifyError, beginMutation, endMutation],
  )

  const pushActivity = useCallback(
    (kind: ActivityKind, title: string, subject?: SubjectRef, body?: string) => {
      persist(null, () => {}, addLocalActivity(kind, title, subject, body))
    },
    [addLocalActivity, persist],
  )

  const openWonPaymentSetup = useCallback(
    (dealId: string) => {
      if (!shouldPromptWonPaymentSetup({ canAccessPayments, dealId, payments })) return
      setWonPaymentSetupDealId(dealId)
    },
    [canAccessPayments, payments],
  )

  const closeWonPaymentSetup = useCallback(() => setWonPaymentSetupDealId(null), [])

  const moveDeal = useCallback(
    (dealId: string, stageId: string) => {
      const deal = deals.find((d) => d.id === dealId)
      if (!deal || deal.stageId === stageId) return

      const previousStage = stageById(deal.stageId)
      const nextStage = stageById(stageId)
      // Same rule the server applies (see closeDateOnStageChange in lib/data/deals.ts): entering a
      // Won-flagged stage from one that wasn't stamps the close date to now.
      const closedNow = nextStage.isWon && !previousStage.isWon
      const now = new Date().toISOString()
      setDeals((prev) =>
        prev.map((d) =>
          d.id === dealId
            ? { ...d, stageId, probability: nextStage.probability, updatedAt: now, ...(closedNow && { closeDate: now }) }
            : d,
        ),
      )

      const kind: ActivityKind = nextStage.isWon ? 'won' : nextStage.isClosed ? 'lost' : 'stage'
      const title = nextStage.isWon
        ? `marked ${deal.name} as Won`
        : nextStage.isClosed
          ? `marked ${deal.name} as Lost`
          : `moved ${deal.name} to ${nextStage.label}`
      const activity = addLocalActivity(kind, title, { type: 'deal', id: deal.id, label: deal.name })

      persist(
        () => moveDealAction(dealId, stageId),
        () =>
          setDeals((prev) =>
            prev.map((d) =>
              d.id === dealId
                ? {
                    ...d,
                    stageId: deal.stageId,
                    probability: deal.probability,
                    updatedAt: deal.updatedAt,
                    closeDate: deal.closeDate,
                  }
                : d,
            ),
          ),
        activity,
        undefined,
        closedNow ? () => openWonPaymentSetup(dealId) : undefined,
      )
    },
    [deals, stageById, addLocalActivity, persist, openWonPaymentSetup],
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
        companyId: input.companyId,
        company: companyById(input.companyId)?.name ?? '',
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
      const noteActivityId = notes ? newEntityId() : undefined
      const activityId = newEntityId()
      const optimisticActivities: Activity[] = [
        ...(notes && noteActivityId
          ? [{ id: noteActivityId, kind: 'note' as const, title: `added a note on ${name}`, body: notes, at: now, actorId: currentUser.id, subject }]
          : []),
        { id: activityId, kind: 'created', title: `created lead ${name}`, at: now, actorId: currentUser.id, subject },
      ]
      const activityIds = new Set(optimisticActivities.map((a) => a.id))

      setLeads((prev) => [lead, ...prev])
      setActivities((prev) => [...optimisticActivities, ...prev])

      beginMutation()
      try {
        // The server stores the row (and its activities) under these same ids, so the optimistic
        // rows are already the real ones.
        await createLeadAction({ ...input, id, name, notes, activityId, noteActivityId })
        return lead
      } catch (err) {
        setLeads((prev) => prev.filter((l) => l.id !== id))
        setActivities((prev) => prev.filter((a) => !activityIds.has(a.id)))
        throw err
      } finally {
        endMutation()
      }
    },
    [currentUser.id, companyById, beginMutation, endMutation],
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
        companyId: input.companyId,
        company: companyById(input.companyId)?.name ?? '',
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
        id: newEntityId(),
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

      beginMutation()
      try {
        const result = await createContactAction({
          id,
          name,
          title: contact.title,
          companyId: contact.companyId,
          email: contact.email,
          phone: contact.phone,
          ownerId: input.ownerId,
          activityId: activity.id,
        })
        if (!result.ok) {
          rollback()
          return { ok: false, error: result.error }
        }
        return { ok: true, id }
      } catch {
        rollback()
        return { ok: false, error: "Couldn't create the contact, please try again." }
      } finally {
        endMutation()
      }
    },
    [contacts, currentUser.id, companyById, beginMutation, endMutation],
  )

  const addDeal = useCallback(
    (input: NewDealInput): string => {
      const id = newEntityId()
      const now = new Date().toISOString()
      const name = input.name.trim()
      const contact = input.contactId ? contacts.find((c) => c.id === input.contactId) : undefined
      // Company is required on a deal; falls back to the linked contact's company when none is
      // explicitly chosen (mirrors the server, see createDealAction).
      const companyId = input.companyId || contact?.companyId || ''
      const company = companyById(companyId)?.name ?? ''
      // Deal.source is required; inherit it from the contact's originating lead when there is one.
      const originLead = contact?.leadId ? leads.find((l) => l.id === contact.leadId) : undefined
      const source: LeadSource = originLead?.source ?? 'Inbound'
      const priority: Priority = 'medium'

      const stage = stageById(input.stageId)
      const deal: Deal = {
        id,
        name,
        companyId,
        company,
        contactId: contact?.id,
        value: input.value,
        stageId: input.stageId,
        ownerId: input.ownerId,
        probability: stage.probability,
        closeDate: input.closeDate,
        createdAt: now,
        updatedAt: now,
        priority,
        source,
      }
      // Written to Postgres in the same nested create as the deal (see createDealAction).
      const activity: Activity = {
        id: newEntityId(),
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
            companyId,
            value: input.value,
            stageId: input.stageId,
            closeDate: input.closeDate,
            ownerId: input.ownerId,
            contactId: contact?.id,
            source,
            priority,
            activityId: activity.id,
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
        // A new deal has no "previous" stage to compare against — created directly as Won is
        // itself the trigger (the only way to even select a closed stage here is a Won column's
        // "+" — see NewDealModal's defaultStageId handling).
        stage.isWon ? () => openWonPaymentSetup(id) : undefined,
      )
      return id
    },
    [contacts, leads, currentUser.id, stageById, companyById, persist, openWonPaymentSetup],
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
        companyId: input.companyId,
        source: input.source,
        ownerId: input.ownerId,
      }

      const changed: string[] = []
      if (lead.name !== trimmed.name) changed.push('name')
      if (lead.title !== trimmed.title) changed.push('title')
      if (lead.email !== trimmed.email) changed.push('email')
      if (lead.phone !== trimmed.phone) changed.push('phone')
      if (lead.companyId !== trimmed.companyId) changed.push('company')
      if (lead.source !== trimmed.source) changed.push('source')
      if (lead.ownerId !== trimmed.ownerId) changed.push('owner')

      // A no-op save: nothing actually differs. Matches the data layer, which also skips the write
      // and the activity rather than bump lastTouchedAt / log an empty "edited" entry for it.
      if (changed.length === 0) return

      const now = new Date().toISOString()
      const next: Lead = {
        ...lead,
        ...trimmed,
        company: companyById(trimmed.companyId)?.name ?? lead.company,
        lastTouchedAt: now,
      }

      // Written to Postgres inside the same transaction as the field update (see updateLead in
      // lib/data/leads.ts) — not routed through persist()'s post-success activity log, which would
      // write it a second time (the same duplicate-write bug addNote had before it was fixed).
      const activity: Activity = {
        id: newEntityId(),
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
        () => updateLeadAction({ id: leadId, ...input, activityId: activity.id }),
        () => {
          setLeads((prev) => prev.map((l) => (l.id === leadId ? lead : l)))
          setActivities((prev) => prev.filter((a) => a.id !== activity.id))
        },
        undefined,
        "Couldn't save the changes, please try again.",
      )
    },
    [leads, currentUser.id, companyById, persist],
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
        companyId: input.companyId,
        ownerId: input.ownerId,
      }

      const changed: string[] = []
      if (contact.name !== trimmed.name) changed.push('name')
      if (contact.title !== trimmed.title) changed.push('title')
      if (contact.email !== trimmed.email) changed.push('email')
      if (contact.phone !== trimmed.phone) changed.push('phone')
      if (contact.companyId !== trimmed.companyId) changed.push('company')
      if (contact.ownerId !== trimmed.ownerId) changed.push('owner')

      // A no-op save: nothing actually differs. Matches the data layer, which also skips the write
      // and the activity rather than bump lastInteractionAt / log an empty "edited" entry for it.
      if (changed.length === 0) return

      const now = new Date().toISOString()
      const next: Contact = {
        ...contact,
        ...trimmed,
        company: companyById(trimmed.companyId)?.name ?? contact.company,
        lastInteractionAt: now,
      }

      // Written to Postgres inside the same transaction as the field update (see updateContact in
      // lib/data/contacts.ts) — not routed through persist()'s post-success activity log, which
      // would write it a second time (the same duplicate-write bug addNote had before it was fixed).
      const activity: Activity = {
        id: newEntityId(),
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
        () => updateContactAction({ id: contactId, ...input, activityId: activity.id }),
        () => {
          setContacts((prev) => prev.map((c) => (c.id === contactId ? contact : c)))
          setActivities((prev) => prev.filter((a) => a.id !== activity.id))
        },
        undefined,
        "Couldn't save the changes, please try again.",
      )
    },
    [contacts, currentUser.id, companyById, persist],
  )

  const updateDeal = useCallback(
    (dealId: string, input: UpdateDealInput) => {
      const deal = deals.find((d) => d.id === dealId)
      if (!deal) return

      const trimmed = {
        name: input.name.trim(),
        value: input.value,
        stageId: input.stageId,
        closeDate: input.closeDate,
        contactId: input.contactId,
        ownerId: input.ownerId,
        companyId: input.companyId,
      }

      // Same close-date rule the server applies in updateDeal/moveDealToStage (lib/data/deals.ts):
      // entering a Won-flagged stage stamps today, overriding whatever was submitted for the
      // field; every other case — including leaving Won — uses the submitted value as-is.
      const now = new Date().toISOString()
      const nextStage = stageById(trimmed.stageId)
      const closedNow = nextStage.isWon && !stageById(deal.stageId).isWon
      const closeDate = closedNow ? now : trimmed.closeDate

      const changed: string[] = []
      if (deal.name !== trimmed.name) changed.push('name')
      if (deal.value !== trimmed.value) changed.push('value')
      if (deal.stageId !== trimmed.stageId) changed.push('stage')
      if (deal.closeDate !== closeDate) changed.push('close date')
      if ((deal.contactId ?? '') !== (trimmed.contactId ?? '')) changed.push('contact')
      if (deal.ownerId !== trimmed.ownerId) changed.push('owner')
      if (deal.companyId !== trimmed.companyId) changed.push('company')

      // A no-op save: nothing actually differs. Matches the data layer, which also skips the write
      // and the activity rather than log an empty "edited" entry for it.
      if (changed.length === 0) return

      const next: Deal = {
        ...deal,
        name: trimmed.name,
        value: trimmed.value,
        stageId: trimmed.stageId,
        probability: nextStage.probability,
        closeDate,
        contactId: trimmed.contactId,
        ownerId: trimmed.ownerId,
        companyId: trimmed.companyId,
        company: companyById(trimmed.companyId)?.name ?? deal.company,
        updatedAt: now,
      }

      // Written to Postgres inside the same transaction as the field update (see updateDeal in
      // lib/data/deals.ts) — not routed through persist()'s post-success activity log, which would
      // write it a second time (the same duplicate-write bug addNote had before it was fixed).
      const activity: Activity = {
        id: newEntityId(),
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
        () => updateDealAction({ id: dealId, ...input, activityId: activity.id }),
        () => {
          setDeals((prev) => prev.map((d) => (d.id === dealId ? deal : d)))
          setActivities((prev) => prev.filter((a) => a.id !== activity.id))
        },
        undefined,
        "Couldn't save the changes, please try again.",
        closedNow ? () => openWonPaymentSetup(dealId) : undefined,
      )
    },
    [deals, stageById, companyById, currentUser.id, persist, openWonPaymentSetup],
  )

  const updateProfile = useCallback(
    (input: { name: string; timezone: string | null }) => {
      const name = input.name.trim()
      if (!name) return
      const prev = currentUser
      const next: Owner = { ...prev, name, initials: initialsOf(name), timezone: input.timezone ?? undefined }

      setCurrentUser(next)
      setOwners((list) => list.map((o) => (o.id === prev.id ? next : o)))

      persist(
        () => updateProfileAction({ name, timezone: input.timezone }),
        () => {
          setCurrentUser(prev)
          setOwners((list) => list.map((o) => (o.id === prev.id ? prev : o)))
        },
        undefined,
        "Couldn't save your profile, please try again.",
      )
    },
    [currentUser, persist],
  )

  const updateQuota = useCallback(
    (quota: number | null) => {
      const prev = quarterlyQuota
      setQuarterlyQuota(quota)
      persist(
        () => updateQuotaAction({ quarterlyQuota: quota }),
        () => setQuarterlyQuota(prev),
        undefined,
        "Couldn't save the quota, please try again.",
      )
    },
    [quarterlyQuota, persist],
  )

  const updateCurrency = useCallback(
    (currency: string) => {
      const prev = orgCurrency
      setOrgCurrency(currency)
      persist(
        () => updateCurrencyAction({ currency }),
        () => setOrgCurrency(prev),
        undefined,
        "Couldn't save the currency, please try again.",
      )
    },
    [orgCurrency, persist],
  )

  const updateOrgTimezone = useCallback(
    (timezone: string) => {
      const prev = orgTimezone
      setOrgTimezone(timezone)
      persist(
        () => updateOrgTimezoneAction({ timezone }),
        () => setOrgTimezone(prev),
        undefined,
        "Couldn't save the workspace time zone, please try again.",
      )
    },
    [orgTimezone, persist],
  )

  // Not routed through persist(): the caller (the inline create-or-select picker) needs the real
  // company back — either the one just created, or the existing one the server resolved to when
  // a case-insensitive name match already existed — so the form can immediately use its real id.
  const addCompany = useCallback(
    async (input: NewCompanyInput): Promise<Company> => {
      const id = newEntityId()
      const now = new Date().toISOString()
      const name = input.name.trim()
      const optimistic: Company = {
        id,
        name,
        website: input.website?.trim() || undefined,
        industry: input.industry?.trim() || undefined,
        notes: input.notes?.trim() || undefined,
        createdAt: now,
        updatedAt: now,
        leadCount: 0,
        contactCount: 0,
        dealCount: 0,
      }
      setCompanies((prev) => [...prev, optimistic])
      beginMutation()
      try {
        const result = await createCompanyAction({ id, ...input })
        if (result.existing) {
          // The server resolved to a pre-existing company instead of creating a new one — drop
          // the optimistic row (nothing new was actually created).
          setCompanies((prev) => prev.filter((c) => c.id !== id))
          const existing = companies.find((c) => c.id === result.id)
          return existing ?? { ...optimistic, id: result.id, name: result.name }
        }
        return optimistic
      } catch (err) {
        setCompanies((prev) => prev.filter((c) => c.id !== id))
        throw err
      } finally {
        endMutation()
      }
    },
    [companies, beginMutation, endMutation],
  )

  const updateCompany = useCallback(
    (companyId: string, input: UpdateCompanyInput) => {
      const company = companies.find((c) => c.id === companyId)
      if (!company) return

      const trimmed = {
        name: input.name.trim(),
        website: input.website?.trim() || undefined,
        industry: input.industry?.trim() || undefined,
        notes: input.notes?.trim() || undefined,
      }

      const changed =
        company.name !== trimmed.name ||
        company.website !== trimmed.website ||
        company.industry !== trimmed.industry ||
        company.notes !== trimmed.notes
      if (!changed) return

      const now = new Date().toISOString()
      const next: Company = { ...company, ...trimmed, updatedAt: now }

      setCompanies((prev) => prev.map((c) => (c.id === companyId ? next : c)))
      // A company's name is denormalized onto every Lead/Contact/Deal that links to it (for the
      // list views); keep those in sync locally so a rename shows up everywhere immediately.
      if (company.name !== trimmed.name) {
        setLeads((prev) => prev.map((l) => (l.companyId === companyId ? { ...l, company: trimmed.name } : l)))
        setContacts((prev) => prev.map((c) => (c.companyId === companyId ? { ...c, company: trimmed.name } : c)))
        setDeals((prev) => prev.map((d) => (d.companyId === companyId ? { ...d, company: trimmed.name } : d)))
      }

      persist(
        () => updateCompanyAction({ id: companyId, ...input }),
        () => {
          setCompanies((prev) => prev.map((c) => (c.id === companyId ? company : c)))
          if (company.name !== trimmed.name) {
            setLeads((prev) => prev.map((l) => (l.companyId === companyId ? { ...l, company: company.name } : l)))
            setContacts((prev) => prev.map((c) => (c.companyId === companyId ? { ...c, company: company.name } : c)))
            setDeals((prev) => prev.map((d) => (d.companyId === companyId ? { ...d, company: company.name } : d)))
          }
        },
        undefined,
        "Couldn't save the changes, please try again.",
      )
    },
    [companies, persist],
  )

  // Not routed through persist(): deletion can be legitimately blocked server-side (still linked
  // to a Lead/Contact/Deal) and the caller needs that specific message, not a generic toast —
  // same {ok, error} shape as addContact's duplicate-email case / deleteStage.
  const deleteCompany = useCallback(
    async (companyId: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      beginMutation()
      try {
        await deleteCompanyAction(companyId)
        setCompanies((prev) => prev.filter((c) => c.id !== companyId))
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Couldn't delete the company" }
      } finally {
        endMutation()
      }
    },
    [beginMutation, endMutation],
  )

  const addStage = useCallback(
    (label: string) => {
      const trimmed = label.trim()
      if (!trimmed) return
      const id = newEntityId()
      // Mirrors the server's placement rule (createStage in lib/data/stages.ts): inserted right
      // before the first closed stage, so Won/Lost stay pinned last.
      setStages((prev) => {
        const firstClosedIndex = prev.findIndex((s) => s.isClosed)
        const insertAt = firstClosedIndex === -1 ? prev.length : firstClosedIndex
        const next = [...prev]
        next.splice(insertAt, 0, { id, label: trimmed, order: insertAt, probability: 50, isClosed: false, isWon: false })
        return next.map((s, i) => ({ ...s, order: i }))
      })
      persist(
        () => createStageAction({ id, label: trimmed }),
        () => setStages((prev) => prev.filter((s) => s.id !== id)),
        undefined,
        "Couldn't add the stage, please try again.",
      )
    },
    [persist],
  )

  const renameStage = useCallback(
    (stageId: string, label: string) => {
      const trimmed = label.trim()
      if (!trimmed) return
      const prevStages = stages
      setStages((prev) => prev.map((s) => (s.id === stageId ? { ...s, label: trimmed } : s)))
      persist(
        () => renameStageAction(stageId, trimmed),
        () => setStages(prevStages),
        undefined,
        "Couldn't rename the stage, please try again.",
      )
    },
    [stages, persist],
  )

  const moveStage = useCallback(
    (stageId: string, direction: 'up' | 'down') => {
      const prevStages = stages
      setStages((prev) => {
        const openStages = prev.filter((s) => !s.isClosed).sort((a, b) => a.order - b.order)
        const index = openStages.findIndex((s) => s.id === stageId)
        const swapWith = direction === 'up' ? index - 1 : index + 1
        if (index === -1 || swapWith < 0 || swapWith >= openStages.length) return prev
        const a = openStages[index]!
        const b = openStages[swapWith]!
        return prev.map((s) => {
          if (s.id === a.id) return { ...s, order: b.order }
          if (s.id === b.id) return { ...s, order: a.order }
          return s
        })
      })
      persist(
        () => reorderStageAction(stageId, direction),
        () => setStages(prevStages),
        undefined,
        "Couldn't reorder the stage, please try again.",
      )
    },
    [stages, persist],
  )

  // Not routed through persist(): deletion can be legitimately blocked server-side (deals still
  // in the stage, or it's the last open stage) and the caller needs that specific message, not a
  // generic toast — same {ok, error} shape as addContact's duplicate-email case.
  const deleteStage = useCallback(
    async (stageId: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      beginMutation()
      try {
        await deleteStageAction(stageId)
        setStages((prev) => prev.filter((s) => s.id !== stageId))
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Couldn't delete the stage" }
      } finally {
        endMutation()
      }
    },
    [beginMutation, endMutation],
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
        companyId: lead.companyId,
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
              companyId: lead.companyId,
              company: lead.company,
              contactId,
              leadId,
              value: input.deal.value,
              stageId: input.deal.stageId,
              ownerId: input.ownerId,
              probability: stageById(input.deal.stageId).probability,
              closeDate: input.deal.closeDate,
              createdAt: now,
              updatedAt: now,
              priority: input.deal.priority,
              source: lead.source,
            }
          : null
      // Written to Postgres inside the same transaction as the contact/deal (see convertLeadToDeal).
      const activity: Activity = {
        id: newEntityId(),
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
            ? {
                ...l,
                status: 'qualified',
                convertedDealId: dealId ?? undefined,
                convertedContactId: contactId,
                lastTouchedAt: now,
              }
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
            activityId: activity.id,
            deal: input.deal
              ? {
                  name: input.deal.name,
                  value: input.deal.value,
                  stageId: input.deal.stageId,
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
    [leads, currentUser.id, stageById, persist],
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

  const updateTask = useCallback(
    (taskId: string, input: UpdateTaskInput) => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) return

      const trimmed = {
        title: input.title.trim(),
        description: input.description?.trim() || undefined,
        dueDate: input.dueDate,
        priority: input.priority,
        type: input.type,
        ownerId: input.ownerId,
      }

      const changed: string[] = []
      if (task.title !== trimmed.title) changed.push('title')
      if ((task.description ?? '') !== (trimmed.description ?? '')) changed.push('description')
      if (task.dueDate !== trimmed.dueDate) changed.push('due date')
      if (task.priority !== trimmed.priority) changed.push('priority')
      if (task.type !== trimmed.type) changed.push('type')
      if (task.ownerId !== trimmed.ownerId) changed.push('assignee')

      // A no-op save: nothing actually differs. Matches the data layer, which also skips the
      // write and the activity rather than log an empty "edited" entry for it.
      if (changed.length === 0) return

      const next: Task = { ...task, ...trimmed }

      // Written to Postgres inside the same transaction as the field update (see updateTask in
      // lib/data/tasks.ts) — not routed through persist()'s post-success activity log, which
      // would write it a second time. Only a task linked to a lead/contact/deal gets a local
      // optimistic activity to match: the server attaches the "edited" activity to that same
      // subject (Activity has no "task" subject type of its own), so a standalone task has
      // nothing to optimistically show here either.
      const activity: Activity | null = task.relatedTo
        ? {
            id: newEntityId(),
            kind: 'edited',
            title: `edited ${next.title}`,
            body: `Changed: ${changed.join(', ')}`,
            at: new Date().toISOString(),
            actorId: currentUser.id,
            subject: task.relatedTo,
          }
        : null

      setTasks((prev) => prev.map((t) => (t.id === taskId ? next : t)))
      if (activity) setActivities((prev) => [activity, ...prev])

      persist(
        () => updateTaskAction({ id: taskId, ...input, activityId: activity?.id }),
        () => {
          setTasks((prev) => prev.map((t) => (t.id === taskId ? task : t)))
          if (activity) setActivities((prev) => prev.filter((a) => a.id !== activity.id))
        },
        undefined,
        "Couldn't save the changes, please try again.",
      )
    },
    [tasks, currentUser.id, persist],
  )

  const deleteTask = useCallback(
    (taskId: string) => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) return
      setTasks((prev) => prev.filter((t) => t.id !== taskId))
      persist(
        () => deleteTaskAction(taskId),
        () => setTasks((prev) => [...prev, task]),
        undefined,
        "Couldn't delete the task, please try again.",
      )
    },
    [tasks, persist],
  )

  const addPayment = useCallback(
    (input: NewPaymentInput) => {
      const id = newEntityId()
      const now = new Date().toISOString()
      const payment: Payment = {
        id,
        dealId: input.dealId,
        amount: input.amount,
        status: 'pending',
        label: input.label,
        dueDate: input.dueDate,
        note: input.note?.trim() || undefined,
        createdById: currentUser.id,
        createdAt: now,
        updatedAt: now,
      }
      setPayments((prev) => [payment, ...prev])
      persist(
        () =>
          createPaymentAction({
            id,
            dealId: input.dealId,
            amount: input.amount,
            label: input.label,
            dueDate: input.dueDate,
            note: input.note,
          }),
        () => setPayments((prev) => prev.filter((p) => p.id !== id)),
        undefined,
        "Couldn't save the payment, please try again.",
      )
    },
    [currentUser.id, persist],
  )

  const updatePayment = useCallback(
    (paymentId: string, input: UpdatePaymentInput) => {
      const payment = payments.find((p) => p.id === paymentId)
      if (!payment) return

      const trimmed = {
        amount: input.amount,
        label: input.label,
        dueDate: input.dueDate,
        note: input.note?.trim() || undefined,
      }
      const changed =
        payment.amount !== trimmed.amount ||
        payment.label !== trimmed.label ||
        payment.dueDate !== trimmed.dueDate ||
        payment.note !== trimmed.note
      if (!changed) return

      const next: Payment = { ...payment, ...trimmed, updatedAt: new Date().toISOString() }
      setPayments((prev) => prev.map((p) => (p.id === paymentId ? next : p)))

      persist(
        () =>
          updatePaymentAction({
            id: paymentId,
            amount: input.amount,
            label: input.label,
            dueDate: input.dueDate,
            note: input.note,
          }),
        () => setPayments((prev) => prev.map((p) => (p.id === paymentId ? payment : p))),
        undefined,
        "Couldn't save the changes, please try again.",
      )
    },
    [payments, persist],
  )

  const splitPayment = useCallback(
    async (dealId: string, parts: SplitPaymentPart[]): Promise<void> => {
      beginMutation()
      try {
        const ids = parts.map(() => newEntityId())
        const now = new Date().toISOString()
        const result = await splitPaymentAction({
          dealId,
          parts: parts.map((p, i) => ({ id: ids[i]!, percent: p.percent, label: p.label, dueDate: p.dueDate })),
        })
        const created: Payment[] = parts.map((p, i) => ({
          id: ids[i]!,
          dealId,
          amount: result.payments[i]!.amount,
          status: 'pending',
          label: p.label,
          dueDate: p.dueDate,
          createdById: currentUser.id,
          createdAt: now,
          updatedAt: now,
        }))
        setPayments((prev) => [...created, ...prev])
      } finally {
        endMutation()
      }
    },
    [currentUser.id, beginMutation, endMutation],
  )

  const markPaymentPaid = useCallback(
    (paymentId: string) => {
      const payment = payments.find((p) => p.id === paymentId)
      if (!payment || payment.status === 'paid') return
      const now = new Date().toISOString()
      setPayments((prev) => prev.map((p) => (p.id === paymentId ? { ...p, status: 'paid', paidAt: now } : p)))

      persist(
        () => markPaymentPaidAction(paymentId),
        () => setPayments((prev) => prev.map((p) => (p.id === paymentId ? payment : p))),
        undefined,
        "Couldn't mark the payment as paid, please try again.",
      )
    },
    [payments, persist],
  )

  const cancelPayment = useCallback(
    (paymentId: string) => {
      const payment = payments.find((p) => p.id === paymentId)
      if (!payment || payment.status === 'cancelled') return
      // paidAt is deliberately kept, not cleared — a cancelled payment that was once paid still
      // reads as "paid on X, then cancelled" and stays undeletable (see deletePayment).
      setPayments((prev) => prev.map((p) => (p.id === paymentId ? { ...p, status: 'cancelled' } : p)))

      persist(
        () => cancelPaymentAction(paymentId),
        () => setPayments((prev) => prev.map((p) => (p.id === paymentId ? payment : p))),
        undefined,
        "Couldn't cancel the payment, please try again.",
      )
    },
    [payments, persist],
  )

  // Not routed through persist(): deletion can be legitimately blocked server-side (already
  // marked paid) and the caller needs that specific message, not a generic toast — same
  // {ok, error} shape as deleteCompany/deleteStage.
  const deletePayment = useCallback(
    async (paymentId: string): Promise<DeletePaymentResult> => {
      beginMutation()
      try {
        const result = await deletePaymentAction(paymentId)
        if (result.ok) setPayments((prev) => prev.filter((p) => p.id !== paymentId))
        return result
      } finally {
        endMutation()
      }
    },
    [beginMutation, endMutation],
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
        () => addNoteAction(activity.id, subject, body),
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

  /**
   * Replaces every server-sourced field with a fresh loadCrmData() result (see
   * GET /api/crm-refetch). A plain wholesale replace, not a field-level merge — safe specifically
   * because refetchTick only ever calls this once it's confirmed no mutation is in flight and
   * none started since the fetch was issued (see generationRef/pendingCountRef there). Pure local
   * UI state (toasts, wonPaymentSetupDealId) is untouched.
   */
  const applyFreshData = useCallback((fresh: CrmInitialData) => {
    setOwners(fresh.owners)
    setCurrentUser(fresh.currentUser)
    setLeads(fresh.leads)
    setContacts(fresh.contacts)
    setDeals(fresh.deals)
    setTasks(fresh.tasks)
    setActivities(fresh.activities)
    setStages(fresh.stages)
    setCompanies(fresh.companies)
    setPayments(fresh.payments)
    setCanAccessPayments(fresh.canAccessPayments)
    setQuarterlyQuota(fresh.quarterlyQuota)
    setOrgCurrency(fresh.orgCurrency)
    setOrgTimezone(fresh.orgTimezone)
    setOrgName(fresh.orgName)
  }, [])

  /**
   * One refetch attempt: fetch, then decide whether it's still safe to apply. `generationRef`
   * bumps on every mutation start (see beginMutation) — if it moved while this fetch was in
   * flight, a mutation started mid-fetch and this response can't be trusted to be at least as
   * fresh as what's already on screen, so it's discarded (not applied, not treated as an error —
   * src/store/livePoll.ts retries soon after, no backoff). Also discarded if a mutation happens
   * to be in flight at the exact moment the response lands, for the same reason.
   *
   * Fetches GET /api/crm-refetch directly, not a Server Action — measured, real reason: a Server
   * Action invoked from the client goes through Next's own action-dispatch queue, which
   * serializes concurrent action calls from the same client. A mutation (e.g. moveDealAction)
   * started while a Server Action version of this was in flight didn't even have its own network
   * request sent until the refetch's response came back, adding the refetch's full ~3-4s to the
   * mutation's latency. A Route Handler sits outside that queue, so a mutation fired during this
   * fetch goes out immediately instead of waiting for it.
   */
  const refetchTick = useCallback(async (): Promise<'applied' | 'discarded'> => {
    const generationAtStart = generationRef.current
    const response = await fetch('/api/crm-refetch', { cache: 'no-store' })
    if (!response.ok) throw new Error(`refetch failed: ${response.status}`)
    const fresh: CrmInitialData = await response.json()
    if (disposedRef.current) return 'discarded'
    if (
      isRefetchStale({
        generationAtStart,
        generationNow: generationRef.current,
        pendingCount: pendingCountRef.current,
      })
    ) {
      return 'discarded'
    }
    applyFreshData(fresh)
    return 'applied'
  }, [applyFreshData])

  // Poll every ~60s while the tab is visible, refetch immediately on focus/visibility-regained,
  // pause while hidden, back off on repeated failures — see src/store/livePoll.ts. Never redirects
  // or surfaces anything on failure: GET /api/crm-refetch's requireAuth() only ever throws (never
  // a redirect), a non-ok response just throws too, and either one just means "try again later,"
  // silently.
  useEffect(() => {
    disposedRef.current = false
    const stop = startLivePoll({
      isMutationPending: () => pendingCountRef.current > 0,
      refetch: refetchTick,
    })
    return () => {
      disposedRef.current = true
      stop()
    }
  }, [refetchTick])

  const value = useMemo<CrmState>(
    () => ({
      owners,
      currentUser,
      leads,
      contacts,
      deals,
      tasks,
      activities,
      stages,
      companies,
      payments,
      canAccessPayments,
      wonPaymentSetupDealId,
      openWonPaymentSetup,
      closeWonPaymentSetup,
      quarterlyQuota,
      orgCurrency,
      orgTimezone,
      updateOrgTimezone,
      orgName,
      ownerById,
      stageById,
      companyById,
      addCompany,
      updateCompany,
      deleteCompany,
      moveDeal,
      addLead,
      updateLead,
      addContact,
      updateContact,
      addDeal,
      updateDeal,
      addStage,
      renameStage,
      moveStage,
      deleteStage,
      setLeadStatus,
      convertLead,
      toggleTask,
      addTask,
      updateTask,
      deleteTask,
      addPayment,
      updatePayment,
      markPaymentPaid,
      cancelPayment,
      deletePayment,
      splitPayment,
      addNote,
      logActivity: pushActivity,
      updateProfile,
      updateQuota,
      updateCurrency,
      persist,
    }),
    [
      owners,
      currentUser,
      leads,
      contacts,
      deals,
      tasks,
      activities,
      stages,
      companies,
      payments,
      canAccessPayments,
      wonPaymentSetupDealId,
      openWonPaymentSetup,
      closeWonPaymentSetup,
      quarterlyQuota,
      orgCurrency,
      orgTimezone,
      updateOrgTimezone,
      orgName,
      ownerById,
      stageById,
      companyById,
      addCompany,
      updateCompany,
      deleteCompany,
      moveDeal,
      addLead,
      updateLead,
      addContact,
      updateContact,
      addDeal,
      updateDeal,
      addStage,
      renameStage,
      moveStage,
      deleteStage,
      setLeadStatus,
      convertLead,
      toggleTask,
      addTask,
      updateTask,
      deleteTask,
      addPayment,
      updatePayment,
      markPaymentPaid,
      cancelPayment,
      deletePayment,
      splitPayment,
      addNote,
      pushActivity,
      updateProfile,
      updateQuota,
      updateCurrency,
      persist,
    ],
  )

  return (
    <CrmContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
    </CrmContext.Provider>
  )
}

export function useCrm(): CrmState {
  const ctx = useContext(CrmContext)
  if (!ctx) throw new Error('useCrm must be used inside <CrmProvider>')
  return ctx
}
