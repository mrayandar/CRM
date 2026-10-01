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
} from '@/data/types'

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
  quarterlyQuota: number | null
}

/**
 * Loads all CRM data for an organization and maps to frontend types.
 * Called once per request in the (app) layout — the data hydrates the
 * CrmProvider that every client screen reads from.
 */
export async function loadCrmData(
  orgId: string,
  currentOwnerId: string,
): Promise<CrmInitialData> {
  const [rawOwners, rawLeads, rawContacts, rawDeals, rawTasks, rawActivities, rawStages, rawCompanies, org] =
    await Promise.all([
      listOwners(orgId),
      listLeads(orgId),
      listContacts(orgId),
      listDeals(orgId),
      listTasks(orgId),
      listActivities(orgId),
      listStages(orgId),
      listCompanies(orgId),
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
    quarterlyQuota: org?.quarterlyQuota ?? null,
  }
}
