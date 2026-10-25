'use server'

import { revalidatePath } from 'next/cache'
import { requireLiveAdminAccess } from '@lib/auth'
import { isOrgAllowlistedForAi } from '@lib/ai/allowlist'
import { updateAiAssistEnabled } from '@lib/data/organizations'
import { tryAdminSession, FORBIDDEN, type ForbiddenResult } from '@lib/actions/shared'

export type AiAssistToggleResult =
  | { ok: true; aiAssistEnabled: boolean; changedAt: string }
  | { ok: false; error: 'not_allowlisted' }
  | ForbiddenResult

/**
 * Admin-only via `requireLiveAdminAccess()` — same live-Clerk-role check (not just the DB's own,
 * possibly-stale `Owner.role`) as `updateRepVisibilityAction`, for the same reason: this is
 * sensitive in either direction, since turning it on starts sending record text to an external
 * provider. Also enforced here, not just displayed by the UI: an org not on the
 * `AI_ASSIST_ALLOWED_ORG_IDS` allowlist can never be switched to enabled=true, regardless of
 * admin role — the generate route checks the same allowlist again on every request, so this is
 * defense in depth, not the only gate.
 */
export async function updateAiAssistEnabledAction(enabled: boolean): Promise<AiAssistToggleResult> {
  const session = await tryAdminSession(requireLiveAdminAccess)
  if (!session) return FORBIDDEN
  if (enabled && !isOrgAllowlistedForAi(session.orgId)) {
    return { ok: false, error: 'not_allowlisted' }
  }

  const updated = await updateAiAssistEnabled(session.orgId, enabled, session.ownerId)
  revalidatePath('/', 'layout')
  return { ok: true, aiAssistEnabled: updated.aiAssistEnabled, changedAt: updated.aiAssistEnabledChangedAt!.toISOString() }
}
