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

Audit items #3–14 were **partially re-run** in the browser on Sep 26 2026
(see "Functional audit" below). Headline: every "create" button (lead,
contact, deal) is unwired, contact-only convert isn't exposed in the UI,
and **server-action persistence is unreliable** — two dev-server sessions
degraded into a flood of `failed to forward action response` /
`HeadersTimeoutError` errors, after which no mutation reached the DB.
Items 9–12 and 14 remain untested.

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

## Fixed: phantom deals from optimistic temp ids (Sep 27 2026)

**Symptom:** dragging/moving a deal on the Pipeline board threw
`Deal d1005 not found in org …` (`moveDealAction`), and the activity logged
for the move threw `No 'Deal' record found for nested connect`
(`logActivityAction`).

**Not a mock-data leak.** `src/data/mock.ts` is imported only for the
`monthlyPerformance` chart array (Dashboard, Reports). Pipeline and Dashboard
read deals exclusively from `useCrm()` → `initialData` → `loadCrmData()`
(Prisma). The real database ids are cuids (`cmui…`), never `d1005`.

**Actual root cause:** `d1005` is `nextId('d')` — the store's client-side
counter (`let sequence = 1000`). `convertLead` gave its optimistic Deal/Contact
those counter ids, fired `convertLeadAction`, and **discarded the real ids the
server created**. So after any convert-with-deal, the Pipeline showed a card
whose id existed only in browser memory (the real deal was in Postgres under a
different id). Any action on it — move, log activity, and later edit — sent the
fake id to the server and failed. The counter also restarts at 1000 on every
page load, so ids weren't even unique across sessions. `addTask` had the same
flaw (toggling a just-added task would have failed), and `addLead` (built
earlier the same day) papered over it with a post-hoc id swap that left a
window where the row still had its fake id.

**Reproduced first** (real browser, then Neon): convert lead → Pipeline → move
the new deal → `[500, 500]`, server log `Deal d1002 not found in org
cmui9z4s…` + the Prisma nested-connect error, while a direct query showed the
real deal "Audit Corp — New opportunity" existed under a cuid.

**Fix:** every optimistic create that the UI can act on before it round-trips
now uses a client-generated **UUID that the server stores as the row id**, so
the optimistic row *is* the real row — no swap, no window. Next runs server
actions one at a time in order, so a follow-up action on that id is processed
after the create.
- `src/store/crm.tsx`: `newEntityId()` (`crypto.randomUUID()`) for lead,
  contact, deal, task ids. `nextId()` remains only for activities (display-only,
  never referenced by id). `convertLead` and `addTask` now roll back their
  optimistic rows if the server rejects the create (previously silent/uncaught).
- `lib/actions/crm.ts`: `createLeadAction`, `convertLeadAction`,
  `addTaskAction` take the id(s); `assertClientId()` accepts only a UUID.
- `lib/data/leads.ts`: `convertLeadToDeal` accepts `contactId`/`dealId`.
- Also fixed while in there: `convertLeadAction` used the client-supplied
  `ownerId` without checking it belongs to the org (cross-tenant owner attach) —
  now verified via `getOwnerById(orgId, …)`, like `createLeadAction`.
- Also fixed: the "converted X into Y" activity was a separate action fired
  *before* the convert, so a failed convert left an orphan activity in Postgres.
  It's now written inside the convert transaction (`convertLeadToDeal`).

**Verified (browser + direct Neon queries):**
1. Convert lead `cmuiapnrd…` with a deal → `POST` 200. DB: new contact and deal
   with UUID ids (`04903a5a-…`, `dd048205-…`), deal linked to the contact and
   the lead, correct `orgId`, "converted…" activity present.
2. In-app nav to Pipeline, move that deal → `[200, 200]`, no server errors.
   DB: deal `stage proposal`, `probability 45`, and a `stage` activity linked to
   that deal id.
3. Add a task and tick its checkbox immediately (before the add responded) →
   `[200, 200]`; DB row has the UUID id, `done: true`.
4. New Lead regression: success path (row + activities correct, list 5 → 6, no
   reload, detail page opens at the UUID) and the bad-owner rollback (modal
   stays open with error, list unchanged, 0 DB rows) both still pass.
- This also closes the audit's open question on with-deal convert persistence
  (#5): it does write the Contact, Deal and activity.

**Still not covered (known):** `RecordDetail`/`ConvertModal` keep a local
`converted` flag that isn't reset if a convert fails (it's UI-file state; the
deal/contact/lead state itself does roll back). The other mutations' rollback is
covered in the next section. Existing rows created before this change keep their cuid ids —
nothing to migrate.

## Fixed: optimistic mutations now roll back on failure (Sep 27 2026)

Before, only `addLead`, `convertLead` and `addTask` reverted when their server
action failed. `moveDeal`, `setLeadStatus`, `toggleTask` and the activity logger
kept showing an unsaved "success" (and the error surfaced as an unhandled
rejection). All four now revert, via one shared helper in `src/store/crm.tsx`:

- `persist(run, rollback, activity?)` runs the server action inside the
  transition; if it throws, `rollback()` reverts exactly the fields that
  mutation changed (deal `stage/probability/updatedAt`, lead
  `status/lastTouchedAt`, task `done`, contact/lead touch times) and the
  optimistic activity is removed.
- **The activity is now persisted only after the mutation succeeded.**
  Previously `moveDeal`/`setLeadStatus`/`toggleTask` fired the activity log
  *before* the mutation, so a failed change still left a "moved X to Y" entry in
  Postgres. Now: mutation → (on success) log activity; a failed mutation logs
  nothing. If only the activity log fails, just the activity is dropped.
- `pushActivity` (the standalone activity logger used by RecordDetail) uses the
  same path: optimistic entry, removed if the server rejects it.
- **Bug found and fixed on the way:** `addNote` called `pushActivity` *and*
  `addNoteAction` (which logs the same activity), so **every note was saved to
  the database twice**. It now logs once (verified: exactly 1 row).

**Verification — simulated real server failures, checked in the UI and in
Neon.** A Playwright request interceptor rewrote the record id in each action's
request body to a bogus id, so the real server threw its genuine "not found" →
HTTP 500 (no code edits, nothing reached the DB). For each of the four:
1. The optimistic change appeared in the UI first (so the revert isn't a no-op):
   card moved to Negotiation / lead badge → Contacted / checkbox ticked / note
   shown in the timeline.
2. Server returned 500.
3. UI reverted: card back in Discovery / badge New / checkbox unchecked / note
   removed.
4. Direct DB query: deal still `discovery`, lead still `new`, task `done=false`,
   0 activity rows for the note — and the total activity count unchanged for the
   first three (no orphan log entry).
Success controls (same actions, unmodified): deal → `negotiation` with exactly 1
`stage` activity; lead → `contacted` with 1 activity; task `done=true` with 1
`completed…` activity; note saved exactly once. **21/21 checks passed.** Test
rows were reverted afterwards (Alpha back to discovery/30%, lead back to `new`,
test task/activities deleted).

**Still not covered:** rollback for a failure *of the activity log alone* only
drops the activity (the mutation stays, correctly). Drag-and-drop uses the same
`moveDeal` path but the gesture itself wasn't driven (the card menu was).
`RecordDetail`'s local `converted` flag still isn't reset after a failed convert
(UI-file state). (A failure toast now tells the user — see the next section.)

## Added: failure toast when an optimistic change is rolled back (Sep 27 2026)

When a server action fails and the store reverts the optimistic change, the
user now sees a toast (previously the revert was silent).

- **Component:** `src/components/ui/Toast.tsx` (`ToastViewport`). There was no
  existing toast/notification pattern in the app, so it's minimal and built only
  from existing tokens: `bg-surface`, `border-line`, `shadow-pop`,
  `rounded-panel`, the `text-negative` alert icon, the existing
  `animate-slide-in`, and `IconButton` for dismiss. Fixed bottom-right (clear of
  the sidebar), `role="alert"` inside an `aria-live` region.
- **Wiring:** `CrmProvider` owns the toast state and renders `<ToastViewport>`,
  so **no screen files were touched**. Toasts auto-dismiss after 6 s, can be
  dismissed manually, identical messages collapse into one, max 3 stacked.
- **Fires from the shared `persist()` helper**, so it covers moveDeal,
  setLeadStatus, toggleTask, addNote and pushActivity ("Couldn't save change,
  please try again."). `convertLead` and `addTask` were moved onto `persist()`
  too (they had hand-rolled try/catch), with their own messages ("Couldn't
  convert the lead, …" / "Couldn't add the task, …"). If only the activity-log
  write fails after the change itself saved, the message says so ("Change saved,
  but couldn't add it to the activity log.") instead of implying it was
  reverted. `persist()` is now the only place a server mutation is awaited.
- **`addLead` is intentionally not toasted:** its modal already shows an inline
  error and stays open; a toast would double up.

**Verification (forced real 500s — same interceptor technique as above: the
record id in each action request rewritten to a bogus one, so the real server
throws; for `addTask` the UUID was replaced with a non-UUID so
`assertClientId` rejects it):** for all six paths the optimistic change showed
first, then the toast appeared with the right text alongside the visual revert
(card back in Discovery, badge back to New, checkbox unchecked, note gone,
added task row gone, lead status back), and direct DB queries showed no change
and no orphan activity. Toast dismiss button and 6 s auto-dismiss verified.
Success controls (convert → +1 contact/+1 deal/+1 activity; add task persisted)
showed no toast. 26/29 checks on the first run, then 7/7 on a rerun of just the convert paths — the
first-run convert failures were test-design issues (Next queues the Pipeline
navigation behind the in-flight action, so the page arrived after the 6 s toast
had expired; and Next's own route announcer is also a `role="alert"`, which my
"no toast" assertion counted), not product bugs. Test rows were reverted.

**Known limits:** the toast has no retry action (just the message). If a user
navigates away and back, in-flight failures that resolve later still toast (the
provider persists across routes, which is intended). `RecordDetail`'s local
`converted` flag still isn't reset after a failed convert.

## Functional audit (Sep 26 2026)

Full click-through audit of the 14 core flows, tested live in a real
browser against the running dev server and Neon database (not a code
read-through). Verdicts are PASS, FAIL (exact error included), NOT
TESTABLE (blocked by an earlier failure), or NOT YET BUILT.

> **Items 1 and 2 were subsequently fixed** — see "Fixed: Clerk
> org-selection redirect loop" above. Items 3–8 and 13 were re-run in the
> browser on Sep 26 2026 (second pass, below). Items 9–12 and 14 were not
> reached — the audit was stopped after the dev server repeatedly degraded.

| # | Flow | Verdict |
|---|------|---------|
| 1 | Sign up / sign in | ✅ PASS (was PARTIAL — fixed) |
| 2 | Create an organization | ✅ PASS (was FAIL — fixed) |
| 3 | Create a lead | ✅ PASS (built + DB-verified Sep 26 2026, after the audit — see "New lead creation" under Done) |
| 4 | Edit a lead | ⚠️ PASS (status only) — persisted, but bounced user to `/create-org` |
| 5 | Convert a lead (contact-only) | 🚧 NOT YET BUILT (UI) — with-deal convert unverified in DB |
| 6 | Create a contact directly | 🚧 NOT YET BUILT |
| 7 | Create a company | 🚧 NOT YET BUILT (no Company entity exists) |
| 8 | Create a deal | ✅ PASS (built + DB-verified Sep 27 2026 — see "New deal creation" under Done) |
| 9 | Drag a deal across pipeline stages + persist | ⬜ NOT TESTED |
| 10 | Create a task, mark it complete | ⬜ NOT TESTED |
| 11 | Log an activity, confirm in timeline | ⬜ NOT TESTED |
| 12 | Global search | ⬜ NOT TESTED |
| 13 | Dashboard — real vs. mock metrics | ✅ PASS (excluding known-mock `monthlyPerformance`) |
| 14 | Team settings — invite user, change role | ⬜ NOT TESTED |

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

### 3–14. Second pass (Sep 26 2026, after the redirect-loop fix)

Tested as `nexoverify1@mailinator.com` in "Nexo Verified Org". Test data
seeded via `scripts/seed-audit.js` (4× "Alice Audit" lead — duplicates from
script retries — 3× "Bob Audit" contact, "Audit Deal Alpha" $25K discovery,
"Audit Deal Beta" $8K proposal). DB state checked with
`scripts/check-lead.js` / `scripts/check-convert.js`.

**#3 Create a lead — 🚧 NOT YET BUILT (at audit time; since built — see
"New lead creation" under Done).** "New lead" button on `/leads` rendered
but had no `onClick`. Git history shows it never had one (all 9 commits,
including the first Next.js migration commit) — a placeholder, not a
regression.

**#4 Edit a lead — ⚠️ PASS (status only).** "Change status" → Qualified on
lead `cmuiaraii0001f8dk8yznejnp`: `POST /leads/<id> 200` (13.9s — cold
Neon), DB confirmed `status: "qualified"`, and after re-selecting the org
the Leads funnel showed "Qualified 1" and the dashboard showed the
activity. Caveats: (a) only status is editable — no UI to edit name,
email, company, etc.; (b) immediately after the save, the
`router.refresh()` in `CrmProvider` re-rendered the `(app)` layout without
an active org, and `resolveAuth()` redirected to `/create-org` (see
"Every mutation bounces the user to `/create-org`" in Known gaps).

**#5 Convert a lead (contact-only) — 🚧 NOT YET BUILT (UI).**
`ConvertModal` in `src/screens/RecordDetail.tsx` always submits a `deal`
payload; there's no contact-only option, although `convertLeadAction`
accepts `deal: undefined`. The with-deal path was clicked: UI showed
"Converted", "A deal and a contact record were created", Deals 2→3 — but
**no Contact or Deal row was written** (later shown to be an artifact of that
session — with-deal convert does persist; see "Fixed: phantom deals" above). A Fast Refresh full reload
(triggered by an agent code edit mid-test) happened at the same time and
the `convertLeadAction` POST never appeared in the server log, so with-deal
convert persistence is **unverified**, not proven broken.

**#6 Create a contact — 🚧 NOT YET BUILT.** "New contact" button has no
`onClick`; no action or store method.

**#7 Create a company — 🚧 NOT YET BUILT.** There is no Company model;
company is a free-text string on Lead/Contact/Deal.

**#8 Create a deal — 🚧 NOT YET BUILT.** "New deal" buttons (Pipeline,
Dashboard) have no `onClick`; no `createDealAction`. Deals can only be
created via lead conversion.

**#9–12, #14 — ⬜ NOT TESTED.** Stopped before these were reached. Code
paths exist for #9 (`moveDealAction`), #10 (`addTaskAction`,
`toggleTaskAction`, working form on `/tasks`), #11 (`logActivityAction`,
`addNoteAction`), #14 (Clerk `useOrganization()` in Settings), but none
were exercised in the browser this pass.

**#13 Dashboard — ✅ PASS.** After seeding, dashboard showed
"$33,000 across 2 open deals", Discovery 1 / $25K, Proposal 1 / $8K,
"Closing in 30 days: $33K committed" with both Audit Corp deals, "4 leads
never contacted" (→ 3 after #4), and the recent-activity feed from the DB.
All match the database. (`monthlyPerformance` chart is known-mock — not
re-reported.)

### Server-action reliability — ❌ FAIL (blocks trustworthy verdicts)

In **two separate dev-server sessions**, server actions degraded until
none reached the DB:

- Session 1 (~56 min uptime): four status changes on lead
  `cmuiaraii0001f8dk8yznejnp` showed optimistically in the UI; DB stayed
  `status: "new"`. A temporary `console.log` at the top of
  `setLeadStatusAction` **never printed** — the action body was never
  entered. The server log contained ~20,000 lines of:
  ```
  failed to forward action response [TypeError: fetch failed] {
    [cause]: [Error [HeadersTimeoutError]: Headers Timeout Error] {
      code: 'UND_ERR_HEADERS_TIMEOUT'
    }
  }
  ```
  interleaved with `POST /tasks 404 in ~318000–491000ms` and one
  `POST /leads/cmuiaraii0001f8dk8yznejnp 404 in 324333ms`.
- Session 2 (fresh restart): actions initially worked (#4 above:
  `POST 200`, DB updated). After ~15 min it hit the same
  `HeadersTimeoutError` flood (~2,500 lines) and the process exited.
  Also logged: `TypeError: __webpack_modules__[moduleId] is not a function`
  on first render, and a `GET /leads 500` with
  `OrganizationSwitcher can only be used within the <ClerkProvider />`
  during an HMR cycle.

**Root cause: not yet identified (investigation in progress, Sep 26 2026 —
not concluded).** What was established so far:
- `lib/prisma.ts` is the correct HMR-safe singleton; the only other
  `new PrismaClient` calls are the one-off `scripts/*.js`. Prisma pool
  exhaustion would surface as Prisma errors (`P2024`), not as the logged
  `HeadersTimeoutError` — so it's unlikely to be the cause.
- `failed to forward action response` comes from Next's
  `createForwardedActionResponse` (`next/dist/server/app-render/action-handler.js`):
  when the POSTed page isn't in the action's `workers` list in the dev
  server-reference manifest, Next `fetch`es the request to another page on
  itself. That manifest is built incrementally in dev. undici's default
  headers timeout is 300 s, which matches the logged `POST … 404 in
  318000–491000ms`. So the failing hop is Next's self-forward, not the DB.
- Every action currently triggers a full re-render of the `(app)` layout
  (`revalidatePath('/', 'layout')` → `resolveAuth()` → 2 Clerk API calls +
  ~8 Neon queries) — single-insert actions took 3–7 s locally, and the
  response body streamed ~8 s after headers.
- **Not reproduced.** Clean-server runs (add task ×3, lead create ×2, lead
  status, with ~6 Fast Refresh full reloads triggered mid-run by code edits)
  produced 0 forward/timeout errors, and every mutation that got a response
  matched the DB. The idle-then-mutate (>60 s) and server-module-edit-then-
  mutate experiments were planned but not run.

Hypotheses still to check: stale action IDs
after HMR (404 on action POST), Next's action forwarding between
workers/routes timing out, or slow cold-start Neon queries in
`requireAuth()` holding requests open. Because the UI is optimistic,
**a mutation "looking" successful proves nothing** — every future audit
verdict must be confirmed against the DB.

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

### New lead creation (complete, verified against the DB — Sep 26 2026)

- **UI:** the "New lead" button in `src/screens/Leads.tsx` opens a
  `NewLeadModal` (built from the existing `Modal`, `Input`, `Select`,
  `Textarea`, `Label` components and the same local `Field` wrapper pattern
  as `ConvertModal` — no new visual pattern). Fields: name, company, email,
  phone, source, status (default New), owner (default current user), notes.
  Name and company are required; email is format-checked when present.
  The button is disabled until valid; on failure the modal stays open with an
  inline error.
- **Server action:** `createLeadAction` in `lib/actions/crm.ts` — `requireAuth()`
  → validates/trims all input server-side (required fields, lengths, email
  format, `source`/`status` against the enums) → verifies the client-supplied
  `ownerId` belongs to the caller's org via `getOwnerById(orgId, …)` (otherwise
  a crafted request could attach a lead to another tenant's owner) →
  `createLead` in `lib/data/leads.ts` → `revalidatePath`. The lead and its
  activities are written in one nested Prisma create, so it's atomic.
- **Store:** `addLead` on `CrmState` (`src/store/crm.tsx`). Optimistic insert
  so the lead appears in the list immediately with no reload. The lead's id is
  a client-generated UUID that the server stores as the row id, so it's
  openable/editable straight away (this originally used a post-hoc temp-id
  swap; replaced Sep 27 — see "Fixed: phantom deals from optimistic temp ids").
  If the save fails, the optimistic lead and its activities are rolled back and
  the promise rejects so the modal can show the error.
- **Notes:** `Lead` has no notes column, so notes are stored as a `note`
  Activity on the lead (same shape as `addNote`), alongside a `created`
  activity. No schema change.
- **Not stored:** `title`, `location` are saved as empty strings, `score` and
  `estValue` as 0 (the form doesn't collect them; schema requires the strings).

**Verification (browser + direct Neon queries, not UI-only):**
1. Signed in as `nexoverify1@mailinator.com` (Clerk sign-in ticket), opened
   `/leads` (4 rows), created "Zed Tester 592320" / "Zed Corp 592320",
   `zed592320@example.com`, source Referral, status Contacted, with notes.
2. `POST /leads` → 200 in ~5.2 s. Rows 4 → 5 with no page reload (a
   `window` marker set before the click survived); clicking the new row
   navigated to `/leads/cmuiqvl9w0019f8rsfibphhr1` (the real DB id) and the
   detail page rendered.
3. Direct query: exactly **1** row — `orgId cmui9z4s60005f8g8w9tchde5`
   ("Nexo Verified Org"), all typed fields match, `status contacted`,
   `source Referral`, `ownerId` = the current user's Owner in the same org.
   Two Activity rows with the same `orgId`, `subjectType lead`, linked to the
   lead: `created` ("created lead Zed Tester 592320") and `note` (body
   `note-body-592320`).
4. Failure path: injected an owner id not in the org → server threw
   `Owner not found` (500), modal stayed open with the inline error, list
   rolled back (5 → 5), and a direct query found **0** rows for that email.
- Not tested: creating from a non-default owner that *is* valid, and the
  client-side email-format error message (logic covered by the server check).
- Test data left in "Nexo Verified Org": lead "Zed Tester 592320" plus tasks
  "Probe task r1 94801" and "E0 baseline 29824" from the reliability probing.

### New deal creation (complete, verified against the DB — Sep 27 2026)

- **UI:** `src/components/common/NewDealModal.tsx` (one shared modal, built from
  the existing `Modal`/`Input`/`Select`/`Label`, same layout as `ConvertModal`),
  opened by all three "New deal" buttons: `Pipeline.tsx`, `Dashboard.tsx`,
  `RecordDetail.tsx` (contact page — prefills that contact and its company). The
  Pipeline column "+" buttons are still unwired. Fields: name, value, stage
  (default Discovery — the first pipeline stage; Discovery→Contract offered),
  expected close date (default +30 days), linked contact (optional), owner
  (default current user).
- **Fields the schema requires that weren't in the spec:** `Deal.company` is
  required, so the modal has a Company field that autofills from the linked
  contact (editable; required if no contact). `source` is inherited from the
  linked contact's originating lead when there is one, else `Inbound` (not
  user-visible — worth a UI field later). `priority` = `medium`; `probability`
  comes from the stage (same table `moveDeal` uses).
- **Server:** `createDealAction` in `lib/actions/crm.ts` — `requireAuth()` →
  `assertClientId` (UUID) → validates name/value (positive int ≤ 1e9)/stage/
  source/priority/close date → **verifies `ownerId` via `getOwnerById(orgId, …)`
  and `contactId` via `getContactById(orgId, …)`** (both `{ id, orgId }`-scoped,
  so another tenant's ids read as "not found") → `createDeal` with the deal and
  its `created` activity in one nested create (atomic) → `revalidatePath`.
- **Store:** `addDeal` in `src/store/crm.tsx` — client UUID as the row id,
  optimistic deal + activity + the linked contact's `openDeals` +1, persisted
  through `persist()`; on failure it removes the deal/activity, restores
  `openDeals`, and shows the toast ("Couldn't create the deal, please try
  again."). The modal closes immediately (unlike New lead, which awaits and shows
  an inline error, because `persist()` is fire-and-forget).

**Verification (browser + direct Neon queries) — 23/23 checks:**
1. Pipeline, linked contact "Bob Audit": Create disabled when empty; stage
   defaults to Discovery; company autofills; modal closes at once; the card shows
   in Discovery with no page reload. DB: 1 row, UUID id, `orgId`, value 25000,
   `discovery`/probability 20, `contactId`, `ownerId`, `company`, close date ≈ +30
   days, one `created deal …` activity in the same org; the contact's deal count
   2 → 3.
2. Dashboard button, no contact, typed company, Proposal: DB row `contactId
   null`, probability 45; shows in the Proposal column on Pipeline.
3. Contact page button: contact + company prefilled; DB row linked to that
   contact.
4. Tenant checks with **real 500s** (request rewritten so the id is not in this
   org): a foreign `contactId` and a foreign `ownerId` are each rejected by the
   server; the optimistic card appears, then the toast appears and the card is
   removed; 0 DB rows for each. Net DB change: exactly +3 deals.
- Test deals/activities were deleted afterwards (org back to seed state).
- Not done: a Company entity (still free text); editing a deal after creation.

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
fresh sign-in, even when they belong to exactly one. Worth revisiting —
either persist/restore the last active org, or auto-activate when the user
has exactly one membership.

**Worse than first thought (found in the Sep 26 audit):** the active org
is also lost on any full page load *and* on server re-renders triggered by
`router.refresh()`. The org picked in `<OrganizationList>` is visible to
the client but not to the next server request, so `auth()` returns
`orgId: null` and `resolveAuth()` redirects to `/create-org`.

### Every mutation bounced the user to `/create-org` — patched, not fixed

`CrmProvider` (`src/store/crm.tsx`) used to call `router.refresh()` after
every server action. Because of the gap above, each refresh landed on
`/create-org`. **Stopgap applied Sep 26 2026:** all seven
`router.refresh()` calls (and the `useRouter` import) were removed. The
UI now relies on optimistic state; `revalidatePath` in the actions still
invalidates the server cache, so the next navigation loads fresh data.
Trade-off (partly resolved Sep 27 2026): if an action failed, the UI kept
showing the unsaved optimistic change — every optimistic mutation now rolls
back on failure (see "Fixed: optimistic mutations now roll back"), though the
user now also gets a toast — see "Added: failure toast". Revert once active-org persistence is
fixed, or replace it with proper error handling and rollback.

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
`deal` block. No "Convert to contact only" UI path exists. (Confirmed in
the browser, Sep 26 audit #5. Adding it requires a UI change in
`src/screens/`, so it needs explicit sign-off.)

### No Contact create flow; no Company entity

**Lead and Deal creation are done** (see "New lead creation" / "New deal
creation" under Done). The "New contact" button (Contacts) still renders with no
`onClick` — confirmed via git history that it never had one (a placeholder, not a
regression) — and there's no `createContactAction` / `addContact`; `createContact`
in `lib/data/contacts.ts` is unused. It needs a form/modal in `src/screens/` (a UI
change — needs sign-off). Note: New deal's spec assumed Contact creation already
existed; it doesn't, so a deal can only be linked to a contact that came from a
lead conversion or the seed. The Pipeline column "+" buttons are also still
unwired. There's no Company model at all — company is a free-text field.

### Server actions degrade and stop persisting (dev server)

See "Server-action reliability" in the audit. Root cause unknown. Until
fixed, confirm every mutation against the DB — the optimistic UI hides
failures.

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

- **Root-cause the server-action degradation** (`HeadersTimeoutError` /
  action POST 404s). Nothing else can be verified reliably until this is fixed.
- **Make the active org persist server-side** (after `<OrganizationList>`
  selection, on full reloads, and on server re-renders), then restore
  `router.refresh()` or add proper rollback/error handling in `CrmProvider`.
  Also auto-activate when the user has exactly one membership.
- **Finish the audit: #9–12 and #14.** (#5 with-deal convert is now verified
  against the DB, and moving a deal + its activity on a converted deal is
  verified; a drag-and-drop gesture itself, and #10 task completion via
  the row checkbox on pre-existing tasks, are still untested.)
- ~~Rollback for `moveDeal`, `setLeadStatus`, `toggleTask`, `pushActivity`~~ —
  done. Follow-up: the "couldn't save" toast is
  done (see "Added: failure toast").
- ~~New lead creation~~ and ~~New deal creation~~ — done. Decide on (and sign
  off on the UI changes for) a Contact create flow, wiring the Pipeline column
  "+" buttons, and whether a Company entity is in scope.
- Delete the duplicate "Alice Audit" / "Bob Audit" seed rows in
  "Nexo Verified Org", or reset that org's test data.
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
| Optimistic UI | Client-generated UUIDs stored as the DB row ids (not counters, not post-hoc swaps) | A counter id (`d1005`) that exists only in the browser makes every follow-up action on that row fail, and a post-hoc swap leaves a window where it still fails. A UUID the server adopts as the primary key makes the optimistic row the real row; Next's ordered action queue guarantees the create lands first. Server validates the id is a UUID. |
| Optimistic UI | Persist the activity log only after its mutation succeeds; one shared `persist()` helper does run → rollback-on-failure → log | Logging first (the old order) left orphan "moved X to Y" rows in Postgres when the mutation failed. A single helper keeps the revert + activity handling identical across moveDeal / setLeadStatus / toggleTask / addNote instead of four hand-rolled try/catches. |
| Optimistic UI | Toast lives in `CrmProvider` and is fired only from `persist()`; `convertLead`/`addTask` routed through `persist()` | Keeps the "revert + tell the user" behaviour in one place so a new mutation can't forget it, and avoids touching any screen JSX (UI hands-off policy). `addLead` keeps its inline modal error rather than also toasting. |
| Create flows | New deal closes its modal immediately and relies on `persist()` rollback + toast, rather than awaiting like New lead | `persist()` is fire-and-forget by design; the user explicitly asked for the `persist()`-based pattern. Trade-off: no inline field errors, but every failure path (including tenant-ownership rejections) reverts and toasts. |
| Data layer | `convertLeadToDeal` input uses `{ ownerId, deal?: {...} }` | Contact always created; Deal only when `input.deal` is provided. |
| Data layer | Write helpers use find-then-update in a transaction | Ensures the tenant match is checked atomically before the mutation runs. |
