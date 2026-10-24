/**
 * Every app/api/**\/route.ts response must set `Cache-Control: private, no-store` — these are all
 * per-session or per-org responses (own CRM data, payments, activity history) or a webhook receipt
 * that must never be reused from a shared/intermediary cache. Route files are discovered from the
 * real filesystem, matching tests/integration/action-route-matrix.test.ts's exhaustiveness
 * approach, so a new app/api/**\/route.ts file that forgets this header fails this test
 * immediately rather than shipping silently.
 *
 * This is a static source check, not a per-branch runtime invocation: each of these route files
 * already funnels every `return` through one shared `NO_STORE_HEADERS`-style constant (confirmed
 * by this test's `requiredLiteral` check), so parsing every `return new Response(...)` /
 * `return NextResponse.json(...)` statement for that same literal covers every branch, including
 * ones that would otherwise need a full DB/Clerk-mocked invocation to reach (e.g. the webhook's
 * signature-verification failure path). crmRefetchGET/activitiesGET's 200 paths are additionally
 * exercised at runtime in tests/integration/own-mode.test.ts, which asserts this same header on
 * real Response objects coming out of a real request.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../..')
const REQUIRED_HEADER_LITERAL = "'Cache-Control': 'private, no-store'"

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

/** Finds every `return new Response(...)` / `return NextResponse.json(...)` statement's full
 *  argument list, using balanced-paren scanning (these calls nest object literals, which a regex
 *  can't safely bound). */
function findReturnedResponseCalls(source: string): string[] {
  const calls: string[] = []
  const callStart = /return\s+(?:new Response\(|NextResponse\.json\()/g
  let match: RegExpExecArray | null
  while ((match = callStart.exec(source))) {
    const openParenIndex = match.index + match[0].length - 1
    let depth = 1
    let i = openParenIndex + 1
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') depth--
      i++
    }
    calls.push(source.slice(openParenIndex, i))
  }
  return calls
}

describe('every app/api/**/route.ts response sets Cache-Control: private, no-store', () => {
  const routeFiles = discoverRouteFiles(resolve(REPO_ROOT, 'app/api'))

  it('discovered at least the known route files (discovery itself did not silently find nothing)', () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(3)
  })

  it.each(routeFiles)('%s: every returned Response/NextResponse.json carries the no-store header', (file) => {
    const source = readFileSync(resolve(REPO_ROOT, 'app/api', file), 'utf8')
    expect(source).toContain(REQUIRED_HEADER_LITERAL)

    const calls = findReturnedResponseCalls(source)
    expect(calls.length).toBeGreaterThan(0)
    const missing = calls.filter((call) => !call.includes('NO_STORE_HEADERS') && !call.includes(REQUIRED_HEADER_LITERAL))
    expect(missing).toEqual([])
  })
})
