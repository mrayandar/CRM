/**
 * POST /api/ai/generate: the exact check order from the route's own doc comment — auth, body
 * validation, env kill switch, DB kill flag, org enabled + allowlist, scoped subject read (404
 * for both out-of-scope and cross-org), atomic cap reservation, the provider call itself, usage
 * recording. An unauthorized or invalid request must never burn quota (no counter row created).
 *
 * The real dev-provider adapter (lib/ai/getDevAiProvider.ts) is mocked out entirely here — this
 * file is about the route's own gating and bookkeeping, not the provider adapter, which Stage 1's
 * own tests already cover.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockAuth, mockComplete } = vi.hoisted(() => ({ mockAuth: vi.fn(), mockComplete: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@clerk/nextjs/server', () => ({ auth: () => mockAuth(), clerkClient: () => ({}) }))
vi.mock('@lib/ai/getDevAiProvider', () => ({ getDevAiProvider: () => ({ complete: mockComplete }) }))

import { prisma } from '@lib/prisma'
import { ensureDefaultStages } from '@lib/data/stages'
import { AI_CAPS } from '@lib/ai/caps'
import { hourBucketStart } from '@lib/ai/rateLimiter'
import { POST as generatePOST, dynamic as generateDynamic } from '../../app/api/ai/generate/route'
import { KILL_SWITCH_KEY } from '@lib/ai/killSwitch'

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const ORIGINAL_ALLOWLIST = process.env.AI_ASSIST_ALLOWED_ORG_IDS
const ORIGINAL_ENV_KILL = process.env.AI_ASSIST_KILL_SWITCH

interface OrgFixture {
  org: Awaited<ReturnType<typeof prisma.organization.create>>
  company: Awaited<ReturnType<typeof prisma.company.create>>
  rep: Awaited<ReturnType<typeof prisma.owner.create>>
}

async function makeOrg(name: string, aiAssistEnabled: boolean): Promise<OrgFixture> {
  const org = await prisma.organization.create({
    data: { clerkOrgId: `test-ai-gen-${name}-${RUN}`, name: `AI Gen ${name} ${RUN}`, aiAssistEnabled },
  })
  await ensureDefaultStages(org.id)
  const company = await prisma.company.create({ data: { orgId: org.id, name: `AI Gen Co ${name} ${RUN}` } })
  const rep = await prisma.owner.create({
    data: { orgId: org.id, clerkUserId: `test-ai-gen-${name}-rep-${RUN}`, name: 'Rep', email: `rep-${name}-${RUN}@example.com`, role: 'Member' },
  })
  return { org, company, rep }
}

let A: OrgFixture
let B: OrgFixture
let leadA: Awaited<ReturnType<typeof prisma.lead.create>>
let contactA: Awaited<ReturnType<typeof prisma.contact.create>>
let leadB: Awaited<ReturnType<typeof prisma.lead.create>>

beforeAll(async () => {
  A = await makeOrg('A', true)
  B = await makeOrg('B', true)
  process.env.AI_ASSIST_ALLOWED_ORG_IDS = `${A.org.id},${B.org.id}`

  leadA = await prisma.lead.create({
    data: {
      orgId: A.org.id, name: 'Jamie Rivera', title: 'Ops Lead', email: `jamie-${RUN}@example.com`, phone: '555-0100',
      status: 'contacted', source: 'Inbound', location: 'Remote', companyId: A.company.id, ownerId: A.rep.id,
    },
  })
  contactA = await prisma.contact.create({
    data: {
      orgId: A.org.id, name: 'Sam Lee', title: 'VP Sales', email: `sam-${RUN}@example.com`, phone: '555-0101',
      location: 'Remote', companyId: A.company.id, ownerId: A.rep.id, tags: [],
    },
  })
  leadB = await prisma.lead.create({
    data: {
      orgId: B.org.id, name: 'Other Org Lead', title: 'CTO', email: `other-${RUN}@example.com`, phone: '555-0102',
      status: 'new', source: 'Outbound', location: 'Remote', companyId: B.company.id, ownerId: B.rep.id,
    },
  })
})

afterAll(async () => {
  process.env.AI_ASSIST_ALLOWED_ORG_IDS = ORIGINAL_ALLOWLIST
  process.env.AI_ASSIST_KILL_SWITCH = ORIGINAL_ENV_KILL
  vi.unstubAllEnvs()
  for (const org of [A.org, B.org]) {
    await prisma.aiUsage.deleteMany({ where: { orgId: org.id } })
    await prisma.activity.deleteMany({ where: { orgId: org.id } })
    await prisma.lead.deleteMany({ where: { orgId: org.id } })
    await prisma.contact.deleteMany({ where: { orgId: org.id } })
    await prisma.company.deleteMany({ where: { orgId: org.id } })
    await prisma.owner.deleteMany({ where: { orgId: org.id } })
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } })
    await prisma.organization.delete({ where: { id: org.id } })
  }
  await prisma.platformSetting.deleteMany({ where: { key: KILL_SWITCH_KEY } })
  await prisma.$disconnect()
})

beforeEach(() => {
  mockComplete.mockReset()
  mockComplete.mockResolvedValue({ ok: true, result: { text: '[draft]', inputTokens: 10, outputTokens: 20 } })
})

afterEach(async () => {
  mockAuth.mockReset()
  process.env.AI_ASSIST_KILL_SWITCH = ORIGINAL_ENV_KILL
  vi.unstubAllEnvs()
  await prisma.aiRateLimitCounter.deleteMany({ where: { scopeId: { in: [A.org.id, B.org.id, A.rep.id, B.rep.id] } } })
  await prisma.platformSetting.deleteMany({ where: { key: KILL_SWITCH_KEY } })
  await prisma.organization.update({ where: { id: A.org.id }, data: { aiAssistEnabled: true } })
})

function loginAs(owner: { clerkUserId: string | null }, org: { clerkOrgId: string }) {
  mockAuth.mockResolvedValue({ userId: owner.clerkUserId, orgId: org.clerkOrgId, orgRole: 'org:member' })
}

function generateRequest(body: unknown) {
  return generatePOST(
    new Request('http://localhost/api/ai/generate', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
}

async function userHourCount(ownerId: string): Promise<number> {
  const row = await prisma.aiRateLimitCounter.findUnique({
    where: { scopeType_scopeId_bucketStart: { scopeType: 'user_hour', scopeId: ownerId, bucketStart: hourBucketStart(new Date()) } },
  })
  return row?.requestCount ?? 0
}

describe('POST /api/ai/generate: basics', () => {
  it('is force-dynamic', () => {
    expect(generateDynamic).toBe('force-dynamic')
  })

  it('returns 401 and burns no quota when unauthenticated', async () => {
    mockAuth.mockResolvedValue({ userId: null, orgId: null, orgRole: null })
    const response = await generateRequest({ capability: 'draft_email', subjectType: 'lead', subjectId: leadA.id })
    expect(response.status).toBe(401)
    expect(await userHourCount(A.rep.id)).toBe(0)
    expect(mockComplete).not.toHaveBeenCalled()
  })
})

describe('POST /api/ai/generate: body validation (burns no quota)', () => {
  it.each([
    ['missing capability', { subjectType: 'lead', subjectId: 'x' }],
    ['invalid capability', { capability: 'delete_everything', subjectType: 'lead', subjectId: 'x' }],
    ['invalid subjectType', { capability: 'draft_email', subjectType: 'deal', subjectId: 'x' }],
    ['missing subjectId', { capability: 'draft_email', subjectType: 'lead' }],
    ['empty subjectId', { capability: 'draft_email', subjectType: 'lead', subjectId: '' }],
  ])('rejects %s with 400', async (_label, body) => {
    loginAs(A.rep, A.org)
    const response = await generateRequest(body)
    expect(response.status).toBe(400)
    expect(await userHourCount(A.rep.id)).toBe(0)
  })

  it('rejects malformed JSON with 400', async () => {
    loginAs(A.rep, A.org)
    const response = await generateRequest('{not valid json')
    expect(response.status).toBe(400)
  })

  it('rejects a body over the size cap with 400, before even parsing it', async () => {
    loginAs(A.rep, A.org)
    const response = await generateRequest({ capability: 'draft_email', subjectType: 'lead', subjectId: leadA.id, padding: 'x'.repeat(3000) })
    expect(response.status).toBe(400)
    expect(await userHourCount(A.rep.id)).toBe(0)
  })
})

describe('POST /api/ai/generate: kill switches (burn no quota)', () => {
  it('the env kill switch blocks every request with 503, before touching the DB kill flag', async () => {
    loginAs(A.rep, A.org)
    process.env.AI_ASSIST_KILL_SWITCH = 'true'
    const response = await generateRequest({ capability: 'draft_email', subjectType: 'lead', subjectId: leadA.id })
    expect(response.status).toBe(503)
    expect(await userHourCount(A.rep.id)).toBe(0)
    expect(mockComplete).not.toHaveBeenCalled()
  })

  it('the DB kill flag blocks every request with 503', async () => {
    loginAs(A.rep, A.org)
    await prisma.platformSetting.upsert({ where: { key: KILL_SWITCH_KEY }, create: { key: KILL_SWITCH_KEY, value: 'true' }, update: { value: 'true' } })
    const response = await generateRequest({ capability: 'draft_email', subjectType: 'lead', subjectId: leadA.id })
    expect(response.status).toBe(503)
    expect(await userHourCount(A.rep.id)).toBe(0)
  })
})

describe('POST /api/ai/generate: org enabled + allowlist (burn no quota)', () => {
  it('rejects with 403 when the org has AI assist disabled', async () => {
    loginAs(A.rep, A.org)
    await prisma.organization.update({ where: { id: A.org.id }, data: { aiAssistEnabled: false } })
    const response = await generateRequest({ capability: 'draft_email', subjectType: 'lead', subjectId: leadA.id })
    expect(response.status).toBe(403)
    const json = await response.json()
    expect(json.message).toBe('AI assist is not enabled for your organization.')
    expect(await userHourCount(A.rep.id)).toBe(0)
  })

  it('rejects with 403 and the allowlist-specific message when the org is enabled but not on the allowlist', async () => {
    loginAs(A.rep, A.org)
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = B.org.id // A is enabled in the DB but drops off the env allowlist
    const response = await generateRequest({ capability: 'draft_email', subjectType: 'lead', subjectId: leadA.id })
    expect(response.status).toBe(403)
    const json = await response.json()
    expect(json.message).toBe('Not available for your organization yet.')
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = `${A.org.id},${B.org.id}`
  })
})

describe('POST /api/ai/generate: scoped subject read (burns no quota on a miss)', () => {
  it('returns 404 for a lead in another org (cross-tenant)', async () => {
    loginAs(A.rep, A.org)
    const response = await generateRequest({ capability: 'draft_email', subjectType: 'lead', subjectId: leadB.id })
    expect(response.status).toBe(404)
    expect(await userHourCount(A.rep.id)).toBe(0)
  })

  it('returns 404 for an id that does not exist at all, identically to the cross-tenant case', async () => {
    loginAs(A.rep, A.org)
    const response = await generateRequest({ capability: 'draft_email', subjectType: 'lead', subjectId: 'does-not-exist' })
    expect(response.status).toBe(404)
    const crossOrgResponse = await generateRequest({ capability: 'draft_email', subjectType: 'lead', subjectId: leadB.id })
    expect(await response.clone().text()).toBe(await crossOrgResponse.clone().text())
  })

  it('returns 404 for an out-of-scope subject when the org is in OWN mode', async () => {
    await prisma.organization.update({ where: { id: A.org.id }, data: { repVisibility: 'OWN' } })
    const otherRep = await prisma.owner.create({
      data: { orgId: A.org.id, clerkUserId: `test-ai-gen-own-${RUN}`, name: 'Other Rep', email: `other-rep-${RUN}@example.com`, role: 'Member' },
    })
    mockAuth.mockResolvedValue({ userId: otherRep.clerkUserId, orgId: A.org.clerkOrgId, orgRole: 'org:member' })
    const response = await generateRequest({ capability: 'draft_email', subjectType: 'lead', subjectId: leadA.id }) // owned by A.rep, not otherRep
    expect(response.status).toBe(404)
    await prisma.owner.delete({ where: { id: otherRep.id } })
    await prisma.organization.update({ where: { id: A.org.id }, data: { repVisibility: 'ALL' } })
  })
})

describe('POST /api/ai/generate: payment-kind activities never reach the prompt', () => {
  it('summarize excludes a payment-kind activity but includes a note', async () => {
    loginAs(A.rep, A.org)
    await prisma.activity.create({
      data: { orgId: A.org.id, kind: 'note', title: 'Call notes', body: 'Discussed renewal timeline for Q3', actorId: A.rep.id, leadId: leadA.id, ownerId: A.rep.id },
    })
    await prisma.activity.create({
      data: { orgId: A.org.id, kind: 'payment', title: 'Invoice paid', body: 'Paid $500 deposit invoice', actorId: A.rep.id, leadId: leadA.id, ownerId: A.rep.id },
    })
    const response = await generateRequest({ capability: 'summarize', subjectType: 'lead', subjectId: leadA.id })
    expect(response.status).toBe(200)
    const sentPrompt = mockComplete.mock.calls.at(-1)?.[0]?.userPrompt as string
    expect(sentPrompt).toContain('renewal timeline')
    expect(sentPrompt).not.toContain('500')
    expect(sentPrompt).not.toContain('invoice')
    await prisma.activity.deleteMany({ where: { leadId: leadA.id } })
  })
})

describe('POST /api/ai/generate: atomic cap reservation', () => {
  it('returns 429 with the exact cap-reached message once the per-user-hourly cap is hit, and reserves nothing else', async () => {
    loginAs(A.rep, A.org)
    await prisma.aiRateLimitCounter.create({
      data: { scopeType: 'user_hour', scopeId: A.rep.id, bucketStart: hourBucketStart(new Date()), requestCount: AI_CAPS.perUserPerHour },
    })
    const response = await generateRequest({ capability: 'draft_email', subjectType: 'contact', subjectId: contactA.id })
    expect(response.status).toBe(429)
    const json = await response.json()
    expect(json.message).toBe("You've reached this month's AI assist limit for your plan.")
    expect(mockComplete).not.toHaveBeenCalled()
    const orgHourRow = await prisma.aiRateLimitCounter.findFirst({ where: { scopeType: 'org_hour', scopeId: A.org.id } })
    expect(orgHourRow).toBeNull() // never even attempted once user_hour failed
  })

  it('refunds every reserved slot when the provider call fails, leaving counters back at their pre-call value', async () => {
    loginAs(A.rep, A.org)
    mockComplete.mockResolvedValue({ ok: false, errorType: 'provider_error' })
    const response = await generateRequest({ capability: 'draft_email', subjectType: 'contact', subjectId: contactA.id })
    expect(response.status).toBe(503)
    expect(await userHourCount(A.rep.id)).toBe(0) // reserved to 1, then refunded back to 0
  })

  it('a successful call leaves the counter at 1, not refunded', async () => {
    loginAs(A.rep, A.org)
    const response = await generateRequest({ capability: 'draft_email', subjectType: 'contact', subjectId: contactA.id })
    expect(response.status).toBe(200)
    expect(await userHourCount(A.rep.id)).toBe(1)
  })
})

describe('POST /api/ai/generate: production has no real provider wired yet (Stage 4)', () => {
  it('returns 503 unavailable in production, without ever calling the fake provider, and refunds the reservation', async () => {
    loginAs(A.rep, A.org)
    vi.stubEnv('NODE_ENV', 'production')
    const response = await generateRequest({ capability: 'draft_email', subjectType: 'contact', subjectId: contactA.id })
    expect(response.status).toBe(503)
    expect(mockComplete).not.toHaveBeenCalled()
    expect(await userHourCount(A.rep.id)).toBe(0)
  })
})

describe('POST /api/ai/generate: success response shape', () => {
  it('returns only { text }, never token counts or any provider-internal field', async () => {
    loginAs(A.rep, A.org)
    const response = await generateRequest({ capability: 'draft_email', subjectType: 'contact', subjectId: contactA.id })
    const json = await response.json()
    expect(Object.keys(json)).toEqual(['text'])
    expect(json.text).toBe('[draft]')
  })

  it('records AiUsage with the real token counts the provider reported', async () => {
    loginAs(A.rep, A.org)
    mockComplete.mockResolvedValue({ ok: true, result: { text: 'hi', inputTokens: 42, outputTokens: 7 } })
    await generateRequest({ capability: 'draft_email', subjectType: 'contact', subjectId: contactA.id })
    const now = new Date()
    const yearMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    const usage = await prisma.aiUsage.findUnique({
      where: { orgId_yearMonth_capability: { orgId: A.org.id, yearMonth, capability: 'draft_email' } },
    })
    expect(usage?.inputTokens).toBeGreaterThanOrEqual(42)
    expect(usage?.outputTokens).toBeGreaterThanOrEqual(7)
  })
})
