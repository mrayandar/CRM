/**
 * Confirmation copy for the Settings switch that lets an admin turn `RepVisibility` on
 * (ALL → OWN) or back off (OWN → ALL) — drafted in Stage 1b, wired into a real `<Modal>` +
 * `updateRepVisibilityAction` in Stage 1c (see `RepVisibilitySection` in `src/screens/Settings.tsx`).
 *
 * Why the copy says what it says:
 * - Turning ON is framed around what members LOSE (visibility into teammates' records), not
 *   what they gain, because that's the change an admin needs to actually weigh before confirming.
 * - Turning OFF is framed as "returns to how it was" rather than "no effect" — it immediately
 *   restores every member's visibility into every record in the org, which is itself a real,
 *   immediate change worth the same explicit confirmation as turning it on.
 * - Both directions say "up to a minute" for an already-open tab, not "immediately" — a tab that
 *   isn't reloaded only re-scopes on its next live-poll refetch (src/store/livePoll.ts, 60s
 *   steady-state interval), and `QueryCacheSecurityGuard` clears the whole TanStack Query cache
 *   the moment that refetch's `repVisibility` differs from what the tab already had. A fresh
 *   page load re-scopes immediately, same as any other server-rendered data.
 */
export const REP_VISIBILITY_ENABLE_CONFIRM = {
  title: 'Restrict members to their own records?',
  body:
    "Once this is on, every Member (not Admins) will only see leads, contacts, deals, and tasks " +
    "they own or are assigned — not the rest of the team's. Shared data (companies, pipeline " +
    "stages, the team roster, and anyone's own profile) is unaffected. This takes effect " +
    "immediately on a fresh page load, and within about a minute for a tab that's already open.",
  confirmLabel: 'Restrict to own records',
} as const

export const REP_VISIBILITY_DISABLE_CONFIRM = {
  title: 'Let members see the whole team\'s records again?',
  body:
    'This returns to how it was before: every Member can see every lead, contact, deal, and ' +
    'task in the organization, same as an Admin. This takes effect immediately on a fresh page ' +
    "load, and within about a minute for a tab that's already open.",
  confirmLabel: 'Restore full visibility',
} as const
