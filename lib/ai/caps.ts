// AI-assist Stage 2 cap constants — the only place these numbers live, so the route, its tests,
// and anyone auditing cost exposure read the same values. Deliberately conservative: there is no
// billing or per-plan tiering yet (Stage 4/5), so these bound worst-case provider spend for the
// whole org, not a customer-facing quota.
export const AI_CAPS = {
  perUserPerHour: 10,
  perOrgPerHour: 50,
  perOrgPerMonth: 500,
} as const
