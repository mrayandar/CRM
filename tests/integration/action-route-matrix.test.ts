/**
 * Exhaustiveness, extended beyond lib/actions/crm.ts's own matrix (tests/integration/
 * own-mode.test.ts): every exported action in lib/actions/payments.ts, and every route handler
 * file under app/api/**\/route.ts, must be placed in exactly one bucket — `scoped` (enforces
 * Scope, covered by its own behavioral tests elsewhere), `exempt` (not Scope-applicable, with a
 * one-line reason), or `public` (no session/Scope at all, e.g. a signed webhook). Route files are
 * discovered from the real filesystem, not hand-listed — a new app/api/**\/route.ts file with no
 * bucket entry fails immediately, the same "can't silently ship uncovered" guarantee
 * own-mode.test.ts's action matrix already gives lib/actions/crm.ts.
 */
import { readdirSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as paymentActions from '@lib/actions/payments'
import * as importActions from '@lib/actions/import'
import * as notificationActions from '@lib/actions/notifications'

const REPO_ROOT = resolve(__dirname, '../..')

/** Recursively finds every `route.ts` under `dir`, returned as a forward-slash path relative to
 *  `dir` (e.g. `webhooks/clerk/route.ts`) — matches how the buckets below are keyed, independent
 *  of the host OS's path separator. */
function discoverRouteFiles(dir: string, base: string = dir): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry)
    if (statSync(full).isDirectory()) {
      found.push(...discoverRouteFiles(full, base))
    } else if (entry === 'route.ts') {
      found.push(full.slice(base.length + 1).split(sep).join('/'))
    }
  }
  return found
}

/**
 * Every export of lib/actions/payments.ts is `exempt` — Payments is gated entirely by
 * `requirePaymentAccess()`/`requirePaymentWriteAccess()`'s own two-source Admin check
 * (lib/auth.ts), independent of `RepVisibility`/`Scope`. A scoped Member never reaches any of
 * these at all (rejected before this module is even called); an Admin is always unscoped by
 * definition (`computeScopeOwnerId` returns null for a real Admin in every mode) — so there is no
 * "scoped" behavior for this module to have, in any org mode. See PROGRESS.md's Stage 1a entry
 * for the one place a Scope value DOES appear in this module's call path (passing `{ orgId,
 * scopeOwnerId: null }` into `getDealById`, never a client-influenced value).
 */
const PAYMENT_ACTION_BUCKETS: Record<string, string> = {
  createPaymentAction: 'admin-only (requirePaymentWriteAccess) — Payments gating is independent of RepVisibility',
  updatePaymentAction: 'same as createPaymentAction',
  splitPaymentAction: 'same as createPaymentAction',
  markPaymentPaidAction: 'same as createPaymentAction',
  cancelPaymentAction: 'same as createPaymentAction',
  deletePaymentAction: 'same as createPaymentAction',
}

/**
 * Every export of lib/actions/import.ts is admin-only — undoing a bulk import is as destructive
 * and org-wide as deleteCompanyAction/deleteStageAction, and the record-count view is explicitly
 * an admin-only, own-org-only feature (see PROGRESS.md's CSV-import entry). The actual chunked
 * commit (lib/data/import.ts's commitImportChunk) is Scope-aware and covered by
 * tests/integration/csv-import.test.ts instead — it's invoked from a Route Handler, not a Server
 * Action, so it isn't in this module at all.
 */
const IMPORT_ACTION_BUCKETS: Record<string, string> = {
  undoImportBatchAction: 'admin-only (requireAdmin via tryAdminSession) — same destructive tier as deleteCompanyAction',
  getOrgRecordCountsAction: 'admin-only (requireAdmin via tryAdminSession) — own org only, see PROGRESS.md',
}

/**
 * Every export of lib/actions/notifications.ts scopes itself by recipientId === the caller's own
 * ownerId inside lib/data/notifications.ts (markNotificationRead/markAllNotificationsRead) — a
 * Member can only ever mark their OWN notifications, there is no "another rep's notification"
 * concept for RepVisibility/Scope to gate, unlike a lead/contact/deal/task id. See
 * tests/integration/notifications.test.ts for the direct "can't read or mark another user's
 * notifications" behavioral proof.
 */
const NOTIFICATION_ACTION_BUCKETS: Record<string, string> = {
  markNotificationReadAction: 'Member or Admin — scoped to the caller\'s own recipientId, not Scope/RepVisibility',
  markAllNotificationsReadAction: 'same as markNotificationReadAction',
}

const ROUTE_BUCKETS: Record<string, { kind: 'scoped' | 'exempt' | 'public'; reason: string }> = {
  'activities/route.ts': {
    kind: 'scoped',
    reason: 'GET /api/activities — subject lookup is a scoped by-id read; see tests/integration/own-mode.test.ts',
  },
  'crm-refetch/route.ts': {
    kind: 'scoped',
    reason: 'GET /api/crm-refetch — calls loadCrmData(scope, ...); see tests/integration/own-mode.test.ts',
  },
  'webhooks/clerk/route.ts': {
    kind: 'public',
    reason:
      "Clerk's own signed webhook (Svix signature verified in-handler) — not a per-user session route, so Scope doesn't apply; it writes Organization/Owner rows directly from Clerk's own payload, before any Owner/session exists to scope against.",
  },
  'import/parse/route.ts': {
    kind: 'exempt',
    reason:
      'POST /api/import/parse — requireAuth()-gated but pure file parsing, no Scope-filtered read or write at all; see tests/integration/csv-import.test.ts',
  },
  'import/validate/route.ts': {
    kind: 'scoped',
    reason:
      'POST /api/import/validate — findDuplicateByEmail respects Scope (an OWN-mode match outside it reveals nothing); see tests/integration/csv-import.test.ts',
  },
  'import/batches/route.ts': {
    kind: 'exempt',
    reason:
      'POST /api/import/batches — creates an ImportBatch row keyed by orgId/importedById; no Scope object involved at all.',
  },
  'import/commit/route.ts': {
    kind: 'scoped',
    reason:
      'POST /api/import/commit — commitImportChunk builds and uses Scope throughout (duplicate detection, owner-scope assertion, the update path); see tests/integration/csv-import.test.ts',
  },
  'notifications/route.ts': {
    kind: 'scoped',
    reason:
      'GET /api/notifications — listNotifications builds titles through the same scoped by-id reads (getLeadById/getContactById/getDealById/getTaskById) every other feature uses; see tests/integration/notifications.test.ts',
  },
  'notifications/unread-count/route.ts': {
    kind: 'exempt',
    reason:
      'GET /api/notifications/unread-count — a single COUNT scoped by orgId + the caller\'s own recipientId; no Scope object (no OWN-mode subject lookup) involved at all.',
  },
}

describe('exhaustiveness: lib/actions/payments.ts, lib/actions/import.ts, and every app/api/**/route.ts file is bucketed', () => {
  it('every export of lib/actions/payments.ts is covered by the exempt bucket', () => {
    const actual = Object.keys(paymentActions).filter(
      (k) => typeof (paymentActions as Record<string, unknown>)[k] === 'function',
    )
    const uncovered = actual.filter((k) => !(k in PAYMENT_ACTION_BUCKETS))
    expect(uncovered).toEqual([])
  })

  it('every export of lib/actions/import.ts is covered by the admin-only bucket', () => {
    const actual = Object.keys(importActions).filter(
      (k) => typeof (importActions as Record<string, unknown>)[k] === 'function',
    )
    const uncovered = actual.filter((k) => !(k in IMPORT_ACTION_BUCKETS))
    expect(uncovered).toEqual([])
  })

  it('every export of lib/actions/notifications.ts is covered by the recipient-scoped bucket', () => {
    const actual = Object.keys(notificationActions).filter(
      (k) => typeof (notificationActions as Record<string, unknown>)[k] === 'function',
    )
    const uncovered = actual.filter((k) => !(k in NOTIFICATION_ACTION_BUCKETS))
    expect(uncovered).toEqual([])
  })

  it('every real app/api/**/route.ts file is covered (scoped, exempt, or public)', () => {
    const discovered = discoverRouteFiles(resolve(REPO_ROOT, 'app/api'))
    const uncovered = discovered.filter((f) => !(f in ROUTE_BUCKETS))
    expect(uncovered).toEqual([])
  })

  it('no bucket entry is stale (every bucketed path still exists on disk)', () => {
    const discovered = new Set(discoverRouteFiles(resolve(REPO_ROOT, 'app/api')))
    const stale = Object.keys(ROUTE_BUCKETS).filter((f) => !discovered.has(f))
    expect(stale).toEqual([])
  })
})
