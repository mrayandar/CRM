// Server-only. Stage 1's only provider-resolution rule: the fake provider is the default
// everywhere (every test, and local dev with no AI_* env vars set) — the real OpenAI-compatible
// adapter is only ever selected when AI_ALLOW_DEV_PROVIDERS=true AND all three required env vars
// are present. Never returns a half-configured real provider; falls back to the fake one instead.
//
// Stage 3 adds a proper per-org resolver (BYOK key -> our key, if the org is allowlisted -> off)
// on top of this — this function stays the dev/test-only base case, used directly by
// scripts/ai-try.js and by tests, and will become one branch of that later resolver rather than
// being replaced by it.
import { fakeProvider } from '@lib/ai/providers/fakeProvider'
import { openAiCompatibleProvider } from '@lib/ai/providers/openAiCompatibleProvider'
import type { AiProvider } from '@lib/ai/provider'

export function getDevAiProvider(): AiProvider {
  const devProvidersAllowed = process.env.AI_ALLOW_DEV_PROVIDERS === 'true'
  const hasConfig = Boolean(process.env.AI_BASE_URL && process.env.AI_API_KEY && process.env.AI_MODEL)
  return devProvidersAllowed && hasConfig ? openAiCompatibleProvider : fakeProvider
}
