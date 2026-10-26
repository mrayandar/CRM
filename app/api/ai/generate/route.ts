import { NextResponse } from 'next/server'
import type { AiCapability } from '@prisma/client'
import { requireAuth } from '@lib/auth'
import { getOrgById } from '@lib/data/organizations'
import { getLeadById } from '@lib/data/leads'
import { getContactById } from '@lib/data/contacts'
import { listActivitiesForAiPrompt } from '@lib/data/activities'
import { isOrgAllowlistedForAi } from '@lib/ai/allowlist'
import { isEnvKillSwitchActive, isDbKillSwitchActive } from '@lib/ai/killSwitch'
import { AI_CAPS } from '@lib/ai/caps'
import { hourBucketStart, monthBucketStart, reserveSlot, refundSlot, type AiRateLimitScopeType } from '@lib/ai/rateLimiter'
import { recordAiUsage } from '@lib/ai/usage'
import { logAiRequest, promptHash } from '@lib/ai/logging'
import { resolveProviderForRequest } from '@lib/ai/resolveProvider'
import { buildFollowUpEmailPrompt, buildTimelineSummaryPrompt, buildNextStepPrompt } from '@lib/ai/promptBuilder'
import type { PromptBuilderSubject, PromptBuilderActivity, BuiltPrompt } from '@lib/ai/promptBuilder'
import type { Scope } from '@lib/scope'

/**
 * POST /api/ai/generate — the only entry point that calls an AI provider with real org data.
 * Route Handler, not a Server Action, matching every other provider/queue-sensitive endpoint in
 * this app (GET /api/calendar, GET /api/crm-refetch) — a slow or stuck provider call must never
 * sit behind Next's action-dispatch queue and block an unrelated mutation.
 *
 * Check order (an unauthorized or invalid request never burns quota — every check below a given
 * point only runs once every check above it has passed):
 *   1. session (requireAuth)                          -> 401
 *   2. body validation                                 -> 400
 *   3. env kill switch (AI_ASSIST_KILL_SWITCH)          -> 503 "unavailable"
 *   4. DB kill flag (platform_settings)                 -> 503 "unavailable"
 *   5. org.aiAssistEnabled, then AI_ASSIST_ALLOWED_ORG_IDS allowlist -> 403
 *   6. scoped by-id read of the subject (404 for both out-of-scope AND cross-org — identical
 *      response either way, so a client can't use this to distinguish "doesn't exist" from
 *      "exists but isn't yours")
 *   7. atomic cap reservation (user/hour, org/hour, org/month), ONLY once every check above has
 *      passed                                          -> 429 on any cap reached
 *   8. the provider call itself — a failure here refunds every slot reserved in step 7 and
 *      returns the generic unavailable message, never the provider's own error text
 *   9. on success: record usage (lib/ai/usage.ts), return the plain-text result
 *
 * Step 8's provider resolution (lib/ai/resolveProvider.ts) — the fake provider is only ever
 * reachable in a non-production NODE_ENV. In production, with no real production adapter wired
 * yet (Stage 4), the dev adapter (a real network call, e.g. Gemini) is reachable ONLY when both
 * `AI_ALLOW_DEV_PROVIDERS=true` and this org is on `AI_ASSIST_ALLOWED_ORG_IDS` — any other
 * production org gets the unavailable message instead. A successful response also returns
 * `providerKind` ('dev' | 'production') so the client can show a "development AI" badge; never
 * the provider's name, URL, key, or allowlist.
 */
export const dynamic = 'force-dynamic'

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }
const CAPABILITIES: AiCapability[] = ['draft_email', 'summarize', 'next_step']
const SUBJECT_TYPES = ['lead', 'contact'] as const
const MAX_BODY_BYTES = 2048
const MAX_OUTPUT_TOKENS = 500
const PROVIDER_TIMEOUT_MS = 20_000

const UNAVAILABLE_MESSAGE = "AI assist isn't available right now. Please try again later."
const CAP_REACHED_MESSAGE = "You've reached this month's AI assist limit for your plan."
const NOT_ALLOWLISTED_MESSAGE = 'Not available for your organization yet.'
const NOT_ENABLED_MESSAGE = 'AI assist is not enabled for your organization.'

interface GenerateRequestBody {
  capability: AiCapability
  subjectType: 'lead' | 'contact'
  subjectId: string
}

function parseBody(raw: unknown): GenerateRequestBody | null {
  if (typeof raw !== 'object' || raw === null) return null
  const body = raw as Record<string, unknown>
  if (typeof body.capability !== 'string' || !CAPABILITIES.includes(body.capability as AiCapability)) return null
  if (typeof body.subjectType !== 'string' || !SUBJECT_TYPES.includes(body.subjectType as 'lead' | 'contact')) return null
  if (typeof body.subjectId !== 'string' || body.subjectId.length === 0 || body.subjectId.length > 100) return null
  return { capability: body.capability as AiCapability, subjectType: body.subjectType as 'lead' | 'contact', subjectId: body.subjectId }
}

async function buildPrompt(scope: Scope, body: GenerateRequestBody): Promise<BuiltPrompt | 'not_found'> {
  let subject: PromptBuilderSubject
  if (body.subjectType === 'lead') {
    const lead = await getLeadById(scope, body.subjectId)
    if (!lead) return 'not_found'
    subject = {
      type: 'lead',
      lead: { name: lead.name, title: lead.title, status: lead.status, source: lead.source, companyName: lead.company.name },
    }
  } else {
    const contact = await getContactById(scope, body.subjectId)
    if (!contact) return 'not_found'
    subject = {
      type: 'contact',
      contact: { name: contact.name, title: contact.title, lifecycle: contact.lifecycle, tags: contact.tags, companyName: contact.company.name },
    }
  }

  if (body.capability === 'draft_email') return buildFollowUpEmailPrompt(subject)

  const rows = await listActivitiesForAiPrompt(scope, { type: body.subjectType, id: body.subjectId })
  const activities: PromptBuilderActivity[] = rows.map((a) => ({ kind: a.kind, title: a.title, body: a.body, actorName: a.actor.name }))
  return body.capability === 'summarize' ? buildTimelineSummaryPrompt(subject, activities) : buildNextStepPrompt(subject, activities)
}

function unavailable() {
  return NextResponse.json({ error: 'unavailable', message: UNAVAILABLE_MESSAGE }, { status: 503, headers: NO_STORE_HEADERS })
}

export async function POST(request: Request) {
  // 1. session
  let session: Awaited<ReturnType<typeof requireAuth>>
  try {
    session = await requireAuth()
  } catch {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401, headers: NO_STORE_HEADERS })
  }
  const scope: Scope = { orgId: session.orgId, scopeOwnerId: session.scopeOwnerId }

  // 2. body validation
  const rawText = await request.text()
  if (rawText.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400, headers: NO_STORE_HEADERS })
  }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(rawText)
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400, headers: NO_STORE_HEADERS })
  }
  const body = parseBody(parsedJson)
  if (!body) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400, headers: NO_STORE_HEADERS })
  }

  // 3. env kill switch
  if (isEnvKillSwitchActive()) return unavailable()

  // 4. DB kill flag
  if (await isDbKillSwitchActive()) return unavailable()

  // 5. org enabled, then allowlist
  const org = await getOrgById(session.orgId)
  if (!org?.aiAssistEnabled) {
    return NextResponse.json({ error: 'forbidden', message: NOT_ENABLED_MESSAGE }, { status: 403, headers: NO_STORE_HEADERS })
  }
  if (!isOrgAllowlistedForAi(session.orgId)) {
    return NextResponse.json({ error: 'forbidden', message: NOT_ALLOWLISTED_MESSAGE }, { status: 403, headers: NO_STORE_HEADERS })
  }

  // 6. scoped by-id read of the subject
  const built = await buildPrompt(scope, body)
  if (built === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE_HEADERS })
  }

  // 7. atomic cap reservation — the fake/real provider is never called before every one of these
  // has actually reserved a slot.
  const now = new Date()
  const hourBucket = hourBucketStart(now)
  const monthBucket = monthBucketStart(now)
  const reserved: Array<{ scopeType: AiRateLimitScopeType; scopeId: string; bucket: Date }> = []

  async function reserveOrFail(scopeType: AiRateLimitScopeType, scopeId: string, bucket: Date, cap: number): Promise<boolean> {
    const ok = await reserveSlot(scopeType, scopeId, bucket, cap)
    if (ok) reserved.push({ scopeType, scopeId, bucket })
    return ok
  }

  async function refundReserved(): Promise<void> {
    await Promise.all(reserved.map((r) => refundSlot(r.scopeType, r.scopeId, r.bucket)))
  }

  if (!(await reserveOrFail('user_hour', session.ownerId, hourBucket, AI_CAPS.perUserPerHour))) {
    await refundReserved()
    return NextResponse.json({ error: 'cap_reached', message: CAP_REACHED_MESSAGE }, { status: 429, headers: NO_STORE_HEADERS })
  }
  if (!(await reserveOrFail('org_hour', session.orgId, hourBucket, AI_CAPS.perOrgPerHour))) {
    await refundReserved()
    return NextResponse.json({ error: 'cap_reached', message: CAP_REACHED_MESSAGE }, { status: 429, headers: NO_STORE_HEADERS })
  }
  if (!(await reserveOrFail('org_month', session.orgId, monthBucket, AI_CAPS.perOrgPerMonth))) {
    await refundReserved()
    return NextResponse.json({ error: 'cap_reached', message: CAP_REACHED_MESSAGE }, { status: 429, headers: NO_STORE_HEADERS })
  }

  // 8. the provider call
  const resolved = resolveProviderForRequest(session.orgId)
  if (!resolved) {
    await refundReserved()
    return unavailable()
  }
  const { provider, kind: providerKind } = resolved

  const hash = promptHash(built.userPrompt)
  const startedAt = Date.now()
  const outcome = await provider.complete({
    systemPrompt: built.systemPrompt,
    userPrompt: built.userPrompt,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    timeoutMs: PROVIDER_TIMEOUT_MS,
  })
  const latencyMs = Date.now() - startedAt

  if (!outcome.ok) {
    await refundReserved()
    logAiRequest({ capability: body.capability, orgId: session.orgId, latencyMs, errorType: outcome.errorType, promptHash: hash })
    return unavailable()
  }

  // 9. record usage, return the result
  await recordAiUsage(session.orgId, body.capability, outcome.result.inputTokens, outcome.result.outputTokens, now)
  logAiRequest({
    capability: body.capability,
    orgId: session.orgId,
    inputTokens: outcome.result.inputTokens,
    outputTokens: outcome.result.outputTokens,
    latencyMs,
    promptHash: hash,
  })
  return NextResponse.json({ text: outcome.result.text, providerKind }, { headers: NO_STORE_HEADERS })
}
