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
}

describe('exhaustiveness: lib/actions/payments.ts and every app/api/**/route.ts file is bucketed', () => {
  it('every export of lib/actions/payments.ts is covered by the exempt bucket', () => {
    const actual = Object.keys(paymentActions).filter(
      (k) => typeof (paymentActions as Record<string, unknown>)[k] === 'function',
    )
    const uncovered = actual.filter((k) => !(k in PAYMENT_ACTION_BUCKETS))
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
