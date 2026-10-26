/**
 * lib/ai/resolveProvider.ts: which provider (if any) POST /api/ai/generate actually calls.
 * Pure env/arg logic, no DB. The critical property under test: in production, the dev adapter
 * (a real network call) is reachable ONLY when AI_ALLOW_DEV_PROVIDERS=true AND the org is on the
 * allowlist — the fake provider must never be reachable in production at all, and an empty/unset
 * allowlist or a non-allowlisted org must fail closed in every environment.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveProviderForRequest } from '@lib/ai/resolveProvider'

const ORIGINAL_ALLOWLIST = process.env.AI_ASSIST_ALLOWED_ORG_IDS
const ORIGINAL_DEV_FLAG = process.env.AI_ALLOW_DEV_PROVIDERS
const ORIGINAL_BASE_URL = process.env.AI_BASE_URL
const ORIGINAL_API_KEY = process.env.AI_API_KEY
const ORIGINAL_MODEL = process.env.AI_MODEL
const ORG_ID = 'resolve-provider-test-org'

function setDevAdapterFullyConfigured(configured: boolean) {
  if (configured) {
    process.env.AI_ALLOW_DEV_PROVIDERS = 'true'
    process.env.AI_BASE_URL = 'https://example.invalid/v1'
    process.env.AI_API_KEY = 'test-key-not-real'
    process.env.AI_MODEL = 'test-model'
  } else {
    delete process.env.AI_ALLOW_DEV_PROVIDERS
  }
}

afterEach(() => {
  process.env.AI_ASSIST_ALLOWED_ORG_IDS = ORIGINAL_ALLOWLIST
  process.env.AI_ALLOW_DEV_PROVIDERS = ORIGINAL_DEV_FLAG
  process.env.AI_BASE_URL = ORIGINAL_BASE_URL
  process.env.AI_API_KEY = ORIGINAL_API_KEY
  process.env.AI_MODEL = ORIGINAL_MODEL
  vi.unstubAllEnvs()
})

describe('resolveProviderForRequest: outside production', () => {
  it('resolves to a "dev" provider regardless of the allowlist (no real org data at stake locally)', () => {
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = ''
    setDevAdapterFullyConfigured(false)
    const resolved = resolveProviderForRequest(ORG_ID)
    expect(resolved).not.toBeNull()
    expect(resolved?.kind).toBe('dev')
  })
})

describe('resolveProviderForRequest: in production', () => {
  it('refuses when AI_ALLOW_DEV_PROVIDERS is not set, even for an allowlisted org', () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = ORG_ID
    setDevAdapterFullyConfigured(false)
    expect(resolveProviderForRequest(ORG_ID)).toBeNull()
  })

  it('refuses when the dev adapter is fully configured but the org is not on the allowlist', () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = 'some-other-org'
    setDevAdapterFullyConfigured(true)
    expect(resolveProviderForRequest(ORG_ID)).toBeNull()
  })

  it('refuses when the allowlist is unset entirely, even with the dev adapter fully configured', () => {
    vi.stubEnv('NODE_ENV', 'production')
    delete process.env.AI_ASSIST_ALLOWED_ORG_IDS
    setDevAdapterFullyConfigured(true)
    expect(resolveProviderForRequest(ORG_ID)).toBeNull()
  })

  it('refuses when the allowlist is empty, even with the dev adapter fully configured', () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = ''
    setDevAdapterFullyConfigured(true)
    expect(resolveProviderForRequest(ORG_ID)).toBeNull()
  })

  it('resolves to the real dev adapter ("dev" kind) only when both AI_ALLOW_DEV_PROVIDERS=true and the org is allowlisted', () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = ORG_ID
    setDevAdapterFullyConfigured(true)
    const resolved = resolveProviderForRequest(ORG_ID)
    expect(resolved).not.toBeNull()
    expect(resolved?.kind).toBe('dev')
  })

  it('never falls back to the fake provider — missing config resolves to null, not a usable provider', () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.AI_ASSIST_ALLOWED_ORG_IDS = ORG_ID
    process.env.AI_ALLOW_DEV_PROVIDERS = 'true'
    delete process.env.AI_BASE_URL // dev adapter not FULLY configured
    expect(resolveProviderForRequest(ORG_ID)).toBeNull()
  })
})
