/**
 * The set of orgs allowed to use AI assist at all, independent of `Organization.aiAssistEnabled`
 * — an org not on this list can never turn the Settings toggle on (updateAiAssistEnabledAction
 * checks this too), and the generate route checks it again on every request, so a change to this
 * env var takes effect immediately without needing to touch any org's DB row. Kept as an env var,
 * not a DB table, deliberately: Stage 2 has no billing/plan tiering to drive this from yet, and an
 * env var is the one change here that needs no deploy-time migration or admin UI at all.
 *
 * Pure and dependency-free (no `server-only`) so it's safe to import from a test without pulling
 * in Prisma.
 */
export function isOrgAllowlistedForAi(orgId: string): boolean {
  const raw = process.env.AI_ASSIST_ALLOWED_ORG_IDS
  if (!raw) return false
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(orgId)
}
