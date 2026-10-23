import 'server-only'

import {
  listOwners,
  listLeads,
  listContacts,
  listDeals,
  listTasks,
  listActivities,
  listStages,
  listCompanies,
  listPayments,
  getOrgById,
} from '@lib/data'
import {
  mapOwner,
  mapLead,
  mapContact,
  mapDeal,
  mapTask,
  mapActivity,
  mapStage,
  mapCompany,
  mapPayment,
} from '@lib/mappers'
import type {
  Owner,
  Lead,
  Contact,
  Deal,
  Task,
  Activity,
  PipelineStage,
  Company,
  Payment,
} from '@/data/types'
import { DEFAULT_ORG_TIMEZONE } from '@lib/timezones'

export interface CrmInitialData {
  owners: Owner[]
  currentUser: Owner
  leads: Lead[]
  contacts: Contact[]
  deals: Deal[]
  tasks: Task[]
  activities: Activity[]
  stages: PipelineStage[]
  companies: Company[]
  /** Empty for a caller without payment access — see `includePayments` below. */
  payments: Payment[]
  /** Server-computed once per request (requirePaymentAccess's two-source check); the client never
   *  re-derives this — it only ever sees `payments` already filtered to match. Drives whether the
   *  Payments nav item, command palette rows, and the per-deal link show up at all. */
  canAccessPayments: boolean
  quarterlyQuota: number | null
  orgCurrency: string
  /** Real IANA zone id (e.g. "Asia/Karachi") — org-wide business periods (won this month,
   *  quarter-to-date quota, monthly charts, month-over-month, closing in 30 days) are computed
   *  in this zone, never the viewer's own. See lib/timePeriods.ts. */
  orgTimezone: string
  /** Always "ALL" today — no Settings switch exists yet to change it (Stage 1). Exposed now so
   *  the query-cache security guard (lib/queryCacheSecurity.ts) already watches it; nothing else
   *  reads or writes this. */
  repVisibility: 'ALL' | 'OWN'
  /** The org's own name, as stored in our DB (set once, at creation, from Clerk's org name — see
   *  upsertOrg in lib/data/organizations.ts; never re-synced if the org is later renamed in
   *  Clerk). Settings shows this read-only — there's no "rename workspace" action in this app. */
  orgName: string
}

/**
 * Loads all CRM data for an organization and maps to frontend types.
 * Called once per request in the (app) layout — the data hydrates the
 * CrmProvider that every client screen reads from.
 *
 * `includePayments` must be the caller's own `canAccessPayments()` result (computed once, in the
 * layout, from the real session) — never assume access here. When false, Payment rows are never
 * queried and payment-kind activities are excluded from the activity feed at the query level, so a
 * non-privileged member's hydrated client state contains no payment data at all, not just data
 * that's hidden by the UI.
 */
export async function loadCrmData(
  orgId: string,
  currentOwnerId: string,
  includePayments: boolean,
): Promise<CrmInitialData> {
  const [
    rawOwners,
    rawLeads,
    rawContacts,
    rawDeals,
    rawTasks,
    rawActivities,
    rawStages,
    rawCompanies,
    rawPayments,
    org,
  ] = await Promise.all([
    listOwners(orgId),
    listLeads(orgId),
    listContacts(orgId),
    listDeals(orgId),
    listTasks(orgId),
    listActivities(orgId, { excludeKinds: includePayments ? [] : ['payment'] }),
    listStages(orgId),
    listCompanies(orgId),
    includePayments ? listPayments(orgId) : Promise.resolve([]),
    getOrgById(orgId),
  ])

  const owners = rawOwners.map(mapOwner)
  const currentUser =
    owners.find((o) => o.id === currentOwnerId) ?? owners[0]

  return {
    owners,
    currentUser: currentUser ?? {
      id: currentOwnerId,
      name: 'You',
      initials: 'Y',
      role: 'Member',
      email: '',
      active: true,
    },
    leads: rawLeads.map(mapLead),
    contacts: rawContacts.map(mapContact),
    deals: rawDeals.map(mapDeal),
    tasks: rawTasks.map(mapTask),
    activities: rawActivities.map(mapActivity),
    stages: rawStages.map(mapStage),
    companies: rawCompanies.map(mapCompany),
    payments: rawPayments.map(mapPayment),
    canAccessPayments: includePayments,
    quarterlyQuota: org?.quarterlyQuota ?? null,
    orgCurrency: org?.currency ?? 'USD',
    orgTimezone: org?.timezone ?? DEFAULT_ORG_TIMEZONE,
    repVisibility: org?.repVisibility ?? 'ALL',
    orgName: org?.name ?? '',
  }
}
