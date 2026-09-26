# NexoCRM — Progress tracker

> Living context file. Updated at the end of every task.

## Status

**Phase: Auth + real data — auth flow now working end to end.** Clerk
authentication and multi-tenancy are integrated, the data layer
(Prisma/Postgres, `lib/data/*`, server actions) is real, and the
organization-selection redirect loop that blocked the whole app has been
root-caused and fixed (see "Fixed: Clerk org-selection redirect loop"
below). Verified in a real browser: fresh sign-up → email verification →
create organization → select organization → the actual dashboard, plus
sign-out → sign-in → select org → dashboard. `Organization` and `Owner`
rows are created correctly in Postgres by `resolveAuth()`.

Audit items #3–14 (lead/contact/deal/task CRUD, pipeline drag persistence,
activity timeline, search, dashboard metrics, team settings) are now
**unblocked but still unverified** — they have not been exercised in a
browser yet.

## Fixed: Clerk org-selection redirect loop (Sep 26 2026)

The bug: after sign-up or sign-in, Clerk showed "Choose an organization";
selecting any org (existing or new) sent the browser into an infinite
redirect loop and never reached the app.

### Observed redirect sequence (captured in the browser)

```
localhost:3000/sign-in/tasks/choose-organization   (org clicked)
  -> localhost:3000/                               (Clerk navigates to fallback)
  -> [middleware auth.protect() sees sessionStatus === "pending"]
  -> superb-cowbird-9296.accounts.dev/sign-in/tasks?redirect_url=localhost:3000/...
  -> back to localhost:3000/sign-in/tasks/choose-organization
  -> ... loop, with redirect_url nesting one level deeper each hop
```

### Root cause

Four compounding defects, not one:

**1. `signInUrl` / `signUpUrl` were never configured** — absent from `.env`,
from `<ClerkProvider>`, and from `clerkMiddleware`. `createRedirect` in
`@clerk/backend` falls back to the hosted Account Portal origin when
`signInUrl` is unset, and appends `/tasks` for a pending session:

```js
const targetUrl = signInUrl || accountsSignInUrl;   // -> *.accounts.dev
if (hasPendingStatus) return redirectToTasks(targetUrl, { returnBackUrl });
```

So every redirect for a pending session left our origin entirely.

**2. `auth.protect()` treats a pending-task session as unauthenticated.**
From `@clerk/nextjs/dist/esm/server/protect.js`:

```js
if (authObject.sessionStatus === "pending") {
  return handleUnauthenticated();   // -> redirectToSignIn()
}
```

`middleware.ts` blanket-protected everything except `/sign-in`, `/sign-up`
and `/api/webhooks`, so both `/` and `/create-org` fed pending sessions
into defect 1. The Account Portal then redirected back to `redirect_url`,
the middleware bounced it straight back out, and the two sides ping-ponged
forever. **This is why the middleware was the trigger — not through
`auth().orgId`, but through `auth.protect()` rejecting `"pending"`.**

**3. Routing-mode mismatch.** `<SignIn>`/`<SignUp>` had no `routing`/`path`
props, so Clerk rendered task sub-routes with **hash** routing
(`/sign-in#/tasks/choose-organization`) while the middleware's redirect
target was the **path** `/sign-in/tasks`. Each convention redirected to the
other's URL.

**4. The real blocker underneath: `force_organization_selection: true` on
the Clerk instance.** That setting mints a `choose-organization` session
task, and Clerk's task UI never issued the request that would resolve it.
Proven two ways — resource timing after clicking an org showed only a token
mint and no session `touch`, and querying the Frontend API directly
returned:

```json
{ "status": "pending",
  "tasks": [{ "key": "choose-organization" }],
  "last_active_organization_id": null }
```

Calling the endpoint by hand, `POST /v1/client/sessions/<sid>/touch` with
`active_organization_id`, immediately returned `"status": "active"` with the
org set. The server was always willing; Clerk's hosted task UI was the
broken link.

Critically, this task is a **redundant second gate**. The app already
enforces org membership server-side in `resolveAuth()`, which redirects to
`/create-org` on every `(app)` route — a stronger guarantee than a
client-side task. Two competing org-selection mechanisms *were* the
conflict, which is what question 3 was pointing at.

**Also real (question 2):** an explicit after-select URL was required and
entirely missing. `<CreateOrganization>` had no `skipInvitationScreen`, so
after creating an org Clerk parked the user on an invite step without ever
activating it — `resolveAuth()` then sent them back to `/create-org`
indefinitely. And no `<OrganizationList>` existed at all, so a user with
memberships but no *active* org had no way to select one.

### The fix

| File / target | Change |
|---|---|
| `middleware.ts` | Explicit `signInUrl: '/sign-in'`, `signUpUrl: '/sign-up'` on `clerkMiddleware`; added `/create-org(.*)` to the unprotected matcher so pending sessions aren't bounced out of the page meant to resolve them |
| `app/layout.tsx` | `<ClerkProvider signInUrl="/sign-in" signUpUrl="/sign-up">` so client-side task URLs stay on our origin |
| `app/sign-in/[[...sign-in]]/page.tsx` | `routing="path"`, `path="/sign-in"`, `signUpUrl`, `fallbackRedirectUrl="/"` |
| `app/sign-up/[[...sign-up]]/page.tsx` | `routing="path"`, `path="/sign-up"`, `signInUrl`, `fallbackRedirectUrl="/"` |
| `app/create-org/page.tsx` | `<OrganizationList hidePersonal afterSelectOrganizationUrl="/" afterCreateOrganizationUrl="/">` when the user has memberships; otherwise `<CreateOrganization skipInvitationScreen afterCreateOrganizationUrl="/">` |
| Clerk instance config | `force_organization_selection: false` via `scripts/clerk-org-settings.js` (Backend API) |

`scripts/clerk-org-settings.js` is committed because that instance setting
is otherwise invisible to the repo — it can read the current settings and
re-apply the fix on a new Clerk instance.

Note the middleware/provider config is set **in code**, not via
`NEXT_PUBLIC_CLERK_*_URL` env vars. `.env` only had the publishable and
secret keys; pinning these in code means the fix doesn't depend on
per-developer env setup.

### Verified end to end in a real browser

1. Fresh sign-up (`nexoverify1@mailinator.com`) → email code → **PASS**
2. Redirected to `/create-org`, created "Nexo Verified Org" → **PASS**
3. Selected the org → landed on the real dashboard at `/` with the org in
   the sidebar → **PASS**
4. Signed out, signed back in, selected org → dashboard → **PASS**
5. Confirmed in Postgres by direct query:
   ```
   Organization cmui9z4s60005f8g8w9tchde5  org_3JrXKqe266Pfd5lgMo4O9A5wAQz  "Nexo Verified Org"
   Owner        cmui9z7g40006f8g8kyykna7t  nexoverify1@mailinator.com
   ```
   Also confirmed for "Nexo Audit Org" once its session was activated.

## Functional audit (Sep 26 2026)

Full click-through audit of the 14 core flows, tested live in a real
browser against the running dev server and Neon database (not a code
read-through). Verdicts are PASS, FAIL (exact error included), NOT
TESTABLE (blocked by an earlier failure), or NOT YET BUILT.

> **Items 1 and 2 were subsequently fixed** — see "Fixed: Clerk
> org-selection redirect loop" above. Items 3–14 are unblocked but have
> not been re-tested yet, so they remain unverified.

| # | Flow | Verdict |
|---|------|---------|
| 1 | Sign up / sign in | ✅ PASS (was PARTIAL — fixed) |
| 2 | Create an organization | ✅ PASS (was FAIL — fixed) |
| 3 | Create a lead | ⬜ UNVERIFIED (unblocked, not yet tested) |
| 4 | Edit a lead | ⬜ UNVERIFIED (unblocked, not yet tested) |
| 5 | Convert a lead (contact-only) | ⬜ UNVERIFIED (unblocked, not yet tested) |
| 6 | Create a contact directly | ⬜ UNVERIFIED (unblocked, not yet tested) |
| 7 | Create a company | ⬜ UNVERIFIED (unblocked, not yet tested) |
| 8 | Create a deal | ⬜ UNVERIFIED (unblocked, not yet tested) |
| 9 | Drag a deal across pipeline stages + persist | ⬜ UNVERIFIED (unblocked, not yet tested) |
| 10 | Create a task, mark it complete | ⬜ UNVERIFIED (unblocked, not yet tested) |
| 11 | Log an activity, confirm in timeline | ⬜ UNVERIFIED (unblocked, not yet tested) |
| 12 | Global search | ⬜ UNVERIFIED (unblocked, not yet tested) |
| 13 | Dashboard — real vs. mock metrics | ⬜ UNVERIFIED (unblocked, not yet tested) |
| 14 | Team settings — invite user, change role | ⬜ UNVERIFIED (unblocked, not yet tested) |

### 1. Sign up / sign in — ⚠️ PARTIAL

- **Sign-up mechanics: PASS.** Created a fresh account
  (`nexoaudit_test@mailinator.com`) via `/sign-up` with email + password.
  Email verification code was retrieved from the real Mailinator public
  inbox and entered successfully. Clerk accepted the account with no
  errors.
- **Sign-in mechanics: PASS.** Signed out and signed back in with the
  same email/password via `/sign-in` with no errors.
- **Post-auth org resolution: FAIL.** Immediately after sign-up (and
  again after sign-in), Clerk presents a "Choose an organization" task
  screen. Selecting *any* organization — a pre-existing one or a newly
  created one — triggers an infinite redirect loop and the browser never
  reaches the app (see #2 for full detail). So while the credential
  mechanics of sign-up/sign-in work, **no session created via
  email/password in this environment can currently reach the CRM.**

### 2. Create an organization — ❌ FAIL

**Exact reproduction:**
1. Sign up or sign in at `/sign-up` or `/sign-in`.
2. Clerk presents "Choose an organization" (either at Clerk's hosted
   `https://superb-cowbird-9296.accounts.dev/sign-in/tasks/choose-organization`
   or our embedded `/sign-in/tasks/choose-organization`).
3. Click any existing org, or "Create new organization" → name it → submit.
4. The browser redirects to `https://superb-cowbird-9296.accounts.dev/sign-in/tasks/choose-organization?redirect_url=...`
   with the `redirect_url` query param wrapping the *previous* URL
   (URL-encoded), then redirects back to our embedded route with the same
   pattern, then back out to `accounts.dev` again — looping indefinitely.
   Example of the nesting after two hops:
   ```
   https://superb-cowbird-9296.accounts.dev/sign-in/tasks/choose-organization
     ?redirect_url=http%3A%2F%2Flocalhost%3A3000%2Fsign-in%2Ftasks%2Fchoose-organization
       %3Fsign_in_fallback_redirect_url%3Dhttp%3A%2F%2Flocalhost%3A3000%2F
   ```
5. The browser never reaches `http://localhost:3000/`. No JS console
   error is thrown — Clerk's hosted task UI simply keeps redirecting.

**Reproduced 4+ times**, independently, across:
- Selecting a pre-existing, never-activated org ("Nexo Audit Org") right
  after sign-up.
- Navigating directly to `/` mid-loop — still redirects back into the loop.
- Signing in (a different entry path than sign-up) and reaching the
  embedded task screen, then selecting the same org.
- Creating a brand-new org ("Nexo Fresh Org") instead of selecting an
  existing one.

**Confirmed via direct DB query** that neither "Nexo Audit Org" nor
"Nexo Fresh Org" was ever written to the `Organization` table — proving
`resolveAuth()` never runs, because the session never reaches an actual
app route.

**Root-cause investigation:**
- Ruled out: missing `DATABASE_URL`/migrations (already fixed, confirmed
  working via a prior successful Google-OAuth session — see below).
- Ruled out: our `middleware.ts` — `/sign-in(.*)` and `/sign-up(.*)` are
  fully public; `auth.protect()` is never invoked on them, so our
  middleware is not the source of the redirect.
- **Attempted fix:** added explicit `fallbackRedirectUrl="/"` and
  `signInUrl`/`signUpUrl` props to `<SignIn>`/`<SignUp>` in
  `app/sign-in/[[...sign-in]]/page.tsx` and
  `app/sign-up/[[...sign-up]]/page.tsx` (previously neither component had
  any redirect/routing props set, which was a real gap regardless). This
  **did not fix the loop** — after retrying end-to-end, the loop still
  occurs, and critically it occurs on Clerk's *hosted* `accounts.dev`
  domain, before the browser ever reaches our app or our React tree at
  all. That confirms this is not fixable from `<SignIn>`/`<SignUp>` props
  in our code; the loop originates in Clerk's own org-selection
  task-resolution logic (hosted-UI ↔ embedded-UI handoff), most likely
  tied to a Clerk Dashboard-side configuration (e.g. organization
  settings, allowed redirect origins, or the "Personal accounts" /
  "Require organization" setting). The props change is being kept because
  it's a correctness improvement regardless (explicit redirect targets
  instead of relying on unset defaults), but it does not close this bug.
- **Important asymmetry:** one account (`mrayandar123@gmail.com`, via
  Google OAuth, in an earlier session before this audit) *did* successfully
  create an Organization + Owner row — confirmed via direct query:
  ```
  Organization: cmuemqi9n0000f8wcq60yvwvw ("Muhammad Rayan's Organization")
  Owner:        cmuemqklh0001f8wcmyfqzfus (mrayandar123@gmail.com)
  ```
  This proves `resolveAuth()`, the Prisma schema, and the on-demand
  Organization/Owner sync all work correctly *when a session reaches the
  app*. The bug is specifically in the browser's ability to get past the
  Clerk org-selection task in **this current environment** — attempting to
  re-verify by signing in as that same Google account was not completed in
  this audit because it requires the real Google account password/2FA,
  which isn't available to the agent; this is flagged as the fastest next
  diagnostic step for a human to try (see "Next up").

### 3–14. All remaining flows — 🚫 NOT TESTABLE (blocked by #2)

Every flow from "Create a lead" through "Team settings" requires an
authenticated session with a resolved `orgId` to reach any `(app)` route.
Since no session in this audit could get past org-selection, these could
not be exercised in the browser and are **not** given a PASS — they are
explicitly unverified, regardless of how the underlying code reads. This
includes the Dashboard mock-data question (#13) and Team settings (#14),
both of which have real, wired implementations in code (see "Done" below)
but neither of which has been re-confirmed working end-to-end via the
browser since the redirect loop appeared.

## Done

### UI (complete, not to be modified without explicit request)

- **8 screens** in `src/screens/`: Dashboard, Leads, Contacts, Pipeline,
  RecordDetail (lead + contact detail with tabs), Tasks, Reports, Settings.
- **Shared component library** in `src/components/`: `ui/` (Button, Badge,
  Card, Avatar, Table, Field, Menu, Modal, Display), `layout/` (Sidebar,
  PageShell, CommandPalette, AppLayout), `common/` (ActivityStream,
  MetricTile, TaskRow, LeadFunnel).
- **Command palette** (Ctrl+K) searching across nav, leads, contacts, deals.
- **Drag-and-drop** kanban on the Pipeline board (native HTML5 drag events).

### Next.js migration (complete)

- Migrated from Vite + react-router-dom SPA to **Next.js 15 App Router**.
- `app/(app)/` route group contains thin wrappers importing from
  `src/screens/`. Root `app/layout.tsx` has `ClerkProvider` only.
- `src/lib/router-compat.tsx` bridges react-router-dom's API on top of
  `next/link` and `next/navigation`. Zero `react-router-dom` imports remain.
- Tailwind v4 via `@tailwindcss/postcss`.
- Production build passes, all 12 routes render successfully.

### Clerk authentication (complete)

- **`@clerk/nextjs`** installed and wired.
- `middleware.ts` — protects all routes except `/sign-in`, `/sign-up`,
  `/create-org`, and `/api/webhooks`. Unauthenticated users redirect to
  sign-in. `signInUrl`/`signUpUrl` are pinned so Clerk never falls back to
  the hosted Account Portal origin.
- Sign-in at `/sign-in`, sign-up at `/sign-up` using Clerk's prebuilt
  components, with explicit `routing="path"` + `path` + `fallbackRedirectUrl`
  + cross-links. The routing mode is load-bearing, not cosmetic — see
  "Fixed: Clerk org-selection redirect loop".
- `/create-org` page for users who haven't selected an organization yet.
- `<ClerkProvider>` wraps the entire app in `app/layout.tsx`.

### Organization model + sync (complete)

- **`Organization`** model in Prisma: `id` (cuid), `clerkOrgId` (unique),
  `name`, `plan` (PlanTier enum: free/starter/pro/enterprise, default free),
  `stripeCustomerId` (nullable), `createdAt`, `updatedAt`.
- **On-demand sync** in `lib/auth.ts` → `resolveAuth()`: if a Clerk org
  has no matching Organization row, it's created from Clerk's API on the
  spot. This covers first-time setup and the webhook race condition.
- **Webhook handler** at `app/api/webhooks/clerk/route.ts`: handles
  `organization.created`, `organization.updated`, `organization.deleted`,
  `organizationMembership.created`, `organizationMembership.updated`.
  Svix signature verification. This is the primary sync path in production.
- `orgId` on tenant tables conceptually references `Organization.id` (our
  internal cuid). No formal FK constraint added in this pass.

### Owner ↔ Clerk user sync (complete)

- **Owner** model kept (not renamed — see decisions log). Added `clerkUserId
  String?` with `@@unique([orgId, clerkUserId])` and `avatarUrl String?`.
- `upsertOwnerFromClerk()` in `lib/data/owners.ts` — creates or updates an
  Owner from Clerk user data.
- On-demand sync in `resolveAuth()`: if the Clerk user has no Owner row in
  the current org, one is created from Clerk's API.
- Webhook sync: `organizationMembership.created/updated` events upsert
  the Owner row.

### Organization switcher (complete)

- Clerk's `<OrganizationSwitcher>` component integrated into the Sidebar's
  workspace switcher area (`WorkspaceSwitcher` component).
- `hidePersonal` set so only organizations are shown (no personal accounts).
- After creating/selecting an org, user is sent to `/`.

### Team settings page (complete)

- Settings → Team tab now uses Clerk's `useOrganization()` hook to show real
  org members (name, email, role).
- **Invite by email**: opens a modal, calls `organization.inviteMember()`.
- **Change role**: inline dropdown per member (Admin / Member), calls
  `organization.updateMember()`.
- **Remove member**: calls `organization.removeMember()`.
- Real-time: all actions call `memberships.revalidate()` to refresh the list.

### UI cut-over to real data (complete)

- `app/(app)/layout.tsx` is a server component that calls `resolveAuth()`
  to get `orgId` + `owner`, then `loadCrmData(orgId, owner.id)` to fetch
  all data from PostgreSQL, maps it to frontend types via `lib/mappers.ts`,
  and passes it as `initialData` to `CrmProvider`.
- `CrmProvider` (`src/store/crm.tsx`) rewritten: accepts `initialData` prop
  instead of importing mock data. Same `useCrm()` interface — screen
  components didn't need to change at all.
- Mutations (moveDeal, setLeadStatus, convertLead, toggleTask, addTask,
  addNote, logActivity) do optimistic local state updates PLUS call server
  actions in `lib/actions/crm.ts`. Server actions call `requireAuth()` then
  the appropriate `lib/data/*` function and `revalidatePath('/', 'layout')`.
- `lib/mappers.ts` converts Prisma types → frontend types: DateTime → ISO
  string, compute `initials` from name, reshape `relatedTo`/`subject` from
  separate DB fields into frontend objects, map `_count.deals` → `openDeals`.
- `lib/data-loader.ts` fetches owners, leads, contacts, deals, tasks,
  activities in parallel via `Promise.all`.
- `lib/data/leads.ts` updated to include `convertedDeal: { select: { id:
  true } }` so the mapper can produce `convertedDealId`.

### Prisma + PostgreSQL schema (complete)

- 7 models: **Organization** (new), Owner, Lead, Contact, Deal, Task,
  Activity.
- Enums match frontend string unions. New enum: `PlanTier`.
- Multi-tenancy enforced: every tenant-scoped model has `orgId String` with
  `@@index([orgId])` and composite indexes.
- `Owner.clerkUserId` with `@@unique([orgId, clerkUserId])`.
- `Organization.stripeCustomerId` nullable (ready for billing stage).

### Server-side data-access layer (complete)

- `lib/prisma.ts` — HMR-safe PrismaClient singleton.
- `lib/data/{organizations,owners,leads,contacts,deals,tasks,activities}.ts`
  — 25+ exported functions. Every function takes `orgId` as required first
  parameter, every by-id read uses `findFirst({ where: { id, orgId } })`.
- `lib/actions/crm.ts` — 7 server actions wrapping data functions with
  `requireAuth()` + `revalidatePath`.

### Config / env

- `.env.example` with placeholders for DATABASE_URL, Clerk keys,
  `CLERK_WEBHOOK_SECRET`, Stripe keys, app URL.
- `.gitignore` covering `node_modules`, `.next`, `.env*`, `*.tsbuildinfo`.
- `.cursor/rules/nexocrm.mdc` (alwaysApply) documenting auth flow,
  multi-tenancy, project structure, domain model, UI-hands-off policy.

## Verified correctness checks (Sep 24 2026)

### ✅ Race condition fixed — Organization creation is now atomic

**What was wrong:** Both `resolveAuth()` and `handleOrgCreated()` used a
check-then-create pattern (`getOrgByClerkId` → if null → `createOrg`).
`createOrg` called `prisma.organization.create`, a plain INSERT. If both
ran concurrently — the common case when a user hits the app for the first
time before the webhook arrives — one INSERT wins and the other throws
Prisma's `P2002` (unique constraint on `clerkOrgId`):

- In `handleOrgCreated`: P2002 was caught by the outer try/catch → webhook
  returned 500 → Svix retried. No duplicate row, but needless retries and
  logged errors.
- In `resolveAuth`: **no catch** around `createOrg` → P2002 propagated
  unhandled → the user request threw a 500. This was a real user-visible bug.

**What was fixed:** `createOrg` was replaced with `upsertOrg` in both
code paths. `upsertOrg` uses `prisma.organization.upsert({ where: { clerkOrgId },
create: {...}, update: {} })`. The `update: {}` makes it a no-op if the row
already exists. Prisma's upsert maps to an atomic `INSERT ... ON CONFLICT DO
UPDATE` at the PostgreSQL level, so no two concurrent callers can both succeed
at INSERT — one creates the row, the other's upsert finds it and returns the
existing row. P2002 is no longer possible.

`upsertOrg` is exported from `lib/data/organizations.ts`. `createOrg` is
kept only for callers (e.g. tests) that explicitly know the row is new.
`requireAuth()` (used in server actions) still uses `getOrgByClerkId` —
it deliberately does not create, since server actions run after the layout
has already run `resolveAuth()`.

The Owner sync path (`upsertOwnerFromClerk`) was already using
`prisma.owner.upsert` and was already atomic. No change needed there.

### Mock data audit — file-by-file

| File | Data source | Status |
|------|-------------|--------|
| `src/store/crm.tsx` | `initialData` prop from server layout → `lib/data-loader.ts` → Prisma | ✅ Real data path — no mock imports |
| `src/components/layout/Sidebar.tsx` | `useCrm()` | ✅ Real (via CrmProvider) |
| `src/components/layout/CommandPalette.tsx` | `useCrm()` | ✅ Real (via CrmProvider) |
| `src/components/layout/AppLayout.tsx` | No data | ✅ n/a |
| `src/components/common/ActivityStream.tsx` | `useCrm()` for `ownerById` only | ✅ Real (via CrmProvider) |
| `src/components/common/TaskRow.tsx` | `useCrm()` for `toggleTask`, `ownerById` | ✅ Real (via CrmProvider) |
| `src/components/common/MetricTile.tsx` | Props only | ✅ n/a |
| `src/components/common/LeadFunnel.tsx` | Props only | ✅ n/a |
| `src/screens/Leads.tsx` | `useCrm()` only | ✅ Real (via CrmProvider) |
| `src/screens/Contacts.tsx` | `useCrm()` only | ✅ Real (via CrmProvider) |
| `src/screens/Pipeline.tsx` | `useCrm()` only | ✅ Real (via CrmProvider) |
| `src/screens/Tasks.tsx` | `useCrm()` only | ✅ Real (via CrmProvider) |
| `src/screens/Settings.tsx` | `useCrm()` for currentUser; Clerk hooks for team | ✅ Real (via CrmProvider + Clerk) |
| `src/screens/Dashboard.tsx` | `useCrm()` for all metrics **+** `monthlyPerformance` imported directly from `src/data/mock.ts` | ⚠️ Partially mock — the "Won vs. target" bar chart uses a hardcoded 6-month array, not DB data |
| `src/screens/Reports.tsx` | `useCrm()` for deals/leads/owners **+** `monthlyPerformance` imported directly from `src/data/mock.ts` | ⚠️ Partially mock — the "Revenue vs. target" bar chart uses the same hardcoded array |
| `src/screens/RecordDetail.tsx` | `useCrm()` for activities, tasks, deals, contacts, leads, owners | ✅ Real — `generatedTimeline` blend removed; activity tab shows only DB activities, with an honest empty state for new records |

**Summary:** 14 of 16 data-consuming files are fully wired to real Prisma
data. 2 files still pull from a hardcoded mock array for one sub-feature:
- `monthlyPerformance` (Dashboard + Reports) — historical bar chart data;
  no DB equivalent yet; **must be replaced before onboarding real customers**

No other files import from `src/data/timeline.ts`. `src/data/mock.ts` is
still imported by Dashboard and Reports only for the chart array above.

## Known gaps / explicitly deferred

### Active org is not restored on sign-in

Signing in produces an `active` session with `activeOrg: null`, so
`resolveAuth()` sends the user to `/create-org` to pick their org on every
fresh sign-in, even when they belong to exactly one. Functional but an
extra click. Worth revisiting — either persist/restore the last active org,
or auto-activate when the user has exactly one membership.

### `force_organization_selection` must stay off on the Clerk instance

The org-selection redirect loop fix depends on
`force_organization_selection: false` for the Clerk instance (see the fix
section above). If someone re-enables it in the Clerk Dashboard, or a new
Clerk instance is provisioned with it on, the loop returns. Re-apply with
`node scripts/clerk-org-settings.js --disable-force-selection`.

### Initial Prisma migration is applied

`prisma/migrations/20260923211426_init` is in the repo and has been
applied to the Neon Postgres instance via `prisma migrate dev`.
`DATABASE_URL` is set locally (not committed). Tables exist; they were
empty at last query because the Clerk org-selection handshake never
reached `resolveAuth()` in the embedded browser.

### Clerk keys are configured locally

`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` are set in
`.env` (not committed). Sign-in/sign-up render. `CLERK_WEBHOOK_SECRET`
is still missing, so the webhook handler will reject events.

### Webhook endpoint not registered

The webhook handler exists at `/api/webhooks/clerk` but it's not registered
in Clerk's dashboard yet. Until it is, organization and member sync relies
entirely on the on-demand fallback in `resolveAuth()`.

### Frontend types diverge from Prisma types

`src/data/types.ts` (used by the UI) was written before Prisma was added.
It's close to the schema but not identical. `lib/mappers.ts` bridges the
gap for now. `src/data/mock.ts` is still imported by Dashboard and Reports
for the `monthlyPerformance` chart array (see the pre-onboarding blocker
above). `src/data/timeline.ts` is no longer imported anywhere.

### orgId is not a formal FK

`orgId` on tenant tables is still a bare `String`, not a `@relation` FK to
`Organization.id`. This is by design for this pass (avoids a cross-table
migration), but should be formalized once the system is live and stable.

### Billing not wired (Stripe)

`stripe` SDK is **not installed**. `.env.example` has placeholder keys but
no webhook handler, no checkout flow, no subscription model.
`Organization.stripeCustomerId` and `Organization.plan` exist as fields
ready for the billing stage.

### No API routes (REST/tRPC)

All data flows through server actions (`lib/actions/crm.ts`) called from
CrmProvider. There are no REST API endpoints for external integrations.

### No tests

No test framework configured. No unit, integration, or E2E tests.

### `convertLead` UI only creates a deal

The API and store now support contact-only conversion (omit `input.deal`),
but the UI's "Convert to deal" modal in `RecordDetail.tsx` always passes a
`deal` block. No "Convert to contact only" UI path exists.

### `monthlyPerformance` mock in Dashboard + Reports — must fix before real customers

`Dashboard` and `Reports` both import `monthlyPerformance` from
`src/data/mock.ts` for their respective bar charts ("Won vs. target" and
"Revenue vs. target"). This is hardcoded data — every tenant sees the same
fabricated six-month trend regardless of their real deal history.

**This must be replaced with real DB queries before onboarding any paying
customer.** The fix requires a server-side aggregation query grouping
closed-won deals by month and returning revenue totals, then surfacing that
via `loadCrmData` (or a dedicated endpoint). Until then the charts show
fictional numbers to real users.

### Settings profile/workspace forms don't persist

The Profile and Workspace sections in Settings render with default values
but Save doesn't do anything yet.

### Saved views in sidebar are hardcoded

The sidebar's "Saved views" (Untouched leads, Closing in 30 days,
Champions) have hardcoded counts and are not real saved queries.

## Next up

- **Run audit items #3–14 now that auth is unblocked** (lead/contact/
  company/deal CRUD, pipeline drag persistence, tasks, activity timeline,
  global search, dashboard metrics, team settings) for real verdicts.
- Auto-activate the org on sign-in when the user has exactly one
  membership, to remove the extra `/create-org` click (see Known gaps).
- Seed initial CRM data for a new org (optional).
- Register the Clerk webhook endpoint and test org/member sync.
- Wire Stripe billing (install SDK, create checkout flow, webhook handler).
- Replace `monthlyPerformance` mock in Dashboard + Reports with real
  closed-won-by-month aggregation queries (pre-onboarding blocker).
- Add formal FK constraints from `*.orgId` → `Organization.id`.
- Add a "Convert to contact only" UI path in RecordDetail.

## Decisions log

| When | Decision | Why |
|------|----------|-----|
| Migration | Renamed `src/pages/` → `src/screens/` | Next.js auto-detects `src/pages/` as the legacy Pages Router. |
| Migration | Created `src/lib/router-compat.tsx` shim | All screens used react-router-dom APIs; a compat layer let us change one import per file instead of rewriting every usage. |
| Migration | `app/` pages are thin wrappers, not the actual screens | The "don't touch the UI" constraint means screen logic stays in `src/screens/`. |
| Schema | `orgId` is `Organization.id` (cuid), not Clerk's org ID | Decouples from Clerk's specific ID format. If Clerk changes something, only the Organization table needs updating. |
| Schema | No formal FK from `*.orgId` → `Organization.id` in this pass | Adding FKs across 6 tables in the same migration as the Organization model is risky and constrains insert order. The application layer (`resolveAuth`) guarantees the Organization exists before any query runs. Can formalize later. |
| Schema | `Owner.email` uses `@@unique([orgId, email])` not `@unique` | Global email uniqueness would prevent two tenants from independently having users with the same email. |
| Schema | By-id lookups use `findFirst({ where: { id, orgId } })` not `findUnique({ where: { id } })` | Prisma's `findUnique` requires the `where` to match a declared unique key. `findFirst` with both fields pushes the tenant filter into the query. |
| Auth | Kept "Owner" name instead of renaming to "Member" | "Owner" is the CRM domain concept — leads have owners, deals have owners, tasks have assignees (owners). Renaming to "Member" would lose that semantic meaning. Added `clerkUserId` to link Owner to Clerk identity without conflating the concepts. |
| Auth | On-demand sync as primary, webhooks as supplement | Webhooks have delivery latency — a user can hit the app before the `organization.created` webhook arrives. On-demand sync in `resolveAuth()` creates the Organization and Owner rows from Clerk's API on first access. Webhooks handle ongoing updates (name changes, new members). Both paths use upsert to avoid conflicts. |
| Auth | Route group `(app)` for authenticated pages | Separates authenticated pages (which need `resolveAuth()` + data loading + `CrmProvider` + `AppLayout`) from public pages (`sign-in`, `sign-up`, `create-org`) that just need `ClerkProvider`. Avoids conditional rendering in the root layout. |
| UI cutover | Rewrote CrmProvider rather than each screen | CrmProvider's `useCrm()` interface stayed identical. Screens still call `useCrm()` for data — the only change is that data now comes from server-loaded Prisma results instead of hardcoded mock arrays. This meant zero changes to screen JSX/logic. |
| UI cutover | Optimistic updates + server actions | Mutations update local state immediately (for instant UI feedback) and fire a server action in a `startTransition`. After the server action completes, `router.refresh()` re-fetches the layout's data to sync from the database. |
| Auth | Disabled Clerk's `force_organization_selection` instead of adopting its task UI | The app already gates every `(app)` route on an active org in `resolveAuth()`, server-side. Clerk's `choose-organization` task was a redundant second gate, and its hosted UI never issued the request that resolves it. Removing the duplicate gate leaves the working, server-enforced one in charge. |
| Auth | Clerk URL config in code (`clerkMiddleware`/`ClerkProvider`) rather than `NEXT_PUBLIC_CLERK_*_URL` env vars | `.env` is untracked and per-developer; an unset `signInUrl` silently falls back to the hosted Account Portal and reintroduces the redirect loop. Pinning it in code makes the setting reviewable and impossible to forget. |
| Data layer | `convertLeadToDeal` input uses `{ ownerId, deal?: {...} }` | Contact always created; Deal only when `input.deal` is provided. |
| Data layer | Write helpers use find-then-update in a transaction | Ensures the tenant match is checked atomically before the mutation runs. |
