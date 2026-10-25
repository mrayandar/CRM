import 'server-only'

import { prisma } from '@lib/prisma'

export const KILL_SWITCH_KEY = 'ai_kill_switch'

/**
 * Two independent kill paths, checked in this order by the generate route:
 * 1. The `AI_ASSIST_KILL_SWITCH` env var — no DB round-trip, so it still works if the database
 *    itself is what's misbehaving. Set in Vercel env, takes effect on next deploy/restart.
 * 2. The `platform_settings` row (key `ai_kill_switch`) — takes effect immediately, no deploy
 *    needed, but only reachable via `scripts/ai-kill.js` run locally; never a route or Server
 *    Action, so no session or org membership can ever flip it (see that script's own doc
 *    comment and PlatformSetting's schema comment).
 */
export function isEnvKillSwitchActive(): boolean {
  return process.env.AI_ASSIST_KILL_SWITCH === 'true'
}

export async function isDbKillSwitchActive(): Promise<boolean> {
  const row = await prisma.platformSetting.findUnique({ where: { key: KILL_SWITCH_KEY } })
  return row?.value === 'true'
}
