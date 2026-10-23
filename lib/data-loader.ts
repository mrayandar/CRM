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
import type { Scope } from '@lib/scope'

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
   *  in this zone, but ONLY once `orgTimezoneConfigured` is true — see that field. */
  orgTimezone: string
  /** False until an admin actually saves a workspace time zone — see
   *  Organization.timezoneConfigured's doc comment for the regression this prevents (every
   *  pre-existing org silently computing its business periods in UTC the moment this feature
   *  shipped). While false, callers must fall back to the viewer's own timezone instead of
   *  trusting `orgTimezone`'s default. */
  orgTimezoneConfigured: boolean
  /** Always "ALL" today — no Settings switch exists yet to change it (Stage 1). Exposed now so
   *  the query-cache security guard (lib/queryCacheSecurity.ts) already watches it; nothing else
   *  reads or writes this. */
  repVisibility: 'ALL' | 'OWN'
  /** The exact same value the server used to scope this request's own leads/contacts/deals/
   *  tasks/activities — null for an unscoped caller (Admin, or the org is in ALL mode), the
   *  caller's own id once scoped. Stage 1b's UI gating reads this (never re-derives "am I scoped"
   *  from `repVisibility` + role on its own) so the UI can never show something more permissive
   *  than what the server actually enforced for this exact request. Always null today — no org
   *  is in OWN mode yet. */
  scopeOwnerId: string | null
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
 *
 * `scope.scopeOwnerId`, once an org is in OWN mode, narrows leads/contacts/deals/tasks/activities
 * (and companies' rollup counts) to just what this caller owns — see each listed function's own
 * doc comment. Owners, stages, and payments stay org-wide regardless of scope: an org's team
 * roster, pipeline stages, and (gated separately by `includePayments`) payments are never
 * per-rep data.
 */
export async function loadCrmData(
  scope: Scope,
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
    listOwners(scope.orgId),
    listLeads(scope),
    listContacts(scope),
    listDeals(scope),
    listTasks(scope),
    listActivities(scope, { excludeKinds: includePayments ? [] : ['payment'] }),
    listStages(scope.orgId),
    listCompanies(scope.orgId, { scopeOwnerId: scope.scopeOwnerId }),
    includePayments ? listPayments(scope.orgId) : Promise.resolve([]),
    getOrgById(scope.orgId),
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
    orgTimezoneConfigured: org?.timezoneConfigured ?? false,
    repVisibility: org?.repVisibility ?? 'ALL',
    scopeOwnerId: scope.scopeOwnerId,
    orgName: org?.name ?? '',
  }
}
