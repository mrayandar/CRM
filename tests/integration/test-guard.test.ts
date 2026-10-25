/**
 * Guards the test run itself against two silent-failure modes vitest won't flag on its own:
 *
 * 1. A suite file goes missing (deleted by accident, excluded by a config change, or renamed
 *    without updating anything that depends on its coverage) — `vitest run` just runs fewer
 *    files and exits 0, with nothing in the summary calling that out. This test maintains its own
 *    list of every *.test.ts file that must exist (mirroring the exhaustiveness pattern already
 *    used by tests/integration/action-route-matrix.test.ts for routes/actions) and fails loudly
 *    if the real filesystem, discovered the same way vitest.config.mts's own `include` glob would
 *    discover it, no longer matches.
 * 2. A test is silently skipped (`.skip`, `.todo`, `xit`, `xdescribe`) — vitest reports these as
 *    "skipped", not failed, so a skip introduced to unblock a red CI run can sit there
 *    indefinitely with nobody noticing. This test greps every discovered suite file's source for
 *    those markers and fails if any are found.
 *
 * A newly added test file must be added to KNOWN_TEST_FILES in the same change — the failure
 * message says exactly which path is new/missing, so this is a one-line fix, not a mystery.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../..')

function discoverTestFiles(dir: string, base: string = dir): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry)
    if (statSync(full).isDirectory()) {
      found.push(...discoverTestFiles(full, base))
    } else if (entry.endsWith('.test.ts')) {
      found.push(full.slice(base.length + 1).split(sep).join('/'))
    }
  }
  return found
}

// Kept in sync manually, on purpose — see the file-level doc comment. This file's own entry is
// included so it can never "discover" its way to zero and vacuously pass.
const KNOWN_TEST_FILES = [
  'integration/action-route-matrix.test.ts',
  'integration/cache-control.test.ts',
  'integration/cross-tenant.test.ts',
  'integration/csv-import.test.ts',
  'integration/csv-import-commit.test.ts',
  'integration/lead-follow-up.test.ts',
  'integration/notification-scan.test.ts',
  'integration/notifications.test.ts',
  'integration/own-mode.test.ts',
  'integration/test-guard.test.ts',
  'unit/activity-timeline.test.ts',
  'unit/calendar-date.test.ts',
  'unit/csv-formula-injection.test.ts',
  'unit/csv-import-parsing.test.ts',
  'unit/dashboard-helpers.test.ts',
  'unit/live-poll.test.ts',
  'unit/local-day-delta.test.ts',
  'unit/notification-bell.test.ts',
  'unit/payments-received.test.ts',
  'unit/persist-run.test.ts',
  'unit/query-cache-security.test.ts',
  'unit/resolve-org-timezone.test.ts',
  'unit/scope.test.ts',
  'unit/time-periods.test.ts',
  'unit/won-payment-setup.test.ts',
  'types/scope-required.test.ts',
]

const SKIP_MARKER = /\b(it|test|describe)\.(skip|todo)\s*\(|\bxit\s*\(|\bxdescribe\s*\(/

describe('test-guard: no suite file is missing, and nothing is silently skipped', () => {
  const discovered = discoverTestFiles(resolve(REPO_ROOT, 'tests')).sort()

  it('every file this suite expects to exist is actually on disk', () => {
    const missing = KNOWN_TEST_FILES.filter((f) => !discovered.includes(f))
    expect(missing).toEqual([])
  })

  it('no file on disk is missing from this suite\'s known list', () => {
    const unlisted = discovered.filter((f) => !KNOWN_TEST_FILES.includes(f))
    expect(unlisted).toEqual([])
  })

  it.each(discovered)('%s has no .skip/.todo/xit/xdescribe marker', (file) => {
    const source = readFileSync(resolve(REPO_ROOT, 'tests', file), 'utf8')
    expect(SKIP_MARKER.test(source)).toBe(false)
  })
})
