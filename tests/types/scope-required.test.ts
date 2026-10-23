/**
 * Compile-time structural guard: every exported function in lib/data/{leads,contacts,deals,
 * tasks,activities}.ts that reads or writes a scoped record must take `Scope` as a REQUIRED first
 * parameter, never optional — an optional/defaultable scope is exactly the shape of bug this file
 * exists to catch structurally rather than by code review alone (see `getCompanyDetail`'s former
 * optional `scopeOwnerId?: string | null`, found in the Stage 1a follow-up report and deleted
 * rather than fixed, since it had no production caller).
 *
 * The real enforcement here is `tsc --noEmit`, not vitest's assertion runner: each
 * `assertType<RequiresScopeFirst<typeof fn>>()` line below fails to COMPILE — not just fails this
 * test — the moment the named function's first parameter stops being exactly `Scope`, required
 * (made optional, given a default, reordered, or removed). `RequiresScopeFirst` resolves to
 * `false` for an optional first element (`[Scope?, ...]` does not extend `[Scope, ...]`), so an
 * `assertType<false>()` is a type error. The `it()` bodies exist only so this file's coverage
 * shows up in the test report; the runtime assertion inside each is a tautology.
 *
 * lib/data/companies.ts is covered differently (`RequiresRequiredKey`, below) — its scoped
 * functions take a bare `orgId` plus an options object, not a `Scope`, by Stage 1a's own design
 * (company identity is org-wide; only the rollup `_count` is scoped) — the thing this guard
 * checks there is that `ListCompaniesOptions.scopeOwnerId` is a required key, not an optional one.
 *
 * lib/data/payments.ts is deliberately NOT covered by either check: it has no Scope-aware
 * function at all, by design — Payments is gated entirely by `requirePaymentAccess()`/
 * `requirePaymentWriteAccess()`'s own two-source Admin check (see lib/auth.ts), independent of
 * `RepVisibility`. `PAYMENTS_HAS_NO_SCOPED_EXPORTS`, below, pins that fact: it fails to compile the
 * moment any export of that module's parameter list starts with something assignable from
 * `Scope`, which would mean someone started threading per-rep scoping through a module that's
 * supposed to stay admin-only and scope-independent.
 */
import { describe, expect, it } from 'vitest'
import type { Scope } from '@lib/scope'
import type * as leadsData from '@lib/data/leads'
import type * as contactsData from '@lib/data/contacts'
import type * as dealsData from '@lib/data/deals'
import type * as tasksData from '@lib/data/tasks'
import type * as activitiesData from '@lib/data/activities'
import type * as companiesData from '@lib/data/companies'
import type * as paymentsData from '@lib/data/payments'

type RequiresScopeFirst<F extends (...args: never[]) => unknown> =
  Parameters<F> extends [Scope, ...unknown[]] ? true : false

/** True only if `K` is a REQUIRED key of `T` — an optional key (`k?: X`) makes `{}` assignable to
 *  `Pick<T, K>`, so `{} extends Pick<T, K>` is true for optional, false for required. */
type RequiresRequiredKey<T, K extends keyof T> = {} extends Pick<T, K> ? false : true

function assertType<_T extends true>(): void {
  // Type-only — nothing runs. The compile error (if any) is the entire point of this function.
}

describe('structural: Scope-consuming functions require Scope as a non-optional first parameter', () => {
  it('lib/data/leads.ts', () => {
    assertType<RequiresScopeFirst<typeof leadsData.listLeads>>()
    assertType<RequiresScopeFirst<typeof leadsData.getLeadById>>()
    assertType<RequiresScopeFirst<typeof leadsData.createLead>>()
    assertType<RequiresScopeFirst<typeof leadsData.updateLeadStatus>>()
    assertType<RequiresScopeFirst<typeof leadsData.updateLead>>()
    assertType<RequiresScopeFirst<typeof leadsData.convertLeadToDeal>>()
    expect(true).toBe(true)
  })

  it('lib/data/contacts.ts', () => {
    assertType<RequiresScopeFirst<typeof contactsData.listContacts>>()
    assertType<RequiresScopeFirst<typeof contactsData.getContactById>>()
    assertType<RequiresScopeFirst<typeof contactsData.getContactByEmail>>()
    assertType<RequiresScopeFirst<typeof contactsData.createContact>>()
    assertType<RequiresScopeFirst<typeof contactsData.updateContact>>()
    assertType<RequiresScopeFirst<typeof contactsData.addContactTag>>()
    expect(true).toBe(true)
  })

  it('lib/data/deals.ts', () => {
    assertType<RequiresScopeFirst<typeof dealsData.listDeals>>()
    assertType<RequiresScopeFirst<typeof dealsData.getPipelineTotals>>()
    assertType<RequiresScopeFirst<typeof dealsData.getDealById>>()
    assertType<RequiresScopeFirst<typeof dealsData.createDeal>>()
    assertType<RequiresScopeFirst<typeof dealsData.moveDealToStage>>()
    assertType<RequiresScopeFirst<typeof dealsData.updateDeal>>()
    expect(true).toBe(true)
  })

  it('lib/data/tasks.ts', () => {
    assertType<RequiresScopeFirst<typeof tasksData.listTasks>>()
    assertType<RequiresScopeFirst<typeof tasksData.getTaskById>>()
    assertType<RequiresScopeFirst<typeof tasksData.createTask>>()
    assertType<RequiresScopeFirst<typeof tasksData.toggleTaskDone>>()
    assertType<RequiresScopeFirst<typeof tasksData.updateTask>>()
    assertType<RequiresScopeFirst<typeof tasksData.deleteTask>>()
    expect(true).toBe(true)
  })

  it('lib/data/activities.ts (cascadeActivityOwner is exempt — it takes a transaction client, not a Scope, by design: it only ever runs inside another function\'s own already-scoped transaction)', () => {
    assertType<RequiresScopeFirst<typeof activitiesData.listActivities>>()
    assertType<RequiresScopeFirst<typeof activitiesData.logActivity>>()
    // listActivitiesForSubject's first param is also Scope, but TS infers its parameter tuple
    // with the generic subject/options params following — checked the same way:
    assertType<RequiresScopeFirst<typeof activitiesData.listActivitiesForSubject>>()
    expect(true).toBe(true)
  })

  it('lib/data/companies.ts: ListCompaniesOptions.scopeOwnerId is a required key, not optional', () => {
    assertType<RequiresRequiredKey<companiesData.ListCompaniesOptions, 'scopeOwnerId'>>()
    expect(true).toBe(true)
  })

  it('lib/data/payments.ts: confirmed scope-independent by design — no export takes a Scope-shaped first parameter', () => {
    type PAYMENTS_HAS_NO_SCOPED_EXPORTS =
      RequiresScopeFirst<typeof paymentsData.listPayments> extends false
        ? RequiresScopeFirst<typeof paymentsData.getPaymentById> extends false
          ? RequiresScopeFirst<typeof paymentsData.createPayment> extends false
            ? RequiresScopeFirst<typeof paymentsData.createPaymentsSplit> extends false
              ? RequiresScopeFirst<typeof paymentsData.updatePayment> extends false
                ? RequiresScopeFirst<typeof paymentsData.markPaymentPaid> extends false
                  ? RequiresScopeFirst<typeof paymentsData.cancelPayment> extends false
                    ? RequiresScopeFirst<typeof paymentsData.deletePayment> extends false
                      ? true
                      : false
                    : false
                  : false
                : false
              : false
            : false
          : false
        : false
    assertType<PAYMENTS_HAS_NO_SCOPED_EXPORTS>()
    expect(true).toBe(true)
  })
})
