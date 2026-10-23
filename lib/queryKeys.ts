/**
 * Query key factory — the single place every future TanStack Query key gets built, so "query keys
 * include the orgId and the viewer's scope" (PROGRESS.md's cache-security design, point A) is
 * true by construction, not by every call site remembering to do it. Nothing calls these yet
 * (Stage 2 is the first screen to migrate); this exists now so Stage 2 onward never invents its
 * own key shape.
 *
 * Every key starts with `[entity, orgId, scopeOwnerId, ...]` — `scopeOwnerId` is `null` for an
 * Admin/ALL-mode caller and a real id for a scoped Member (see lib/scope.ts), so a Member whose
 * scope changes (OWN turned on, or reassigned away from a record) never reads a stale, wrongly-
 * scoped cache entry for what looks like "the same" key: it genuinely isn't the same key anymore.
 * This is a second, independent safety net alongside the full-cache-clear guard
 * (lib/queryCacheSecurity.ts) — belt and suspenders, not a substitute for it.
 */
import type { Scope } from '@lib/scope'

export const queryKeys = {
  leads: (scope: Scope, filters?: Record<string, unknown>) =>
    ['leads', scope.orgId, scope.scopeOwnerId, filters] as const,
  lead: (scope: Scope, id: string) => ['lead', scope.orgId, scope.scopeOwnerId, id] as const,

  contacts: (scope: Scope, filters?: Record<string, unknown>) =>
    ['contacts', scope.orgId, scope.scopeOwnerId, filters] as const,
  contact: (scope: Scope, id: string) => ['contact', scope.orgId, scope.scopeOwnerId, id] as const,

  deals: (scope: Scope, filters?: Record<string, unknown>) =>
    ['deals', scope.orgId, scope.scopeOwnerId, filters] as const,
  deal: (scope: Scope, id: string) => ['deal', scope.orgId, scope.scopeOwnerId, id] as const,
  dealsForStage: (scope: Scope, stageId: string, filters?: Record<string, unknown>) =>
    ['deals-for-stage', scope.orgId, scope.scopeOwnerId, stageId, filters] as const,

  tasks: (scope: Scope, filters?: Record<string, unknown>) =>
    ['tasks', scope.orgId, scope.scopeOwnerId, filters] as const,
  task: (scope: Scope, id: string) => ['task', scope.orgId, scope.scopeOwnerId, id] as const,

  companies: (scope: Scope, filters?: Record<string, unknown>) =>
    ['companies', scope.orgId, scope.scopeOwnerId, filters] as const,
  company: (scope: Scope, id: string) => ['company', scope.orgId, scope.scopeOwnerId, id] as const,

  activitiesForSubject: (scope: Scope, subjectType: string, subjectId: string) =>
    ['activities-for-subject', scope.orgId, scope.scopeOwnerId, subjectType, subjectId] as const,

  /** Admin-only — same reasoning extends to payments: a key that already encodes scope/org means
   *  a demoted admin's old key is simply never looked up again, even before the cache-clear guard
   *  runs. */
  payments: (scope: Scope, dealId?: string) => ['payments', scope.orgId, scope.scopeOwnerId, dealId] as const,

  dashboardAggregates: (scope: Scope) => ['dashboard-aggregates', scope.orgId, scope.scopeOwnerId] as const,
  reportsAggregates: (scope: Scope) => ['reports-aggregates', scope.orgId, scope.scopeOwnerId] as const,
  sidebarCounts: (scope: Scope) => ['sidebar-counts', scope.orgId, scope.scopeOwnerId] as const,

  search: (scope: Scope, query: string) => ['search', scope.orgId, scope.scopeOwnerId, query] as const,
}
