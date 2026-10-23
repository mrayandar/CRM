/**
 * Confirmation copy for the future Settings switch that lets an admin turn `RepVisibility` on
 * (ALL → OWN) or back off (OWN → ALL) — written now, per the Stage 1b plan, so Stage 1c only has
 * to wire a real `<Modal>` + `updateRepVisibilityAction` around it, not also draft the copy under
 * time pressure. Nothing in this file is imported or rendered yet — the switch itself stays
 * completely hidden until 1c; this is intentionally dead code until then, not a Stage 1b feature.
 *
 * Why the copy says what it says, for whoever wires this in 1c:
 * - Turning ON is framed around what members LOSE (visibility into teammates' records), not
 *   what they gain, because that's the change an admin needs to actually weigh before confirming.
 * - Turning OFF is framed as "returns to how it was" rather than "no effect" — it immediately
 *   restores every member's visibility into every record in the org, which is itself a real,
 *   immediate change worth the same explicit confirmation as turning it on.
 * - Neither direction claims the switch affects already-cached client state on its own — Stage 0's
 *   `QueryCacheSecurityGuard` already clears the whole TanStack Query cache on any `repVisibility`
 *   change, and `loadCrmData`/`GET /api/crm-refetch` both re-scope on the very next request — so
 *   the copy doesn't need to (and shouldn't) tell the admin to ask members to refresh.
 */
export const REP_VISIBILITY_ENABLE_CONFIRM = {
  title: 'Restrict members to their own records?',
  body:
    "Once this is on, every Member (not Admins) will only see leads, contacts, deals, and tasks " +
    "they own or are assigned — not the rest of the team's. Shared data (companies, pipeline " +
    "stages, the team roster, and anyone's own profile) is unaffected. This takes effect " +
    "immediately for every Member's next page load or refresh — there's no transition period.",
  confirmLabel: 'Restrict to own records',
} as const

export const REP_VISIBILITY_DISABLE_CONFIRM = {
  title: 'Let members see the whole team\'s records again?',
  body:
    'This returns to how it was before: every Member can see every lead, contact, deal, and ' +
    "task in the organization, same as an Admin. This takes effect immediately for every " +
    "Member's next page load or refresh.",
  confirmLabel: 'Restore full visibility',
} as const
