/**
 * lib/ai/availability.ts: computeAiAssistAvailability ANDs together every condition the generate
 * route itself checks (org enabled, env allowlist, both kill switches, then whatever
 * resolveProviderForRequest would actually resolve to) into `{ available, providerKind }` — and
 * never reveals *why* it's false, or the allowlist's contents. Real DB for the DB kill-switch
 * case; everything else is pure env/arg checks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '@lib/prisma'
import { computeAiAssistAvailability } from '@lib/ai/availability'
import { KILL_SWITCH_KEY } from '@lib/ai/killSwitch'

const ORIGINAL_ALLOWLIST = process.env.AI_ASSIST_ALLOWED_ORG_IDS
const ORIGINAL_ENV_KILL = process.env.AI_ASSIST_KILL_SWITCH
const ORIGINAL_DEV_FLAG = process.env.AI_ALLOW_DEV_PROVIDERS
const ORG_ID = 'ai-availability-test-org'

afterEach(async () => {
  process.env.AI_ASSIST_ALLOWED_ORG_IDS = ORIGINAL_ALLOWLIST
  process.env.AI_ASSIST_KILL_SWITCH = ORIGINAL_ENV_KILL
  process.env.AI_ALLOW_DEV_PROVIDERS = ORIGINAL_DEV_FLAG
  vi.unstubAllEnvs()
  await prisma.platformSetting.deleteMany({ where: { key: KILL_SWITCH_KEY } })
})

describe('computeAiAssistAvailability', () => {
  it('is unavailable when the org has AI assist disabled, even when everything else would allow it', async () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = ORG_ID
    expect(await computeAiAssistAvailability(ORG_ID, false)).toEqual({ available: false, providerKind: null })
  })

  it('is unavailable when the org is not on the allowlist, even though it is enabled', async () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = 'some-other-org'
    expect(await computeAiAssistAvailability(ORG_ID, true)).toEqual({ available: false, providerKind: null })
  })

  it('is unavailable when the env kill switch is on', async () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = ORG_ID
    process.env.AI_ASSIST_KILL_SWITCH = 'true'
    expect(await computeAiAssistAvailability(ORG_ID, true)).toEqual({ available: false, providerKind: null })
  })

  it('is unavailable when the DB kill switch is on', async () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = ORG_ID
    await prisma.platformSetting.upsert({ where: { key: KILL_SWITCH_KEY }, create: { key: KILL_SWITCH_KEY, value: 'true' }, update: { value: 'true' } })
    expect(await computeAiAssistAvailability(ORG_ID, true)).toEqual({ available: false, providerKind: null })
  })

  it('is available with providerKind "dev" outside production', async () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = ORG_ID
    expect(await computeAiAssistAvailability(ORG_ID, true)).toEqual({ available: true, providerKind: 'dev' })
  })

  it('in production, is unavailable when AI_ALLOW_DEV_PROVIDERS is not set, even though the org is allowlisted and enabled', async () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = ORG_ID
    delete process.env.AI_ALLOW_DEV_PROVIDERS
    vi.stubEnv('NODE_ENV', 'production')
    expect(await computeAiAssistAvailability(ORG_ID, true)).toEqual({ available: false, providerKind: null })
  })

  it('in production, is unavailable for an org not on the allowlist, even with AI_ALLOW_DEV_PROVIDERS=true and the dev adapter fully configured', async () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = 'some-other-org'
    process.env.AI_ALLOW_DEV_PROVIDERS = 'true'
    vi.stubEnv('NODE_ENV', 'production')
    expect(await computeAiAssistAvailability(ORG_ID, true)).toEqual({ available: false, providerKind: null })
  })

  it('returns available: true, never the allowlist contents or any other org state, when every condition passes', async () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = `other-org-1,other-org-2,${ORG_ID},other-org-3`
    const result = await computeAiAssistAvailability(ORG_ID, true)
    expect(result).toEqual({ available: true, providerKind: 'dev' })
    expect(typeof result.available).toBe('boolean')
  })
})
