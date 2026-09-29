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

The full audit was **re-run with real usage on Sep 27 2026** (see "Functional
audit — re-run with real usage"). Headline: lead / contact / deal creation,
lead conversion, real mouse-drag on the pipeline, tasks, notes, global search and
Clerk team invite/role-change all work and were verified against Neon/Clerk;
field editing, a Company entity and contact-only convert are not built, and there
are real bugs and hardcoded dashboard values listed there. The original
`HeadersTimeoutError` from Sep 26 was **not reproduced** in ~40 minutes of heavy
use. The dev org is now populated with realistic data (left in place).

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

## Fixed: logging an activity now persists the parent's last-activity time (Sep 27 2026)

**Bug (found by the Sep 27 audit, #11):** logging a note on a lead bumped its
"last activity" in the UI, but `addNoteAction` → `logActivityAction` →
`logActivity` only inserted the Activity row. `Lead.lastTouchedAt` was written
only by `setLeadStatus` and convert, and **`Contact.lastInteractionAt` was never
written after creation at all** (same bug, worse) — so the bump reverted on
reload, and the Leads/Contacts "last activity" columns, their default sort and
any staleness logic were wrong.

**Fix:** `logActivity` in `lib/data/activities.ts` now runs in a transaction: it
creates the activity, then sets `Lead.lastTouchedAt` / `Contact.lastInteractionAt`
to **that activity's own timestamp** (`updateMany` filtered by `id` **and**
`orgId`, so an id from another tenant can never be touched). Because every
activity logged through the action goes through this one function, it covers
notes, "completed task" activities and the rest. Client side, completing a task
that belongs to a lead/contact now mirrors the bump locally (with rollback), so
the UI and Neon agree without a reload; `addNote` already did.

**Also fixed in the same code (tenant hole, found while reading it):**
`logActivityAction` and `addTaskAction` connected a lead/contact/deal by a
client-supplied id **without checking it belongs to the caller's org** (by code
inspection; not reproduced on the old code). Both now call `assertSubjectInOrg`
(`{ id, orgId }`-scoped lookups) first.

**Verified against Neon (real UI usage, then direct queries + reload):**
1. Note on lead "Elena Petrova": `lastTouchedAt` 20:07:06 → 21:10:28 and
   **exactly equals the note's own timestamp**; note still in the timeline after
   a full reload; after reload the Leads list shows her as the most recently
   touched row with "Last activity: Just now" (this is what used to revert). A
   second note advanced it again to the second note's time.
2. Note on contact "Ravi Menon": `lastInteractionAt` 20:09:47 → 21:11:15, equal
   to the note time; Contacts list "Last interaction" reads "Just now" after reload.
3. Completing a task attached to lead "Priya Raman": her `lastTouchedAt` equals
   the `completed …` activity time; reads "8m ago" on the Leads list after reload.
4. Forced failure (note with a bogus subject id → real 500): toast shown, Neon
   `lastTouchedAt` unchanged, no activity written.
5. Cross-tenant: with a lead fixture created in the *other* org (deleted
   afterwards), a note and a task whose subject id was swapped to that lead were
   both rejected (`lead not found`, toast); the other org's lead was untouched and
   nothing was linked to it.
- Not changed: deal activities don't touch the deal (`Deal.updatedAt` is
  maintained by stage moves only); activities logged before this fix keep their
  old parent timestamps (no backfill).

## Added: title field + a visible "edited" activity on lead edits (Sep 29 2026)

Two follow-ups to the lead-editing feature above.

### 1. `title` (job title) added to the edit modal
It's a real column (`Lead.title`), shown right in the page header and subtitle,
that the first pass left out because the task's field list didn't name it. Added
as its own field, paired with "Full name" in the modal's first row, mirroring
`NewContactModal`'s "Full name" / "Title" layout so the two edit-style modals
match. Threaded through the same places as every other field: `EditLeadModal`
then `updateLead` (store) then `updateLeadAction` (validated, <= 200 chars, like
the other text fields) then `updateLead` (data layer).

### 2. Visible "edited" activity, with a changed-fields summary
**Needed a schema migration** — no existing `ActivityKind` fit "a lead's fields
were edited" (`stage` is specifically for status/pipeline transitions). Added
`edited` to the enum:
- `prisma/schema.prisma`: `edited` added to `ActivityKind`.
- `prisma/migrations/20260929114427_add_edited_activity_kind/migration.sql`:
  `ALTER TYPE "ActivityKind" ADD VALUE 'edited'` — additive only, applied to Neon.
- `src/data/types.ts` (frontend `ActivityKind` union) and
  `ActivityStream.tsx`'s `KIND_META` (icon: `Pencil`, same icon as the edit
  button, label "Edited") — `KIND_META` is typed as `Record<ActivityKind, ...>`,
  so the compiler enforced this entry.

**Logged atomically, with a summary, not "list every field":**
`updateLead` (`lib/data/leads.ts`) now takes an `actorId`, diffs the existing row
against the incoming data field-by-field (name/title/email/phone/company/
source/owner) inside the same transaction as the update, and writes one
`Activity` row (`kind: 'edited'`, title `` `edited ${name}` ``, body
`` `Changed: title, phone, source` `` when something changed, no body when
nothing did) — so a failed write can never leave an orphan activity, matching
`convertLeadToDeal`'s pattern. `updateLeadAction` passes the caller's own id
(from `requireAuth()`) as the actor, like `convertLeadAction` already does.

**Client-side, this is intentionally NOT routed through `persist()`'s
post-success activity log** (the same slot `moveDeal`/`setLeadStatus` use). The
activity is created server-side inside the same transaction as the field
update, so also logging it via `persist()`'s `logActivityAction` would write it
a **second time** — the exact duplicate-write shape the `addNote` bug had before
it was fixed on Sep 27. Instead, `updateLead` (store) computes the same diff
client-side for instant feedback, pushes a local optimistic `Activity` row
directly into state (matching how `addDeal`/`addContact`/`addLead` show their
"created" activity before the server confirms it), and removes that same row in
`persist()`'s rollback callback if the save fails — `persist()` is still used,
just for its run/rollback/toast mechanics, not its activity-logging path.

**Verified in a real browser against Neon (17/17 after fixing 2 false fails in
my own test — an over-anchored regex expected the timeline text to *start* with
"edited", missing that it's prefixed with the actor's name, e.g. "nexoverify1
edited Aisha N. Bello-Okafor"; not an app bug):**
- The Title field exists, is prefilled from the lead, and is included in
  `EditLeadModal`'s first row next to Full name.
- Edited title, phone and source at once: the new title appeared on the page
  **and** an "Edited" row appeared in the Activity timeline **immediately**
  (optimistic, before the server responded); its body read "Changed: title,
  phone, source".
- ~7s later Neon held the new title/phone/source, untouched fields (name,
  email, company, owner) were unchanged, and **exactly one** new `Activity` row
  existed — `kind edited`, correct `orgId`/`leadId`/`subjectLabel`/`actorId`,
  body naming the three changed fields.
- Survived a full reload: the entry (and the Activity tab's count) still there,
  now from Neon rather than optimistic state.
- A no-op save (clicked Save with nothing changed) used to still log one
  "edited" activity with `body: null` — **changed Sep 29 2026, see "Fixed:
  no-op lead edits no longer log an activity" below.**
- **Real server rejection** (owner id rewritten to one in another org, forcing
  the genuine 500): the optimistic title change **and** the optimistic "Edited"
  activity both appeared first, then the toast, then both reverted; Neon's lead
  was unchanged and **no orphan `edited` activity was written** (activity count
  identical before/after).

## Fixed: no-op lead edits no longer log an activity (Sep 29 2026)

A save that changed nothing still bumped `lastTouchedAt` and logged an "edited"
activity with an empty body — noise in the timeline and a misleading "touch"
on a record nothing actually happened to.

**Fix: short-circuit before the write, not just the log.** `updateLead`
(`lib/data/leads.ts`) diffs the existing row against the incoming data first,
same as before; if `changed.length === 0` it now returns the existing row
immediately, **before** the `lead.update` and the `activity.create` — so a
no-op save skips both the database write and the activity, not only the
activity. (The alternative — still writing the row but skipping just the
activity — was explicitly left as my call; skipping the write too was cleaner:
it also stops `lastTouchedAt` from advancing for a save that changed nothing,
which the "still logs an activity" behavior would have left inconsistent with
anyway.) `updateLeadAction` and the transaction are otherwise unchanged.

**Client-side, `updateLead` (`src/store/crm.tsx`) mirrors the same diff before
touching any state**, not just before deciding whether to log: if nothing
changed, it returns immediately — no optimistic lead update, no optimistic
activity, no call to `persist()`/`updateLeadAction` at all. The modal still
closes normally (its `onClose()` runs right after `updateLead(...)`
regardless), so a no-op save behaves like "nothing to save" rather than
silently failing or doing an unnecessary round trip.

**Verified in a real browser against Neon (13/13, after correcting one false
fail in my own test — it asserted zero "Edited" text on the page, missing that
earlier legitimate "Edited" entries from prior verification were already in the
timeline; the fix was to compare the count before/after instead, which the
authoritative Neon activity-count check already did correctly):**
- Opened Edit, changed nothing, clicked Save: modal closes normally; Neon's
  activity count for the lead is **unchanged**; `lastTouchedAt` is **byte-for-
  byte unchanged** (same timestamp, not just the same second); every field is
  unchanged.
- Typing into a field and then typing it back to its original value before
  Save is **also** correctly treated as a no-op (the diff is computed at
  submit time against the lead's actual current values, not against "was any
  input touched").
- A **real** edit immediately afterward still works exactly as before: modal
  closes, the new value and an optimistic "Edited" row both appear at once,
  Neon saves the change and advances `lastTouchedAt`, and **exactly one** new
  Activity row exists — confirming the two preceding no-op saves logged
  nothing (activity count went from the same baseline directly to `+1`, not
  `+3`). The logged row correctly names only the field that actually changed.
  Survived a reload.

## Added: contact field editing (Sep 29 2026)

Same gap as leads had: only a contact's tags could change (via "+ Add" on the
Tags row); name, email, phone, title, company and owner had no UI to edit.

**Exact same pattern as the lead-editing work, built directly with the
lessons already learned there** (no-op suppression from the start, no
retrofit; reused `ActivityKind.edited`, no new migration):
- `EditContactModal` (`RecordDetail.tsx`) — same `Modal`/`Input`/`Select`
  components, same layout conventions as `EditLeadModal` (Full name/Title
  paired in the first row), reachable from the same pencil `IconButton` slot
  next to Email/Call in the profile panel (contacts have no "Change status"
  control, so it's the only icon button there). Fields: name, email
  (optional, format-checked), phone, title, company, owner — no `source`
  field, since `Contact` doesn't have one. `editOpen` state is shared with the
  lead modal rather than duplicated, since a given `RecordDetail` render only
  ever has a `lead` or a `contact`, never both.
- `updateContact` (`lib/data/contacts.ts`) mirrors `updateLead` exactly: one
  transaction scoped by `{ id, orgId }`, diffs the existing row against the
  incoming data, **skips the write and the activity entirely when nothing
  changed** (built in from the start this time, not added after the fact),
  bumps `lastInteractionAt` (the contact equivalent of `lastTouchedAt`), and
  writes one `Activity` row with `kind: 'edited'` — **the exact same kind
  added for leads, not a new enum value** — and a changed-fields summary.
- `updateContactAction` (`lib/actions/crm.ts`) validates the same way
  `createContactAction`/`updateLeadAction` do (required name/company,
  lengths, email format, title length) and re-verifies the owner belongs to
  the caller's org via `getOwnerById` before connecting it.
- `updateContact` (`src/store/crm.tsx`) follows the same `persist()`
  optimistic + rollback + toast pattern as `updateLead`, with the no-op guard
  before any state is touched — no optimistic update, no optimistic activity,
  no server call for a save that changes nothing.

**Initially NOT carried over from contact creation: the duplicate-email
check** — added Sep 29 2026, see "Added: duplicate-email check on contact
editing" below.

**Verified in a real browser against Neon (22/22, no corrections needed this
time — the no-op suppression and prior lead-editing false-fail lessons
carried over cleanly):**
- Edit contact button opens the modal prefilled with the contact's actual
  values.
- **No-op save** (clicked Save with nothing changed): modal closes normally;
  Neon's activity count and `lastInteractionAt` are **byte-for-byte
  unchanged**; every field unchanged. Cancel separately confirmed to write
  nothing.
- **Real edit of every field at once**, including reassigning the owner to a
  different org member ("Sofia Lindqvist" → "Sofia K. Lindqvist", CFO →
  Chief Financial Officer, new email/phone/company, owner → Riley Hart): the
  new name and an "Edited" activity both appeared **immediately**, before the
  server responded. ~7s later Neon held every changed field exactly,
  `lastInteractionAt` had advanced, `lifecycle`/`tags`/`location`/
  `accountValue`/`id` were untouched, and **exactly one** new Activity row
  existed (`kind edited`, correct `orgId`/`contactId`/`subjectType`/
  `subjectLabel`/`actorId`, body "Changed: name, title, email, phone,
  company, owner").
- Survived a full reload: fields and the "Edited" timeline entry persisted;
  re-opening the modal showed the **saved** values.
- **Real server rejection** (owner id rewritten to one in another org,
  forcing a genuine 500): optimistic change and its "Edited" activity both
  appeared, then the toast, then both reverted; Neon completely unchanged,
  no orphan activity.
- No schema changes were needed — confirmed `git diff` touched nothing under
  `prisma/`.
- Test edit left in place: contact "Sofia Lindqvist" is now "Sofia K.
  Lindqvist" (CFO title updated, new email/phone, company "Fjord Marine
  Group", owner Riley Hart).
- ~~Not built: deals still have no field editing~~ — added Sep 29 2026 (see
  "Added: deal field editing"). No undo/history beyond the "edited" timeline
  entries.

## Added: duplicate-email check on contact editing (Sep 29 2026)

Contact creation already rejects a duplicate email (case-insensitive, within
the org); editing didn't check at all, so an edit could silently create two
contacts with the same email — a gap the contact-editing task above shipped
with and flagged rather than guessing whether to close it.

**Fix, deliberately downgraded from creation's inline error, per the
request.** `updateContactAction` (`lib/actions/crm.ts`) now runs the same
`getContactByEmail(orgId, email)` lookup creation uses, right after the
owner check: if a match exists **and it isn't the contact being edited
itself** (`existing.id !== input.id` — so saving a contact with its own
unchanged email is never flagged), it throws. Creation returns
`{ ok: false, error }` because `NewContactModal` awaits the result and shows
the error inline; the edit modal doesn't await — it's wired to `persist()`,
same as the rest of the edit flow — so a thrown error is all that's needed:
`persist()`'s existing catch reverts the optimistic state and shows the
generic "Couldn't save the changes, please try again." toast, same as any
other rejected edit. No client-side change was needed at all — `persist()`
already handled this generically. Skipped when the email is blank, matching
creation.

**Verified in a real browser against Neon (16/16):** editing "Ravi Menon"'s
email to another real contact's email — both uppercased and in its original
case, proving the check is case-insensitive both ways — was rejected: the
optimistic change appeared first, then the toast, then it reverted; Neon's
email was completely unchanged both times, with no orphan "edited" activity,
and the *other* contact (whose email was "collided into") was untouched
either. Editing a **different** field while leaving the email exactly as it
was saved correctly (not flagged as colliding with itself) and logged
exactly one activity. Changing the email to something genuinely new still
saved. Clearing the email to blank still saved (exempt from the check, like
creation). Test contact left in a working state: "Ravi K. Menon" now has
email `ravi.menon.updated@kestrelsoftware.com`.

## Added: deal field editing (Sep 29 2026)

Same gap deals had as leads/contacts before those were fixed: the Pipeline
card menu's "Edit deal" item existed but did nothing (a dead control per the
Sep 27 audit; "Log activity" on the same menu is still dead — out of scope).
Fields: name, value, stage, expected close date, linked contact, owner —
deliberately not `company`, `priority` or `source`; only the six fields the
task named.

**Trigger reuses the existing control, not a new one.** `Pipeline.tsx`'s card
menu "Edit deal" `MenuItem` now opens `EditDealModal`
(`src/components/common/EditDealModal.tsx`, a new file matching
`NewDealModal.tsx`'s own location/style — deals have no detail page, so
unlike leads/contacts there's no shared screen to co-locate it in). Layout
mirrors `NewDealModal`: name; value + close date; stage + owner; linked
contact. Stage offers all six stages here (unlike the *create* modal, which
normally limits new deals to the four open ones) — editing an existing deal
should be able to move it into or out of Won/Lost directly, not only by drag.

**Stage changes reuse the exact same close-date rule as a drag, via one
shared function — not a second copy of the logic.** Literally calling
`moveDealToStage` from inside `updateDeal`'s own transaction wasn't feasible
(it opens its own `prisma.$transaction`, and Prisma doesn't compose nested
`$transaction` calls) or actually what was needed — what had to be identical
was the *decision*, not the SQL. `lib/data/deals.ts` now has
`closeDateOnStageChange(previousStage, nextStage)`, a small pure function
that returns "stamp to now" only when entering Won from a non-Won stage.
Both `moveDealToStage` (drag) and the new `updateDeal` (this modal) call it;
neither re-derives the rule independently, so they cannot silently diverge.
- `updateDeal` (`lib/data/deals.ts`): one transaction scoped by
  `{ id, orgId }`, diffs the existing row against the incoming data
  (including a `+existing.closeDate !== +closeDate` check against the
  *final*, post-stamp-decision date), skips the write and the activity
  entirely when nothing changed (no-op suppression built in from the start),
  and logs one `Activity` row with `kind: 'edited'` — the same kind added
  for leads, reused again, no new migration.
- `updateDealAction` (`lib/actions/crm.ts`) validates like `createDealAction`
  does (name, value bounds, stage enum, close date parse) and re-verifies
  **both** a reassigned owner and a reassigned/cleared contact belong to the
  caller's org via `getOwnerById`/`getContactById` before connecting them.
- `updateDeal` (`src/store/crm.tsx`) mirrors the server's close-date rule
  client-side for the optimistic update, and follows the same `persist()`
  pattern as the lead/contact edits.

**Bug found and fixed during verification, not by inspection:** leaving Won
through this modal was silently overwriting the precisely-stamped close date
with a coarser "noon today" value **even when the date field was never
touched**. Cause: `<input type=date>` only has day precision, and the modal
unconditionally reconstructed `${day}T12:00:00` on every submit. A drag can
never trigger this (it has no date field to resubmit), so the bug was
specific to reaching a Won→non-Won transition through the *edit modal* —
exactly the path this task added. Fix: the modal now compares the date
input's value against `deal.closeDate.slice(0, 10)` at submit time; if
unchanged, it resubmits the **original** ISO value byte-for-byte instead of
reconstructing one, so an untouched field can never look like an edit. An
explicitly *typed* new date is unaffected — that still reconstructs and
still wins over "leaving Won preserves it," same as before.

**Verified in a real browser against Neon (35/35 across two runs — the first
caught the close-date bug above and three false fails in my own test that
searched for a `"Company — Name"` string the Pipeline card never renders
contiguously (`deal.company` and `deal.name` sit in separate `<p>` tags); the
underlying Neon assertions for those same scenarios had already passed,
confirming they were test bugs, not app bugs):**
- "Edit deal" now opens the modal (previously did nothing), prefilled from
  the deal's real values.
- No-op save: modal closes normally; activity count and every field
  (including `closeDate`/`probability`) byte-for-byte unchanged.
- Real edit of name/value/close date/owner/linked contact at once, **not**
  touching stage: all five saved, `stage`/`probability` untouched, exactly
  one activity logged with "Changed: name, value, close date, contact,
  owner" — no "stage" mentioned, since it wasn't part of the diff.
- **Moving to Won via the modal**: `stage=won`, `probability=100` (same
  table `moveDeal` uses), close date stamped to ~now — confirmed **not**
  noon-today, i.e. a real precise stamp, not a coarse one.
- **Leaving Won via the modal** (the bug above, re-verified after the fix):
  close date preserved **byte-for-byte** against the precise stamp from the
  step before; probability correctly reset; the activity's summary says only
  "Changed: stage" (close date correctly excluded, since it didn't actually
  change).
- Explicitly typing a new date alongside a non-Won stage change is still
  respected (direct edits always win).
- **Real server rejections**: an owner id and a contact id each rewritten to
  a row in another org were both refused — optimistic change and its
  "Edited" activity shown first, then the toast, then a full revert; Neon
  unchanged both times, no orphan activity.
- Unlinking a contact (selecting "No linked contact") correctly saves
  `contactId: null`.
- No schema changes needed — confirmed `git diff` touched nothing under
  `prisma/`.
- Test deal left as the verification run ended it: "Halden Robotics —
  Extended pilot program", $31,000, Discovery, closing 2026-12-20, no linked
  contact.
- Not built: `company`/`priority`/`source` aren't editable on deals (not in
  the requested field list); no undo/history beyond the "edited" timeline
  entries; the card menu's "Log activity" is still a dead control.

## Added: contact-only lead conversion (Sep 29 2026)

The data layer, action and store already supported converting a lead to a
Contact without a Deal (`convertLeadToDeal`'s `deal` input was always
optional) — the `ConvertModal` in `RecordDetail.tsx` just never let the user
choose that; it unconditionally built and sent a `deal` block. Purely a UI
change, as scoped: no changes to `convertLeadToDeal`, `convertLeadAction` or
`convertLead` (store) were needed or made.

- Added a `Segmented` "What happens next" choice — "Contact only" vs.
  "Convert and create a deal" — defaulting to the deal path, so nothing
  changes for a user who doesn't touch it. Choosing "Contact only" hides
  every deal-specific field (name, value, close date, starting stage,
  priority); "Owner" stays visible either way, since it's shared — the
  contact needs one regardless of whether a deal is also created.
- Title, description, the submit button's label, and the post-conversion
  success banner (and its "View deal" action) all now reflect which path was
  actually taken, instead of always saying "deal".
- Tenant-ownership validation on the owner was already unconditional in
  `convertLeadAction` (checked before the `deal` branch), so it applies to
  both paths without any change.

**A real, previously-unreachable bug turned up during verification, not by
inspection:** the frontend only ever tracked `convertedDealId` as "this lead
has already been converted." A contact-only conversion leaves that field
unset, so after a reload the lead's "Convert to deal" button silently
**re-enabled** and the "Converted" badge disappeared — both in
`RecordDetail.tsx` and in the Leads list — even though the lead had already
been converted and had a real Contact. This was always latently possible
(the API supported contact-only before today), but the UI never exposed a
way to trigger it, so it was unreachable until this task. Fixed by adding a
persisted `convertedContactId` (mirroring the existing `convertedDealId`,
using the `Lead.convertedContact` relation that was already in the Prisma
schema — no migration needed) through `listLeads`'s `include`, `mapLead`,
the frontend `Lead` type, and the optimistic conversion update; the three
"is this lead already converted" checks in `RecordDetail.tsx` and the one in
`Leads.tsx` now treat either field as authoritative.

**Verified in a real browser against Neon (26/26 — one false fail in the
first run, caused directly by the bug above, cleared once it was fixed and
re-verified):**
- Modal defaults to the deal path unchanged; switching to "Contact only"
  hides all five deal fields and updates the title/description/button;
  "Owner" stays visible; the button needs nothing else to be enabled.
- **Contact-only submit**: success banner says "A contact record was
  created" with only a "View contact" action (no "View deal"); Neon has the
  lead `qualified`, **exactly one** Contact (carrying the lead's
  name/email/phone/company and `originLeadId`), **no Deal**, and exactly one
  `converted … to a contact` activity.
- **With-deal submit** (regression check): banner, both view actions, and
  Neon (Contact **and** Deal, correct linkage, one activity) all unchanged
  from before this task.
- **The fix, verified directly**: after a full reload, a contact-only-
  converted lead now correctly shows "Converted" and a disabled button (was
  silently reversible before the fix); the Leads list now shows its
  "Converted" badge too (was missing before the fix); the with-deal path's
  equivalent checks were unaffected (regression-clean).
- **Real tenant-ownership rejection on the contact-only path**: owner id
  rewritten to one in another org, forcing a genuine 500 — toast shown, lead
  NOT marked qualified, no Contact created, no orphan activity, and the
  "Convert to deal" trigger remained usable — then a genuine retry on the
  same lead succeeded normally.
- No schema changes needed — confirmed `git diff` touched nothing under
  `prisma/`.
- Test fixtures left in place: "Convert Test Contact-Only" (contact-only),
  "Convert Test With Deal" (with a $45,000 "Dealworks — Platform rollout"
  deal), "Convert Test Rejected Owner" (converted contact-only on a second,
  successful attempt after the rejection test).

## Fixed: deals moved to Won now get a close date; "this quarter" labels corrected (Sep 27 2026)

**Bug (Sep 27 audit, #13):** moving a deal to Won left its close date alone, so
"Won this month" (which filters won deals by close date) ignored any deal whose
old *expected* date fell in another month — e.g. Calloway was Won but the tile
read "$0 · 0 deals closed".

**Fix — close date on Won.** `moveDealToStage` (`lib/data/deals.ts`) now sets
`closeDate = now` when a deal *enters* Won (`stage === 'won'` and it wasn't Won
already). The store mirrors it optimistically and rolls it back with the stage on
failure. Judgment calls:
- **"Only if it wasn't explicitly chosen":** there's no way to tell — every deal
  is created with a close date (default +30 days, or typed) and there is no flag
  for "user set this". So the rule is: while a deal is open the date means
  *expected*; once it's won it means *actual*, so entering Won always stamps
  today. (Keeping a separate expected date would need a new column such as
  `closedAt` — worth doing if you want to report on slippage; not done.)
- **Leaving Won (reopened / moved by mistake): the date is preserved.**
  `closeDate` is non-nullable so it can't be cleared, and the previous expected
  date isn't stored so it can't be restored — keeping the last value loses
  nothing and invents nothing. Cost: a reopened deal carries a past date (it will
  show as overdue) until someone sets a new one, which needs deal editing (not
  built). Re-entering Won re-stamps it.
- **Created straight into Won** (Won column "+" / any modal): the user-typed date
  is respected — it may be a back-filled historical win. The modal's *default*
  date is now today (not +30 days) when opened from the Won column.
- **Lost is unchanged** (no date is stamped), as asked. Consequence: lost deals
  still carry their expected date, which is why the conversion caption below was
  relabelled rather than filtered.

**Fix — "this quarter" labels.** I **relabelled, not filtered.** Dashboard
conversion caption is now "N won / M lost · all time" (it always counted every
deal ever). Filtering by quarter isn't trustworthy yet: Won now has a real close
date, but Lost has none (only its stale expected date), so a quarterly win rate
would be silently wrong. The right long-term fix is a closed-at date for both
Won and Lost, then a real quarter filter. The **same false claim was on
Reports** ("N deals closed this quarter" over all won deals) and is fixed the
same way ("closed-won · all time").

**Data correction:** Calloway Foods — Supply dashboard (moved to Won *before* this
fix) had its close date back-filled from its own "marked … as Won" activity time,
so the dev data follows the new rule.

**Verified (real Chrome, real mouse drag, Neon + independent calculation, 18/18):**
1. Baseline reproduced: Dashboard "Won this month $0 · 0 deals closed" with a Won
   deal present.
2. Dragged "Northwind Logistics — Fleet analytics" Contract Sent → Won: the card
   lands in Won immediately and shows today's date (was "Oct 26"); Neon: `won`,
   probability 100, `closeDate` = now (was 2026-10-26), exactly one "marked … as
   Won" activity.
3. Dashboard "Won this month" = **$66.5K, 2 deals**, equal to a separate Neon sum.
4. Reopen (drag Won → Contract Sent): stage/probability revert, `closeDate`
   **unchanged**; the tile drops back to $18.5K / 1. Re-winning re-stamps it to
   the new time.
5. Created a deal into Won with a typed past date (Meridian Health, Sep 12): kept;
   modal default was today.
6. Forced 500 on a move to Won: card appears in Won, then toast + card returns to
   Proposal **with its original close date** (Neon unchanged).
7. Final Dashboard tile = **$93.5K, 3 deals**, matching Neon; caption reads
   "all time"; Reports caption fixed.
- **Found, not fixed:** Reports' three deltas (9.8 / 3.4 / −4.1) are hardcoded
  like the Dashboard's, and its "This quarter" button is a dead control.
- Dev data left in place: Northwind is now Won (close date = today), a new won
  deal "Meridian Health — Compliance suite" ($27,000, Sep 12) was added, Calloway
  was back-filled.

## Added: lead field editing (Sep 29 2026)

**Only `status` was editable on a lead** (via "Change status"); every other
field — name, email, phone, company, source, owner — had no UI to change it, and
`notes` isn't a column on `Lead` at all (see below).

**Pattern chosen: a modal, not inline editing.** The profile panel already uses a
read-only `dl`/`KeyValue` list (`RecordDetail.tsx`), and every existing
create/change flow in this app — `NewLeadModal`, `NewContactModal`,
`NewDealModal`, `NewTaskModal`, `ConvertModal` — is a modal built from the same
`Modal`/`Input`/`Select`/`Label` components. Turning six read-only rows into six
independent inline-editable fields (focus/blur/save-per-field state, a new
interaction pattern this codebase doesn't use anywhere) would be a bigger
departure from the existing design than adding one more modal, and it would mean
restructuring the `dl` markup the "hands off the UI" policy says not to touch
without reason. A modal reuses that markup unchanged and matches everything else
in the app.

**`notes` is deliberately NOT a field in this modal.** `Lead` has no `notes`
column — notes are an append-only `Activity` log (`kind: 'note'`), and the lead
page already has a full composer for that (the textarea above the timeline) plus
a dedicated Notes tab, both exercised and DB-verified in the Sep 27 audit. A
single overwritable "notes" field would either require a schema migration (out
of scope, not asked for) or silently discard prior notes if mapped onto "most
recent note" — either way it would misrepresent the data model. Logging more
context is still fully supported through the existing composer; this task adds
editing of the *lead's own fields*, which the composer was never meant to cover.
~~`title` (job title) is also not included~~ — added Sep 29 2026, see
"Added: title field + a visible 'edited' activity on lead edits".

**What was built:**
- New pencil "Edit lead" `IconButton` next to "Change status" in the profile
  panel (`RecordDetail.tsx`), opening `EditLeadModal` — name, email (optional,
  format-checked), phone, company, source, owner. Pre-filled from the lead,
  re-seeded whenever the modal (re)opens so it can't show stale values after a
  background revalidation.
- `updateLead` in `src/store/crm.tsx` follows the **`persist()`-based
  optimistic + rollback + toast pattern** used by `setLeadStatus`/`moveDeal`
  (the modal closes immediately, unlike `addLead`'s await-and-stay-open
  pattern) — the user explicitly asked for the `persist()` pattern here.
- `updateLeadAction` (`lib/actions/crm.ts`) validates the same way
  `createLeadAction` does (required name/company, lengths, email format, source
  against the enum) and **re-verifies the owner belongs to the caller's org**
  via `getOwnerById(orgId, id)` before connecting it — a changed owner is
  exactly the kind of client-supplied id this app's other actions already treat
  as untrusted.
- `updateLead` (`lib/data/leads.ts`) is one `$transaction`, scoped by
  `{ id, orgId }` like every other write in this file, and bumps
  `lastTouchedAt` to the edit time (an edit is a touch on the record, same as a
  status change).
- **No new Activity row is written for a plain field edit** (deliberate): no
  existing `ActivityKind` fits "edited fields" (`stage` is specifically for
  pipeline/status transitions), and adding a new enum value means a schema
  migration against the live Neon database — a bigger change than this task
  asked for. `lastTouchedAt` still moves, so the record correctly shows as
  recently touched; there's just no timeline entry describing what changed.

**Verified in a real browser against Neon (20/20):** the pencil button opens the
modal prefilled with the lead's actual values; Cancel writes nothing. Edited
every field on "Aisha Bello" at once (name, email, phone, company, source, and
reassigned the owner to a different org member) — the new name appeared on the
page **immediately, no reload**, and ~7s later Neon held every changed field
exactly, `lastTouchedAt` had advanced, and `status`/`score`/`estValue`/`id` were
untouched; no new Activity row was written. Reloaded the page: all fields
persisted, and re-opening the modal showed the **saved** values, not the
pre-edit ones. Client-side: an invalid email disables Save with an inline error;
a blank email is allowed. **Real server rejections** (id rewritten in the
in-flight request, so the server's own checks fire): an owner id from another
org, and a source value not in the enum, were each refused — UI reverted to the
last saved name, the "Couldn't save the changes" toast appeared, and Neon was
completely unchanged both times.
- Test edit was left in place: lead "Aisha Bello" is now "Aisha N.
  Bello-Okafor" at "Meridian Health Systems", assigned to Riley Hart.
- ~~Not built: contacts and deals still have no field editing~~ — contact
  editing added Sep 29 2026 (see "Added: contact field editing"); deal
  editing also added Sep 29 (see "Added: deal field editing"). No
  undo/history for an edit beyond the new "edited" timeline entries.

## Fixed: Tasks header "New task" button (Sep 27 2026)

**Was it one broken button or two controls? Two — on the same page.** Both
statements in the audit were true. The Tasks screen has:
- **(a) the toolbar "Quick add a task…" input + Add button** — works (audit #10
  passed, DB-verified): `submit()` → `addTask({ title, dueDate: now, priority:
  'medium' })`;
- **(b) the header "New task" `<Button>`** — had **no `onClick`**; re-confirmed in a
  real browser before touching code: no dialog, no navigation, 0 server actions,
  nothing written.
A third path exists on record pages (Tasks tab → `addTask` with a linked subject).
All of them already funnel through the store's `addTask` → `addTaskAction` →
`createTask`, so the fix reuses that one flow instead of adding a second.

**Fix.**
- `Tasks.tsx`: the header button opens a local `NewTaskModal` (existing `Modal`,
  `Input`, `Select`, `Label`; same layout as the other create modals) with **task
  title, due date, priority, type (To-do/Call/Email/Meeting) and assignee**. It
  calls the *same* `addTask`; the modal closes immediately and failures revert +
  toast via `persist()`. If the task is assigned to someone else the list switches to
  "Team tasks" (the default "My tasks" view would otherwise hide it and look like the
  save failed).
- `addTask` (store) and `addTaskAction` (server) gained two optional fields, `type`
  and `ownerId`, defaulting to the old behaviour (`todo`, the current user), so the
  quick-add and record-page paths are unchanged.
- **Tenant ownership:** an assignee other than the caller is verified with
  `getOwnerById(orgId, id)` before it is connected (another org's owner → rejected).
- `addTaskAction` previously trusted its inputs; it now validates title (required,
  ≤ 500), due date, priority and type. Not included: a "related record" picker
  (record pages still cover that).

**Verified in a real browser against Neon (27/27):** the button opens the dialog;
Create is disabled until a title exists; defaults are today / Medium / To-do / me;
the assignee list is exactly the org's 4 owners; Cancel writes nothing. Created 3
realistic tasks through it — "Send Kestrel the revised MSA redlines" (high, email,
**assigned to Riley Hart**), "Call Fjord Marine legal about the redlines" (high, call,
me, **due yesterday**) and "Prepare the Q4 pipeline review deck" (to-do, in 6 days) —
each appeared in the list at once with no page reload, and Neon holds exactly the
chosen owner/priority/type/due date (noon local), a UUID id and the right `orgId`.
After a full reload they persist and land in the right buckets (Overdue / This week);
the header count and the Dashboard "Needs attention" bar show the new overdue task,
matching Neon. Quick-add still works with unchanged defaults. **Real server
rejections:** an assignee id from another org, and `priority: "urgent"`, were each
refused with the "Couldn't add the task" toast, the optimistic row removed, and 0 rows
in Neon.
- Test tasks were **left in place** (plus "Follow up on the Halden pilot scope" from
  the quick-add check), so the dev org now has 1 overdue task.
- Not changed: tasks still can't be edited or deleted after creation, and the
  record-page task box remains title-only.

## Fixed: on-demand Owner role, order-proof webhook, data re-synced from Clerk (Sep 27 2026)

**Bug:** `resolveAuth()` (`lib/auth.ts`) created a missing Owner with `role:
'Member'` hardcoded, so anyone who reached the app before the webhook created their
row — including every org creator — was stored as "Member" whatever their Clerk role.
(The webhook path was fixed earlier the same day; this was the other writer.)

**Fix 1 — one shared mapping.** New `lib/roles.ts` `ownerRoleFromClerk()` maps Clerk's
`org:admin` (and `admin`) → `Admin`, anything else → `Member`. `resolveAuth()` now
reads `orgRole` from `auth()` and uses it; the webhook handler uses the same function,
so the two writers can no longer disagree. (Only the *creation* path was changed on
purpose: `resolveAuth()` does not "self-heal" an existing Owner from the session,
because the token's `org_role` claim can lag a role change and would overwrite the
webhook's newer value.) The only other `'Member'` literal left is the unreachable
"no Owner found" fallback in `lib/data-loader.ts`.

**Fix 2 — the existing data, re-synced from Clerk.** New script
`scripts/resync-from-clerk.js` (dry run by default, `--apply` to write; safe to
re-run) compares `Organization.name` and every `Owner.role` in every org with Clerk's
live state. First run found **5 mismatches**, all corrected:
- 3 org creators stored as `Member` although Clerk says `org:admin`:
  **`nexoverify1@mailinator.com`** (the case you named), `nexoaudit_test@mailinator.com`,
  `mrayandar123@gmail.com` (the original bug);
- `Organization.name` back to `Nexo Verified Org` (Neon held my temporary
  "… (webhook test)" name);
- `casey.morgan…` stored `Admin` although Clerk says `org:member`.
The last two were caused by a **second problem found on the way**, below.

**Found on the way — stale webhook redeliveries corrupt data.** After the handler
was fixed, Svix kept auto-retrying the *old failed* messages on its schedule (5 s, 5
min, 30 min, 2 h…). **A manual "Replay" does not cancel those retries**, so they
re-applied old payloads after the correct ones: the org name regressed to my test
rename and Casey went back to Admin. (My earlier note that replaying in order was
enough was wrong.)
**Fix 3 — the handler no longer trusts the payload for updates.**
`organization.updated`, `organizationMembership.created` and `.updated` now read the
*current* state from Clerk (`organizations.getOrganization`,
`users.getOrganizationMembershipList`) and write that, so any redelivery is harmless.
A stale event for someone who is no longer a member is ignored (it can't resurrect
their Owner); a Clerk API failure other than 404 throws so Svix retries.
Name/email/avatar for members now also come from Clerk, not the payload.

**Verified:**
1. **On-demand path, isolated from the webhook** (Owner row deleted first, so only
   `resolveAuth()` could recreate it; then a real Clerk sign-in through the app): a
   member with Clerk role `org:admin` got `Owner.role = Admin` (sidebar "Admin"); the
   same user as `org:member` got `Member` (sidebar "Member"). 8/8.
2. **nexoverify1:** Clerk `org:admin`, Neon `Admin`, and the sidebar account card in
   the real UI reads "Admin".
3. **Hardened webhook, validly-signed stale payloads** (7/7): a stale
   `organization.updated` name is ignored (Neon keeps Clerk's name); a stale
   `membership.updated` claiming `org:admin` doesn't change a Member; a stale
   `membership.created` for a non-member creates nothing; after changing a role in
   Clerk, an *older* payload with the previous role still leaves Neon following
   Clerk; a current event still works; forged signature → 400.
4. `node scripts/resync-from-clerk.js` → **0 mismatches** across all three orgs.

**⚠️ Not yet deployed.** These changes (`lib/roles.ts`, `lib/auth.ts`,
`app/api/webhooks/clerk/route.ts`, `scripts/resync-from-clerk.js`, this file) are
**uncommitted**, so production still runs the previous, payload-trusting handler.
Until they are committed and pushed, Svix's remaining scheduled retries of the old
failed messages (next round roughly 2 h after the last) can re-introduce drift.
If that happens, run `node scripts/resync-from-clerk.js --apply`; after deploy the
retries become harmless.

## Clerk webhook: registered, fixed and verified end to end (Sep 27 2026)

**Status: WORKING and DEPLOYED FROM GIT.** The handler fixes, the cursor/popover
fix and these docs are committed and pushed (`6d005fb`, `8ea2454`, `efd4e7c` on
`origin/main`). Vercel's production deployment was built from git commit
`efd4e7c68d13cd27f7d14eaaa09d06c10b4f468b` (recorded by Vercel: `source: git`,
`gitSource.sha` equal to local `HEAD` and `origin/main`), and was re-verified
there: a live role change reached Neon, and on the production site every enabled
button shows a pointer and the account menu opens upward with a working Sign out.

**What was true before (answer to "is it registered?"): no.** Four independent
checks agreed: Svix (Clerk's webhook backend) had **0 endpoints**; the Vercel `crm`
project had **no `CLERK_WEBHOOK_SECRET`**; the live route answered
`500 "Webhook secret not configured"`; and the local `.env` had none. Earlier
reports that it was set up were wrong.

**Path used: Vercel** (not ngrok). Production URL
`https://crm-amber-eight-81.vercel.app` (Vercel project `crm`, team
`rayans-projects-bb024454`, auto-deploys from `mrayandar/CRM` `main`).

### What was done
1. **Pushed the 11 pending commits** to `origin/main` (fast-forward; secret-scanned
   first) — Vercel auto-built and deployed them.
2. **Registered the endpoint** through Clerk's embedded Svix portal (Clerk's own
   Backend API issues the portal link, so no dashboard login was needed): URL
   `https://crm-amber-eight-81.vercel.app/api/webhooks/clerk`, endpoint
   `ep_3JspuSFZu2zElbtF7zizNqkQLBe`, subscribed to exactly
   `organization.created`, `organization.updated`, `organization.deleted`,
   `organizationMembership.created`, `organizationMembership.updated`.
   To do the same by hand: Clerk Dashboard → Configure → Webhooks → Add Endpoint,
   paste that URL, tick those five events, then copy the *Signing Secret*.
3. **Signing secret** stored as `CLERK_WEBHOOK_SECRET` in the local `.env`
   (gitignored) and in Vercel **Production** env vars (never printed or committed);
   production redeployed so it takes effect. A forged signature is rejected (400).

### It did NOT work at first — three real bugs in the handler
Registering it exposed them (the handler had never run before):
1. **Every delivery crashed with `TypeError … reading 'type'`.** In the installed
   `svix` 2.5.0, `Webhook.verify()` returns `undefined` (it only validates and
   throws); the code did `event = wh.verify(...)`. Found in Vercel runtime logs.
   Fix: verify, then `JSON.parse(body)`.
2. **Roles were always stored as "Member".** Clerk sends `role: "org:admin"` /
   `"org:member"` (confirmed from real payloads in Svix); the code compared to
   `'admin'`. Fix: map `org:admin` (and `admin`) → `Admin`.
3. **Role changes never reached Postgres.** `upsertOwnerFromClerk`'s `update`
   branch didn't write `role`, so `organizationMembership.updated` was a silent
   no-op. Fix: it now updates `role` (safe: `resolveAuth()` only calls it when no
   Owner exists yet).
Files: `app/api/webhooks/clerk/route.ts`, `lib/data/owners.ts`.

### Verification (real path: Clerk → Svix → Vercel → Neon; Neon queried directly)
- **New member who never signed in:** a fresh member was added to the org through
  Clerk's API (`sessions = 0`, `last_sign_in_at = null` — so `resolveAuth()`'s
  on-demand fallback could not have run). About **3 seconds** later Neon had the
  **Owner row** (name, email, role `Member`, avatar, `clerkUserId`) — created by
  the webhook. (API-added rather than an accepted invitation, because accepting
  requires signing in; the event fired is the same `organizationMembership.created`.)
- **Role change** (`org:member` → `org:admin` via Clerk): Neon `Owner.role` became
  `Admin` within ~20 s (was permanently `Member` before fix 2/3).
- **`organization.updated`:** renaming the org in Clerk changed
  `Organization.name` in Neon; reverting it restored it. Neon is back to
  "Nexo Verified Org".
- **Svix delivery log:** the new events show **Succeeded**; the older deliveries
  from the crashing build were then re-sent one at a time in their original order
  and also succeeded. **This turned out not to be enough:** Svix kept retrying those
  messages on its own schedule afterwards and they overwrote newer data (see "Fixed:
  on-demand Owner role, order-proof webhook…" above, which also fixes it properly).
- Also confirmed locally beforehand with validly signed replays of the real
  payload shapes; the unknown/unsubscribed event type is ignored with 200; a
  forged signature returns 400.
- **Back-filled by real events:** Jordan Ellis (added before the webhook existed)
  got his Owner row via a role toggle. All 4 Clerk members now have an Owner row;
  Neon roles match Clerk except `nexoverify1` (below).
- The pending invite `nexo.invitee.18517@mailinator.com` was left untouched.
- Fixture members in Clerk (kept, all `Member`): Jordan Ellis, Casey Morgan,
  Riley Hart (mailinator addresses). Remove them from Settings → Team if unwanted.

### Action needed / caveats
- ✅ **Committed and pushed** (was the outstanding action item): the handler fix
  first shipped as a one-off CLI production deploy built from a clean copy of
  `origin/main` + the two files; it is now in git (`6d005fb`) and the next
  git-triggered Vercel build contains it (verified — see the status line above).
  Any *future* CLI deploy must start from a checkout of `main`, not a stale copy.
- **Not exercised:** `organization.deleted` (destructive; `deleteOrg` removes the
  Organization row but tenant tables have no FK to it, so their rows would be
  orphaned) and `organizationMembership.deleted` isn't subscribed (removing a
  member leaves their Owner row).
- ~~`nexoverify1` shows `Member` in Neon while Clerk says `org:admin`~~ — fixed
  Sep 27 (`resolveAuth()` now maps the real `orgRole`; existing rows re-synced).
- ~~Events aren't ordered/idempotent~~ — fixed Sep 27: update events now read
  current state from Clerk, so redeliveries are harmless (pending deploy).
- The deployment uses Clerk's **development** instance keys.
- Svix's portal login link is single-use; mint a new one via
  `POST /v1/webhooks/svix_url` (Clerk Backend API) each time.

## Fixed: buttons had no pointer cursor; the Sign out menu was off-screen (Sep 27 2026)

### 1. No pointer cursor on buttons
**Cause (measured, not assumed):** every click target in the app is already a real
`<button>`, a `NavLink` anchor, or a `Tr` that sets `cursor-pointer` when clickable
(the four `<span onClick>` hits only call `stopPropagation()` and aren't targets).
The problem was global: **Tailwind v4's preflight resets buttons to `cursor:
default`** and `app/globals.css` had no rule restoring it. A computed-style scan of
9 screens found **145 buttons with `cursor: default`** (primary/secondary/icon
buttons, the `role="checkbox"` buttons, segmented tabs, the account button); links,
table rows and selects were already `pointer`, and the 9 draggable deal cards
intentionally show `grab`.

**Fix:** one rule in the `@layer base` of `app/globals.css` — `button:not(:disabled),
[role='button']:not([aria-disabled='true']), summary { cursor: pointer }` — so it
covers the shared `Button`/`IconButton`, `MenuItem`, segmented tabs, checkbox and
switch buttons, and any future button with no per-component change. No component
was edited for this. Disabled buttons correctly keep the default cursor.

**Verified:** re-running the scan → **292 pointer targets, 0 `default`, only the 9
`grab` cards**; real mouse hovers on primary button, secondary button, icon button,
sidebar link, table row, select, top-bar search and the account button all report
`pointer`. Also checked the parts a page scan can't see: modal buttons (Cancel, X;
the *disabled* "Create lead" correctly isn't a pointer), row-action menu items,
command-palette rows, Settings switches, lead-page tabs, Tasks checkboxes.

### 2. "No way to sign out"
**A "Sign out" item already existed** — the bottom-left account card opens a menu
whose last entry calls `useClerk().signOut({ redirectUrl: '/sign-in' })`
(`Sidebar.tsx` `UserMenu`). It was unusable for two reasons, so I fixed those
instead of adding a duplicate control:
- **The menu opened downward from a button at the very bottom of the window**, so
  the panel (and "Sign out") rendered **below the viewport** (measured: item at
  y=1032 in a 900px window) — nothing visible happened on click.
- The account button showed no pointer cursor (fix 1), so it didn't look clickable.

**Fix:** the shared `Popover` (`src/components/ui/Menu.tsx`) is now
collision-aware: it opens below its trigger as before; if that won't fit it opens
**above**; if it fits neither way it uses the roomier side and scrolls inside a
`max-height`. Measured in a layout effect so it never flashes off-screen. This also
protects every other menu near a screen edge (row-action menus, card menus).

**Verified (real Chrome + Clerk's Backend API):** the account menu now opens upward
with "Sign out" fully on-screen (y=798–829 of 900), the element at its centre pixel
is that button, and a **real mouse click** lands on `/sign-in`; Clerk's client has
no session/user and **Clerk ended the session server-side (active sessions 43 → 42)**;
`/leads`, `/pipeline`, `/settings` then redirect to `/sign-in` and show no CRM
data. Popover regression checks: with room it still opens below and doesn't scroll;
in 520px and 420px-tall windows **all 10 row menus stay fully on-screen** (flipping
up or scrolling as needed).

**Notes / not changed:**
- In `next dev` a black **"N" Next.js dev badge overlaps the account avatar** at the
  bottom-left (dev-only; not in production builds). Hide it with
  `devIndicators: false` in `next.config.ts` if it's in the way.
- The other account-menu items ("Profile & preferences", "Notification settings",
  "Keyboard shortcuts") are dead — they only close the menu.
- `<UserButton>` wasn't needed; the existing `useClerk().signOut()` works.

## Functional audit — re-run with real usage (Sep 27 2026)

Full re-run of the 14 flows **as a user would use the app**, in a real Chrome
against the running dev server and Neon: real leads/contacts/deals created
through the modals, leads converted, deals moved with an **actual mouse drag**,
tasks added and completed, notes logged, search, dashboard, team settings. Every
verdict below was checked against a **direct Neon query** (or Clerk's Backend API
for team settings), not just the UI. ~157 checks; the harness lives in the
scratchpad (not committed). **Test data was deliberately left in place** — see
"Populated dev org" below.

| # | Flow | Verdict |
|---|------|---------|
| 3 | Create a lead | ✅ PASS (skipped per brief, but exercised anyway: 6 realistic leads through the modal) |
| 4 | Edit a lead | ✅ PASS — status **and now every other field** are editable (fixed Sep 29, see "Added: lead field editing"). **Contact and deal editing also added Sep 29** (see "Added: contact field editing" / "Added: deal field editing"). |
| 5 | Convert a lead | ✅ PASS end to end (with a deal). ~~Contact-only conversion is NOT YET BUILT in the UI~~ — **added Sep 29** (see "Added: contact-only lead conversion") |
| 6 | Create a contact | ✅ PASS (skipped per brief, but exercised: 3 contacts) |
| 7 | Create a company | 🚧 NOT YET BUILT (confirmed) |
| 8 | Create a deal | ✅ PASS (skipped per brief, but exercised from all four entry points) |
| 9 | Drag a deal across stages | ✅ PASS — first real-gesture test; 7 drags + 2 no-op drops |
| 10 | Create a task, mark complete | ✅ PASS (the dead header "New task" button was **fixed Sep 27** — see "Fixed: Tasks header New task button") |
| 11 | Log an activity, see it in the timeline | ✅ PASS — the one failure the audit found (last-touched time not saved to Neon) was **fixed the same day**, see "Fixed: logging an activity…" |
| 12 | Global search | ✅ EXISTS and works (Ctrl+K palette + per-page filters), with clear limits |
| 13 | Dashboard | ⚠️ PARTIAL — every computed metric matches Neon; **several values are hardcoded or mis-defined** (list below) |
| 14 | Team settings | ⚠️ PARTIAL — invite and role change work against real Clerk; visibility/feedback/owner-sync gaps below |

### #4 Edit a lead
- **Works:** status. All five transitions (contacted / qualified / unqualified /
  lost / new) update the UI, Neon `status`, `lastTouchedAt`, and log exactly one
  `set X to Y` activity each; survives a reload.
- ~~Not built: there is no editable field on the lead page~~ — **fixed Sep 29
  2026**, see "Added: lead field editing". ~~Contacts and deals still have no
  field editing.~~ Both **also added Sep 29** — see "Added: contact field
  editing" and "Added: deal field editing".
- **Dead controls** (click → no dialog, no navigation, no server action) *as
  of this Sep 27 audit* — lead page "Email", "Call"; Leads row menu "Log
  activity", "Send email", "Delete lead" (verified nothing is deleted); Leads
  bulk "Email", "Reassign"; Leads and Contacts "Export"; Pipeline card menu
  "Log activity", ~~"Edit deal"~~ (**fixed Sep 29**, see "Added: deal field
  editing" — "Log activity" on the same menu is still dead); Pipeline
  "Customize stages"; Settings Profile/Workspace "Save"; account-menu
  "Profile & preferences" / "Notification settings" / "Keyboard shortcuts".

### #5 Convert a lead (recheck after the recent fixes)
Priya Raman → "Northwind Logistics — Fleet analytics" ($48,000, Proposal) and
Marcus Chen → "Halden Robotics — Pilot program" ($22,500, Discovery), each via
the modal. For both: header shows *Converted* at once; Neon has the Deal, the
Contact (email/phone/company copied, `originLeadId` set), lead `qualified`,
exactly **one** `converted…` activity; deal has the right value/stage/probability,
`contactId`, `leadId`, company, `orgId`; still *Converted* after a full reload
and the deal is on the Pipeline in the right column (no phantom ids). ~~The
modal always creates a deal — no contact-only path (known gap).~~ Fixed Sep 29
2026, see "Added: contact-only lead conversion".

### #9 Drag (never tested before; menu path was)
With real `mouse.down / move / up` (HTML5 drag & drop): Halden Discovery→Proposal,
Kestrel Proposal→Negotiation, Fjord Negotiation→Contract Sent, Northwind
Proposal→Negotiation→Contract Sent (two drags on one card), Calloway →Won,
Audit Deal Beta →Lost. Each: card gets the dragging state, moves in the UI
immediately, Neon `stage` and `probability` (20/45/65/85/100/0) update, **exactly
one** activity is written (`moved X to Y` / `marked X as Won|Lost`); after a
full reload every card is still in the column it was dropped in. Dropping on its
own column and dropping outside every column are no-ops (no stage change, no
activity).

### #10 Tasks
Four quick-added tasks + one added on a lead record + one on a contact record
(both linked: `leadId`/`contactId`, `relatedToType`, label). Completing three:
checkbox flips at once, Neon `done=true`, exactly one `completed …` activity
each; un-ticking sets `done=false` with **no** activity; state survives reload;
header counts ("3 open · 0 overdue · 3 completed") match Neon. **Limits:** the
header "New task" button did nothing (**fixed Sep 27**, it now opens a full form), and the quick-add's only input is a title — no due
date, priority, type or assignee (quick-add is due "today", record tasks +2 days,
priority always medium).

### #11 Activities
Notes on a lead and a contact: appear in the timeline at once, exactly **one**
row in Neon (kind `note`, correct `leadId`/`contactId`, `orgId`, actor, label —
the duplicate-save bug stays fixed), still there after reload, the Activity tab
count equals the Neon row count, the Notes tab lists it, and the Dashboard feed
shows recent activity.
- ❌ **FAIL / bug (FIXED Sep 27 2026 — see the section above):** logging a note bumps the lead's "last activity" (and a
  contact's last interaction) in the UI, but **`addNoteAction` never updates
  `Lead.lastTouchedAt` / `Contact.lastInteractionAt` in Postgres**, so the bump
  disappears on reload (Neon: `lastTouchedAt 20:07` vs note at `20:26`). That
  column drives the Leads "Last activity" column, sorting and staleness.
- Call / Email / Meeting quick-log buttons are dead; free-text notes are the only
  loggable activity.

### #12 Global search — exists
- **Ctrl+K palette** (also the top-bar "Search…" box): opens/closes with Esc,
  7 nav shortcuts on an empty query; finds leads, contacts and deals by
  name/company/title/status text, case-insensitive, capped at 24; company search
  spans types ("Northwind" → lead + contact + deal); Enter / ArrowDown+Enter /
  click open the right record (verified by id); records created through the UI
  are searchable; a "No matches" state exists.
- **Limits:** it does **not** search email/phone, tasks or activities/notes; a
  *deal* result goes to `/pipeline` (the board), not to the deal.
- **Per-page filters** are separate and differ: Leads filter *does* match email;
  Leads/Pipeline/Contacts filters match an independent Neon query.

### #13 Dashboard
**Matches Neon:** open pipeline value ($315.5K) and weighted value ($198K),
open-deal count (6), active deals, stalled count, won-this-month value/count,
conversion rate, pipeline-snapshot total and per-stage values, "Closing in 30
days" total ($279.5K) and its five deals (the sixth, closing later, correctly
excluded), "open tasks assigned to you", the needs-attention counts, recent
activity, sidebar Leads/Tasks badges, and the "Untouched leads" saved-view count.
**Hardcoded or wrong (needs fixing before real customers):**
- The four trend deltas (**+12.4% / +6.1% / −8.3% / +4.2%**) are constants
  (`TREND` in `Dashboard.tsx`), shown to every tenant.
- **"$280K target"** in the Won-this-month tile is a literal.
- ~~Conversion is captioned "this quarter" but counts every won/lost deal ever~~
  — **fixed Sep 27** (relabelled "all time"; see "Fixed: deals moved to Won…").
- ~~**Won-this-month ignores deals won by dragging**~~ (moving a deal to Won
  didn't set its close date; Calloway: Won, close date Oct 4 → "$0 · 0 deals
  closed") — **fixed Sep 27**.
- Sidebar **"Q3 quota 54% of $1.2M"** is a literal; saved-view **"Closing in 30
  days" (`5`) and "Champions" (`3`) are literals** (Neon has 0 champions; the 5
  only matches by coincidence).
- Saved-view link `/pipeline?close=30` is **ignored** (board shows all 8 deals,
  not the 5 closing within 30 days); `/leads?status=new` works and
  `/contacts?tag=Champion` filters (to nothing).
- Known: "Won vs. target" chart is the `monthlyPerformance` mock.

### #14 Team settings (verified via Clerk's Backend API)
- **Works:** the Team tab lists the real Clerk members (count equals Clerk); your
  row is badged "You" with the role select disabled and no Remove. **Invite** →
  Clerk now holds a *pending* invitation with the right email/role for this org;
  invalid email → error shown, modal stays open; re-inviting the same email is
  accepted idempotently (still exactly one pending invitation). **Role change**
  (Member→Admin→Member on a real second member) updates the UI and is confirmed
  in Clerk, and survives reload. **Remove** removes the member (Clerk confirms).
- **Gaps:** the Team table lists **memberships only — pending invitations are
  invisible** (no list, revoke or resend). Role-change and remove **failures are
  swallowed silently** (`catch {}`), and Remove has **no confirmation**. **New
  members get no CRM `Owner` row until they sign in** (Clerk webhook was not
  registered when this audit ran — **fixed the same day**, see "Clerk webhook:
  registered, fixed and verified"), so they didn't appear in any Owner dropdown and
  couldn't be assigned leads/deals/tasks (Neon owners: only `nexoverify1`).
- Fixtures: a real second member "Jordan Ellis" (Member) was created through
  Clerk to test role changes; a throwaway member used for the Remove test was
  removed and its Clerk user deleted.

### Populated dev org "Nexo Verified Org" (left in place)
- **Leads 10** — Alice Audit ×4 (seed) + Priya Raman, Marcus Chen (both
  converted), Elena Petrova, Tomas Ortega, Aisha Bello, Daniel Okoye. Statuses:
  new 4, contacted 1, qualified 5.
- **Contacts 8** — Bob Audit ×3 (seed), Priya Raman & Marcus Chen (converted),
  Sofia Lindqvist, Ravi Menon, Hannah Wolfe.
- **Deals 8** ($315.5K open) — Audit Deal Alpha (Discovery), Audit Deal Beta
  (**Lost**), Northwind Fleet analytics (Contract Sent), Halden Pilot program
  (Proposal), Fjord Vessel telemetry (Contract Sent), Kestrel Enterprise license
  (Negotiation), Oakridge Advisory portal (Discovery), Calloway Supply dashboard
  (**Won**).
- **Tasks 6** (3 open, 3 done), **activities 38**. *(Later Sep 27: Northwind is
  now Won and a Won deal "Meridian Health — Compliance suite" was added — 9 deals,
  3 won; "Won this month" reads $93.5K / 3 deals.)* Clerk: member Jordan Ellis;
  pending invitation to `nexo.invitee.18517@mailinator.com`.

### Server-side observations during this run
~40 minutes and several hundred server actions on one dev server: **no
`failed to forward action response` / `HeadersTimeoutError`** (still not
reproduced — see "Server-action reliability"). Neon **dropped pooled connections
~25 times** (`prisma:error … kind: Closed`, mostly after idle) and Prisma
recovered each time with no failed request; worth remembering when the original
timeout is investigated (a stalled/reconnecting pool is a candidate). Two
`OrganizationSwitcher can only be used within <ClerkProvider>` errors appeared,
each immediately after the *first compile* of a route (`/leads`, `/reports`) —
a dev-only first-compile artifact; those requests still returned 200.

## Functional audit (Sep 26 2026) — superseded by the Sep 27 re-run above

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
| 6 | Create a contact directly | ✅ PASS (built + DB-verified Sep 27 2026 — see "New contact creation" under Done) |
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
  `RecordDetail.tsx` (contact page — prefills that contact and its company), and
  (Sep 27 2026) each Pipeline column's "+" button, which pre-fills that column's
  stage. Fields: name, value, stage
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

**Pipeline column "+" buttons (Sep 27 2026):** each of the six column headers'
"+" ("Add deal to <stage>") now opens `NewDealModal` with `defaultStage` set to
that column's stage. Pure reuse — no new server logic; `Pipeline.tsx` tracks
`newDeal: { stage?: DealStage } | null` (header button → `{}`, column "+" →
`{ stage }`). The modal normally offers only the four open stages, so if the
pre-filled stage is Won or Lost it's added to the dropdown for that modal (a
deal can therefore be created directly as Won/Lost from those columns; the
header button still offers only the four open stages). The pre-selected stage can
still be changed before saving.
- **Verified (browser + Neon, 24/24):** for all six columns — modal opens with
  the right stage pre-selected; on Create the card appears in that same column
  immediately (no page reload); the DB row has that `stage` and the matching
  probability (20/45/65/85/100/0), the right `orgId`, and its one `created`
  activity. Header "New deal" still defaults to Discovery with only the four open
  stages; changing the stage in a pre-filled modal is respected (Proposal "+" →
  Contract Sent saved as `contract`). Net DB change +7 deals; test deals deleted
  afterwards.

### New contact creation (complete, verified against the DB — Sep 27 2026)

- **UI:** the "New contact" button in `src/screens/Contacts.tsx` opens a
  `NewContactModal` (local to the screen, like `NewLeadModal`; built from the
  existing `Modal`/`Input`/`Select`/`Label` and the same local `Field` pattern).
  Fields: name, title, company, owner (default current user), email, phone.
  Name and company are required; email is format-checked when present. Company is
  a plain string (no Company model). *Updated Sep 27 2026:* the modal no longer
  closes instantly — it awaits the result, stays open on failure and shows the
  message inline (the same pattern as New lead), so it can display the
  duplicate-email error.
- **Server:** `createContactAction` in `lib/actions/crm.ts` — `requireAuth()` →
  `assertClientId` (UUID) → trims/validates every field (required name/company,
  lengths, email format) → **verifies `ownerId` via `getOwnerById(orgId, …)`** →
  `createContact` in `lib/data/contacts.ts` with the contact and its `created`
  activity in one nested create (atomic) → `revalidatePath`. Schema-required
  fields the form doesn't collect use fixed defaults: `lifecycle Prospect`,
  `tags []`, `location ''`, `accountValue 0`, no origin lead.
- **Store:** `addContact` in `src/store/crm.tsx` — client UUID as the row id,
  optimistic contact + activity; returns `Promise<{ ok: true, id } | { ok: false,
  error }>`. On any failure the contact and activity are rolled back and the error
  string goes to the modal. (It no longer goes through `persist()`/the toast,
  because the modal has to await the outcome — an accepted deviation from the
  Deal flow.)

**Verification (browser + direct Neon queries) — 17/17 checks:**
1. Create is disabled when empty and when the email is invalid. Creating "NC
   Person": modal closes at once, the contact shows in the list with no page
   reload (window marker survived).
2. DB: exactly 1 row, UUID id, correct `orgId`, all typed fields, owner = current
   user, `Prospect`, no tags/origin lead, plus one `created contact …` activity
   in the same org linked to the contact.
3. Integration: after in-app navigation the new contact is already in the New
   deal modal's contact dropdown (no reload), autofills the company, and a deal
   created against it persisted with `contactId` = the new contact.
4. Tenant check with a **real 500** (owner id rewritten to one not in the org):
   optimistic row appears, then the toast appears and the row is removed; 0 DB
   rows. Net DB change: exactly +1 contact.
- Test rows were deleted afterwards (org back to seed state).
- Not done: editing a contact, tags/lifecycle/location fields in the form.

**Duplicate-email rejection (Sep 27 2026):**
- `createContactAction` looks up the email **within the caller's org,
  case-insensitively** (`getContactByEmail` in `lib/data/contacts.ts`, Prisma
  `mode: 'insensitive'`) before creating; on a hit it **returns**
  `{ ok: false, error: "A contact with this email already exists" }` instead of
  creating. It's returned rather than thrown because thrown messages are redacted
  from the client in production builds. A **blank email is skipped** (it's
  optional), so any number of contacts can have no email. Success now returns
  `{ ok: true, id }`.
- `addContact` also checks local state first for instant feedback with no
  optimistic flicker or server call; the server check remains the authority
  (other users, stale clients).
- The modal shows the error under the form, keeps the entered values, and clears
  the error when the email is edited.
- **Verified against Neon (16/16):** (a) create "Dup.N@Example.com" → 1 row;
  (b) same email upper-cased on a fresh page → modal stays open with the message,
  **0 server requests**, no ghost row, DB unchanged; (c) same email lower-cased
  from a **stale second page** (loaded before the first contact existed, so only
  the server can catch it) → action returned 200 with the message, modal stayed
  open, optimistic row rolled back, DB still exactly 1 row and no activity for
  the rejected contact; editing the email clears the error and a different email
  then succeeds; (d) two contacts with a blank email both created; (e) the same
  email existing in **another org** is not a duplicate here (one row in each org).
  Test rows deleted afterwards.
- **Known limits:** it's a check-then-create, not a database constraint, so two
  simultaneous creates with the same email could both pass (a
  `@@unique([orgId, email])` isn't viable as-is: blank emails would collide and
  the seed data already has repeated emails). Pre-existing duplicates aren't
  cleaned up or blocked from editing. Only the *contact* email is checked —
  leads with the same email are not.

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
`.env` (not committed). Sign-in/sign-up render. `CLERK_WEBHOOK_SECRET` was added
on Sep 27 2026 (local `.env` and Vercel Production).

### Webhook endpoint — registered (Sep 27 2026)

Registered at `https://crm-amber-eight-81.vercel.app/api/webhooks/clerk` and
verified end to end; see "Clerk webhook: registered, fixed and verified". The
handler fixes are committed (`6d005fb`) and deployed from git.

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

### ~~`convertLead` UI only creates a deal~~ — fixed Sep 29 2026

The API and store already supported contact-only conversion (omit
`input.deal`); the UI didn't expose it. See "Added: contact-only lead
conversion" for the fix.

### Bugs and gaps found by the Sep 27 audit (details in the audit section)
- ~~Notes don't persist last-touched~~ — fixed Sep 27 2026 (see "Fixed: logging
  an activity now persists the parent's last-activity time").
- **Dashboard hardcodes/definitions:** trend deltas, "$280K target", sidebar Q3
  quota, saved-view counts `5` and `3`; saved-view link `/pipeline?close=30` is
  ignored. (Fixed Sep 27: the "this quarter" caption and Won-this-month ignoring
  deals dragged to Won.) Reports has the same hardcoded deltas (9.8 / 3.4 / −4.1)
  and a dead "This quarter" button.
- **No closed-at date for Lost deals**, so period metrics (a real "this quarter"
  win rate) can't be computed yet.
- **No field editing** for leads, contacts or deals; many controls are dead (Email,
  Call, Meeting, Log activity, Send email, Delete lead, Reassign, Export, Edit
  deal, Customize stages, ~~header "New task"~~ (fixed Sep 27), Settings profile/workspace "Save").
- **Team settings:** pending invitations aren't listed (no revoke/resend); role
  change/remove failures are silent and Remove has no confirmation; new members
  had no `Owner` row until they sign in (webhook was unregistered — fixed Sep 27,
  see the webhook section) so they couldn't be assigned records.
- **Search:** the palette doesn't cover email/phone/tasks/activities, and deal
  results open the board, not the deal.
- ~~**Tasks:** title is the only input~~ — the header "New task" form now takes due
  date, priority, type and assignee (Sep 27); quick-add and the record-page box are
  still title-only, and tasks can't be edited or deleted.

### No Company entity

**Lead, Deal and Contact creation are all done** (see "New lead / New deal /
New contact creation" under Done), including the Pipeline column "+" buttons.
There's no Company model at
all — company is a free-text string on Lead/Contact/Deal, so nothing prevents
"Acme" and "Acme Inc." from being treated as different companies. Contacts and
deals can't be edited after creation (only lead status changes, deal stage moves
and task/note actions persist).

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
- ~~Finish the audit: #9–12 and #14~~ — done Sep 27 2026 (see the re-run above).
  Fix what it found, roughly in this order: (1) ~~`addNoteAction` should update
  `lastTouchedAt` / `lastInteractionAt`~~ (done); (2) replace the hardcoded Dashboard
  and Reports values (trend deltas, target, quota, saved-view counts) with real or
  hidden ones (~~fix "this quarter", set the close date when a deal moves to
  Won~~ — done Sep 27); (3)
  ~~register the Clerk webhook so invited members get an `Owner`~~ (done Sep 27,
  committed and deployed); (4) field editing for
  leads/contacts/deals; (5) ~~a "New task" form with due date/priority/assignee~~ (done Sep 27).
- ~~Rollback for `moveDeal`, `setLeadStatus`, `toggleTask`, `pushActivity`~~ —
  done. Follow-up: the "couldn't save" toast is
  done (see "Added: failure toast").
- ~~New lead / New deal / New contact creation~~ — done. Decide on (and sign
  off on the UI changes for) editing existing leads/contacts/deals, and whether a Company entity is in scope.
- Delete the duplicate "Alice Audit" / "Bob Audit" seed rows in
  "Nexo Verified Org", or reset that org's test data.
- Seed initial CRM data for a new org (optional).
- ~~Register the Clerk webhook endpoint and test org/member sync~~ — done Sep 27
  2026, committed and deployed from git. The on-demand role and order-proof
  handler follow-ups are done in the working tree — **commit and push them**
  (`lib/roles.ts`, `lib/auth.ts`, `app/api/webhooks/clerk/route.ts`,
  `scripts/resync-from-clerk.js`) so production gets the order-proof handler.
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
| UI | Cursor fixed with one global `@layer base` rule, not per-component classes | The cause was Tailwind v4's preflight resetting `button` to `cursor: default`; every clickable is already a real `<button>`/`<a>`, so a single rule covers all current and future buttons and keeps disabled ones default. |
| UI | `Popover` picks its side by measuring (below → above → roomier side + scroll) instead of a fixed `top-full` | A fixed downward menu was rendered off-screen for the bottom-left account menu, hiding the (already working) Sign out. Fixing the shared component fixes every edge-of-screen menu, rather than special-casing one. |
| Optimistic UI | Toast lives in `CrmProvider` and is fired only from `persist()`; `convertLead`/`addTask` routed through `persist()` | Keeps the "revert + tell the user" behaviour in one place so a new mutation can't forget it, and avoids touching any screen JSX (UI hands-off policy). `addLead` keeps its inline modal error rather than also toasting. |
| Create flows | New deal closes its modal immediately and relies on `persist()` rollback + toast, rather than awaiting like New lead | `persist()` is fire-and-forget by design; the user explicitly asked for the `persist()`-based pattern. Trade-off: no inline field errors, but every failure path (including tenant-ownership rejections) reverts and toasts. |
| Create flows | `createContactAction` returns `{ ok: false, error }` for the duplicate-email rejection instead of throwing; the New contact modal awaits and shows it inline | Thrown server-action messages are redacted in production, so a specific message can only reach the UI as a return value. Trade-off: New contact no longer uses the fire-and-forget `persist()`/toast path that New deal does. |
| Data layer | `convertLeadToDeal` input uses `{ ownerId, deal?: {...} }` | Contact always created; Deal only when `input.deal` is provided. |
| Data layer | Write helpers use find-then-update in a transaction | Ensures the tenant match is checked atomically before the mutation runs. |
