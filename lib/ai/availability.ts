import 'server-only'

import { isOrgAllowlistedForAi } from './allowlist'
import { isEnvKillSwitchActive, isDbKillSwitchActive } from './killSwitch'

/** Mirrors the generate route's own "is there anything to call" check (`NODE_ENV !== 'production'`
 *  resolves to the dev provider; production has no real adapter wired yet — Stage 4). Shared by
 *  both so they can never drift apart. */
export function hasUsableProviderInThisEnvironment(): boolean {
  return process.env.NODE_ENV !== 'production'
}

/**
 * The single boolean the client is allowed to see for "can this org use AI assist right now" —
 * composed from the same checks the generate route itself runs (org enabled, env allowlist, both
 * kill switches, a usable provider), but collapsed to one flag. Deliberately never returns *why*
 * it's false: the allowlist's contents, which org is on it, or any other org's state never reach
 * the client — see lib/data-loader.ts's own doc comment on `aiAssistAvailable`.
 */
export async function computeAiAssistAvailable(orgId: string, aiAssistEnabled: boolean): Promise<boolean> {
  if (!aiAssistEnabled) return false
  if (!isOrgAllowlistedForAi(orgId)) return false
  if (isEnvKillSwitchActive()) return false
  if (await isDbKillSwitchActive()) return false
  if (!hasUsableProviderInThisEnvironment()) return false
  return true
}
