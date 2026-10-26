import 'server-only'

import type { AiProvider } from './provider'
import { getDevAiProvider } from './getDevAiProvider'
import { openAiCompatibleProvider } from './providers/openAiCompatibleProvider'
import { isOrgAllowlistedForAi } from './allowlist'

/** The only two kinds the client is ever told about — never the provider's name, base URL, key,
 *  or allowlist. "dev" covers both the fake provider and the OpenAI-compatible dev adapter
 *  (Gemini) — neither is a real, paid, production-grade adapter, so both carry the same
 *  "development AI" caveat to whoever is looking at the result. */
export type AiProviderKind = 'dev' | 'production'

export interface ResolvedProvider {
  provider: AiProvider
  kind: AiProviderKind
}

function devAdapterFullyConfigured(): boolean {
  return (
    process.env.AI_ALLOW_DEV_PROVIDERS === 'true' &&
    Boolean(process.env.AI_BASE_URL) &&
    Boolean(process.env.AI_API_KEY) &&
    Boolean(process.env.AI_MODEL)
  )
}

/**
 * Chooses what `POST /api/ai/generate` actually calls, for the org the caller already passed the
 * route's own `aiAssistEnabled` + allowlist checks for. Not safe to reuse without that — this
 * function re-checks the allowlist itself for defense in depth, but trusts that the subject/org
 * gating above it in the route already ran; it isn't itself a gate on whether AI assist runs at
 * all, only on which provider answers once everything else already said yes.
 *
 * - Outside production: the existing Stage 1 behavior, unchanged — `getDevAiProvider()` resolves
 *   to the real OpenAI-compatible dev adapter when fully configured, the fake provider otherwise.
 *   No allowlist gate here: there's no real org data flowing through a local dev session for an
 *   allowlist to meaningfully protect.
 * - In production: a real production adapter (Stage 4 — not built yet) would be checked FIRST
 *   and always takes priority over the dev adapter once it exists. Until then, the dev adapter
 *   (the real network call, never the fake provider — `getDevAiProvider()` is deliberately not
 *   reused here) is reachable only when BOTH `AI_ALLOW_DEV_PROVIDERS=true` AND this exact org is
 *   on `AI_ASSIST_ALLOWED_ORG_IDS`. An unset/empty allowlist, or an org not on it, resolves to
 *   `null` — not a fallback to the fake provider, which must never run against production data.
 */
export function resolveProviderForRequest(orgId: string): ResolvedProvider | null {
  const isProduction = process.env.NODE_ENV === 'production'

  if (!isProduction) {
    return { provider: getDevAiProvider(), kind: 'dev' }
  }

  // Stage 4 inserts a real production-adapter check here, returning early with `kind:
  // 'production'` when one is configured — it always wins over the dev adapter below.

  if (devAdapterFullyConfigured() && isOrgAllowlistedForAi(orgId)) {
    return { provider: openAiCompatibleProvider, kind: 'dev' }
  }

  return null
}
