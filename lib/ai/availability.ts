import 'server-only'

import { isOrgAllowlistedForAi } from './allowlist'
import { isEnvKillSwitchActive, isDbKillSwitchActive } from './killSwitch'
import { resolveProviderForRequest, type AiProviderKind } from './resolveProvider'

export interface AiAssistAvailability {
  /** The single boolean the client is allowed to see for "can this org use AI assist right now"
   *  — see lib/data-loader.ts's `aiAssistAvailable` doc comment for what it ANDs together and why
   *  it reveals nothing about the allowlist. */
  available: boolean
  /** Null when `available` is false. Never the provider's name, URL, key, or allowlist — just
   *  which of the two kinds (see resolveProvider.ts) would actually answer right now, so the
   *  client can show a "development AI" badge before a request is even made. */
  providerKind: AiProviderKind | null
}

/**
 * Composed from the same checks the generate route itself runs (org enabled, env allowlist, both
 * kill switches, then whatever `resolveProviderForRequest` would actually resolve to) so the two
 * can never drift apart. `orgId` here is never used to look up *another* org's state — this is
 * always called with the caller's own org.
 */
export async function computeAiAssistAvailability(orgId: string, aiAssistEnabled: boolean): Promise<AiAssistAvailability> {
  if (!aiAssistEnabled) return { available: false, providerKind: null }
  if (!isOrgAllowlistedForAi(orgId)) return { available: false, providerKind: null }
  if (isEnvKillSwitchActive()) return { available: false, providerKind: null }
  if (await isDbKillSwitchActive()) return { available: false, providerKind: null }

  const resolved = resolveProviderForRequest(orgId)
  if (!resolved) return { available: false, providerKind: null }
  return { available: true, providerKind: resolved.kind }
}
