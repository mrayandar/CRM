/**
 * lib/ai/availability.ts: computeAiAssistAvailable ANDs together every condition the generate
 * route itself checks (org enabled, env allowlist, both kill switches, a usable provider in this
 * environment) into the one boolean the client is allowed to see — and never reveals *why* it's
 * false. Real DB for the DB kill-switch case; everything else is pure env/arg checks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '@lib/prisma'
import { computeAiAssistAvailable } from '@lib/ai/availability'
import { KILL_SWITCH_KEY } from '@lib/ai/killSwitch'

const ORIGINAL_ALLOWLIST = process.env.AI_ASSIST_ALLOWED_ORG_IDS
const ORIGINAL_ENV_KILL = process.env.AI_ASSIST_KILL_SWITCH
const ORG_ID = 'ai-availability-test-org'

afterEach(async () => {
  process.env.AI_ASSIST_ALLOWED_ORG_IDS = ORIGINAL_ALLOWLIST
  process.env.AI_ASSIST_KILL_SWITCH = ORIGINAL_ENV_KILL
  vi.unstubAllEnvs()
  await prisma.platformSetting.deleteMany({ where: { key: KILL_SWITCH_KEY } })
})

describe('computeAiAssistAvailable', () => {
  it('is false when the org has AI assist disabled, even when everything else would allow it', async () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = ORG_ID
    expect(await computeAiAssistAvailable(ORG_ID, false)).toBe(false)
  })

  it('is false when the org is not on the allowlist, even though it is enabled', async () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = 'some-other-org'
    expect(await computeAiAssistAvailable(ORG_ID, true)).toBe(false)
  })

  it('is false when the env kill switch is on', async () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = ORG_ID
    process.env.AI_ASSIST_KILL_SWITCH = 'true'
    expect(await computeAiAssistAvailable(ORG_ID, true)).toBe(false)
  })

  it('is false when the DB kill switch is on', async () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = ORG_ID
    await prisma.platformSetting.upsert({ where: { key: KILL_SWITCH_KEY }, create: { key: KILL_SWITCH_KEY, value: 'true' }, update: { value: 'true' } })
    expect(await computeAiAssistAvailable(ORG_ID, true)).toBe(false)
  })

  it('is false in production (no real provider wired yet — Stage 4)', async () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = ORG_ID
    vi.stubEnv('NODE_ENV', 'production')
    expect(await computeAiAssistAvailable(ORG_ID, true)).toBe(false)
  })

  it('is true only when every condition passes', async () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = ORG_ID
    expect(await computeAiAssistAvailable(ORG_ID, true)).toBe(true)
  })

  it('returns a plain boolean, never the allowlist contents or any other org state', async () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = `other-org-1,other-org-2,${ORG_ID},other-org-3`
    const result = await computeAiAssistAvailable(ORG_ID, true)
    expect(result).toBe(true)
    expect(typeof result).toBe('boolean')
  })
})
