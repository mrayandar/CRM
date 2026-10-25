# NexoCRM — Progress tracker

> Living context file. Updated at the end of every task.

## Calendar view (Oct 25 2026)

New `/calendar` route + sidebar entry: a month grid (Monday-start, a fixed constant) plus an
agenda panel for the selected day, falling back to a day-by-day agenda list on narrow screens
(the grid is hidden there). Per this task's explicit testing-policy override, only `tsc` and
`npm run test:related` were run — the full suite stays reserved for the pre-launch gate.

**Data: `GET /api/calendar?from=&to=`**, not the CrmProvider arrays — a month view routinely needs
dates outside what `loadCrmData` ever bulk-fetches, and re-fetching this one range per month
navigation is far cheaper than loading an org's entire task/lead/deal history. Validates `from`/
`to` as real "YYYY-MM-DD" calendar dates (rejects a malformed string and a non-existent date like
"2026-02-30", which `new Date(...)` would otherwise silently roll into March), `from <= to`, and
at most 62 days — 400 on any failure. `force-dynamic` + `Cache-Control: private, no-store`, same
`requireAuth()`/Scope gating as every other route. New data-layer functions, one per entity
(`listTasksForCalendar`, `listLeadFollowUpsForCalendar`, `listOpenDealsForCalendar`), each scoped
by `ownerId` (or the task's own assignee-OR-creator rule) exactly like their list-screen
counterparts. Open deals only — Won and Lost excluded via `stage.isClosed` (a closed deal's
`closeDate` is the instant it actually closed, not an expected date to plan around). Closed leads
excluded via the same `CLOSED_LEAD_STATUSES`/converted check the Leads filter and Stage C's scan
already use. No payment dates — Payments stays admin-only and isn't imported by this route at
all. Each item returns a plain "YYYY-MM-DD" `date` string, not an ISO instant — removing any
chance of the client re-deriving the wrong day via a local-time `Date` method, the exact class of
bug Stage A's own sign-off check found and fixed for `Lead.followUpAt`'s display.

New additive migration: `deals_orgId_ownerId_closeDate_idx`. EXPLAIN ANALYZE against the real Neon
DB: the lead and deal queries each use their own dedicated index via an Index Scan; the task query
is a Seq Scan — same documented caveat as Stage C's identical finding (the `tasks` table is tiny,
~25-50 rows total today, so the planner correctly prefers a sequential scan over any index at this
size).

**Tasks never reveal an out-of-scope parent's name** — not via a redaction check, but by design:
`listTasksForCalendar` selects only `id`/`title`/`dueDate`/`done`, no `relatedTo*` fields at all,
so there's nothing to redact in the first place (unlike `listTasks`, which does need
`redactOutOfScopeParent` because it shows `relatedTo`). The calendar never shows which lead/
contact/deal a task is attached to, in scope or out of it.

**UI**: existing design-system components only (`Card`, `Badge`, `Checkbox`, `Popover`'s sibling
primitives) — no new visual patterns. "Today" is highlighted via `localDayDelta` using the
viewer's own `Owner.timezone`, falling back to the org's effective timezone (a different fallback
order than `effectiveOrgTimezone`'s own org-business-period logic, which prioritizes org config
over the viewer when configured — the calendar's "today" concept deliberately prioritizes the
individual viewer first). Overdue tasks/follow-ups render in their original overdue style on their
original day (never moved to today), plus a dismissable-by-navigation overdue-task-count banner
linking to `/tasks`. Marking a task done reuses the existing `toggleTask` mutation from
`CrmProvider` (optimistic, rollback + toast on failure already built in) — the calendar's own
locally-fetched copy is kept in sync by patching the matching item in its own `items` state
alongside it. No drag-to-reschedule in v1. There is no Mine/Team toggle on this screen at all
(unlike Tasks/Leads/Pipeline) — `GET /api/calendar` has no `ownerId` filter param to begin with,
so a scoped Member's view is always exactly their own, with nothing to toggle away from; this
trivially satisfies "hide the Mine/Team toggle for a scoped Member" by never having built one that
would need hiding.

New `tests/integration/calendar.test.ts` (14 tests): range validation (malformed/non-existent
date, `from > to`, over 62 days, exactly 62 days), org isolation, OWN mode (a Member sees only
their own items, and the response's task items carry no `relatedTo*` field for anyone to leak), no
payment-shaped data in a Member's response, closed-lead/Won-Lost-deal exclusion, and the Nov-1
calendar-date round-trip (returned as a plain date string, so it's correct for every viewer
timezone by construction rather than needing a Karachi/Los-Angeles-specific assertion). Found and
fixed a real test bug while building this: the range-validation block used `beforeAll` to log in,
but the file's own `afterEach(() => mockAuth.mockReset())` cleared that login after the first test
in the block, leaving the rest hitting 401 instead of the intended 400s — fixed to `beforeEach`.
Extended both exhaustiveness lists: `action-route-matrix.test.ts`'s `ROUTE_BUCKETS` (new
`calendar/route.ts` entry, `scoped`) and `test-guard.test.ts`'s `KNOWN_TEST_FILES`.

Related-test total (policy override — full suite not run): **355 tests passing** across the files
`test:related` traced from every changed file.

## Reminders and notifications — Stage B sign-off checks + Stages C, D, E (Oct 25 2026)

Built in one batch, three commits (plus a preliminary one for the three sign-off checks), per the
user's explicit instruction not to push until the full suite passed at the end. **472 tests
passing (27 files)**, up from 445 at the end of the testing-policy work.

### Stage B sign-off checks (commit 1)

1. **bulkReassignLeads parity.** The original implementation rejected the WHOLE batch if any one
   lead was outside the caller's scope — not actually matching the old per-lead `updateLeadAction`
   loop it replaced, where one lead failing never blocked the others. Redesigned: chunks into
   transactions of 25 leads, reports a per-lead outcome (`moved`/`skipped`/`failed`) instead of
   throwing, and only a lead actually moved counts toward the coalesced notification. Updated the
   OWN-mode test (was asserting a throw; now asserts repA's own lead moves while repB's comes back
   `failed`, nothing written for it) and the client store (reconciles any non-`moved` lead's
   optimistic state back to its real owner on success).
2. **Orphaned task notifications.** `deleteTask` never deleted the task's own `Notification` row
   (`subjectId` is a soft polymorphic reference, not an enforced FK) — the unread count and the
   list could disagree after a delete. New `retractNotificationsForSubject`, wired into
   `deleteTask`.
3. **A real N+1 in `GET /api/notifications`.** One query per row to build each title (up to 50
   for a full page). Batched into one scoped `findMany` per subject type present (at most 4),
   verified with a query-count test using Prisma's `query` log event (`lib/prisma.ts` now emits it
   as an event in `NODE_ENV=test` only).

Also fixed a real transaction-correctness bug surfaced while building Stage C:
`writeAssignedNotification` et al. caught a `P2002` dedupe collision inside a transaction, but
Postgres aborts the WHOLE transaction on any statement error — a later legitimate write (or Stage
C's own retention `DELETE`) in the same transaction would then fail with "current transaction is
aborted" even though the catch block looked like it had recovered. Every notification write now
uses `createMany({ skipDuplicates: true })`, which resolves the conflict at the SQL level instead
of raising one.

### Stage C: time-based kinds, task_due and lead_follow_up (commit 2)

No cron (Vercel Hobby has none) — `scanAndNotify` runs inside the polled unread-count route,
claimed atomically at most once per 5 minutes per owner via a conditional `UPDATE` on the new
`Owner.lastScannedAt`. Dedupe keys include the triggering date (task id + due date, lead id +
follow-up date), so a postponed/rescheduled item notifies again while an unchanged one is a safe
no-op. The first-ever scan writes one summary per kind for everything already overdue; later scans
write individually unless a single scan's batch exceeds `SCAN_FLOOD_CAP` (20, a proposed number —
enough for a genuinely busy day without flooding the bell), which also collapses into a summary.
Read-time visibility (`buildNotificationView`) hides a stale row — task done/deleted, lead
converted/closed, the date moved, or the subject left the recipient's OWN-mode scope — backed by
write-time retraction in every action that invalidates one (task completion/reassignment, lead
status-close/reassignment/conversion), so the unread count stays accurate immediately in the
common case rather than only on the next read. Day boundaries use the recipient's
`Owner.timezone`, falling back to the org's effective timezone, via `localDayDelta` — tested
around a UTC midnight boundary for Asia/Karachi vs. America/Los_Angeles (same instant, different
"today"). Retention deletes read notifications older than 30 days inside the scan, bounded by a
`LIMIT`'d subquery (Postgres `DELETE` has no native `LIMIT`).

New additive migration (`Owner.lastScannedAt`, `Notification.triggerDate`,
`tasks_orgId_ownerId_done_idx`, `leads_orgId_ownerId_followUpAt_idx`). EXPLAIN ANALYZE against the
real Neon DB confirmed the lead index is used (Index Scan); the task index isn't yet, on a `tasks`
table this small (~25-50 rows total) — the planner correctly prefers a Seq Scan at that size, same
documented caveat as the existing unread-count index's own Stage B note.

### Stage D: the bell UI (commit 3)

`NotificationsProvider` (`src/store/notifications.tsx`), mounted in `AppLayout`, polls
`GET /api/notifications/unread-count` every 60s with its own `startLivePoll` instance (pauses when
hidden, refetches on focus/visibility — same scheduling CrmProvider's own refetch already uses).
Replaced `PageShell`'s "Notifications aren't available yet" placeholder with a real panel: unread
badge, newest-50 list (lazily fetched when the panel opens), mark read / mark all read (optimistic,
reusing CrmProvider's own `persist` for rollback-on-failure + toast — the same pattern
`bulkReassignLeads` already uses, not a second copy of that plumbing), click-through to the record
(lead/contact get their detail page, deal goes to Pipeline, task to the Tasks list — neither has a
per-record page), an empty state, and a "couldn't load, try again" state. Uses the existing
`Popover` component (same one the account menu uses) and existing design tokens throughout — no
new UI primitives. `notificationHref` (the one pure routing decision) lives in `src/lib/utils.ts`,
not the `'use client'` `PageShell.tsx`, specifically so it's unit-testable without a DOM (this
repo's vitest runs in plain Node, no jsdom). Verified with a full `next build` (clean) — no browser
tool was available in this session to click through the live panel, so that's the limit of this
pass's own verification; said so rather than claiming a manual check that didn't happen.

### Stage E: preferences (commit 4)

New `NotificationPreference` model — additive migration, one row per (owner, kind) that owner has
ever EXPLICITLY changed; **absence of a row means "enabled"**, so every owner starts opted in to
every kind without a backfill migration. Enforced at both ends: every write function (and
`scanAndNotify`, before it even queries for due items) checks the preference; `listNotifications`/
`getUnreadCount` also exclude a disabled kind's EXISTING rows (checked via one extra query, issued
only when at least one preference row exists — most owners never touch the default, so the common
case stays as cheap as before). Settings → Notifications: relabeled "New lead assigned to me" →
"Record assigned to me" and "Overdue task reminders" → "Task due or overdue"; added "Lead
follow-up due"; all three now live and wired through `CrmProvider` (`notificationPreferences` is
part of `loadCrmData`'s hydration, same as every other per-user setting). "Deal stage changes" and
"Mentions and comments" stay disabled with a "Coming soon" tag (new prop on the existing `Toggle`
component, mirroring `MenuItem`'s identical one); "Daily pipeline digest" stays disabled, labeled
"needs a sending domain" instead. `updateNotificationPreferenceAction` always writes the CALLER's
own preference — no `ownerId` param exists to pass someone else's.

Report of the exact totals, run at the end per the user's instruction: full suite **472 tests
passing, 27 files, 0 failures**, 916.14s.

## Test suite speed: diagnosis + testing policy (Oct 25 2026)

The suite had grown too slow to run after every small change (806s / 445 tests across 24 files).
Diagnosed before building anything; built only the policy + tooling (item 5 of the four-part ask).

**Diagnosis.** Raw per-query latency from this machine to Neon: ~250ms median round trip
(measured directly, 10 consecutive `SELECT 1`s), plus a ~2.7s cold-start on the first connection —
this network RTT, not Postgres query execution time, is the dominant cost; a typical DB-backed
action test issues roughly 8-40 sequential queries (each `await`ed one at a time inside a
transaction), so RTT alone accounts for seconds per test before any lead/contact GIN-index insert
cost (the ~2-4s-per-insert finding from the CSV-import pass) is even added.

Top of the real per-test timing (`vitest run --reporter=json`): the two slowest are both new Stage
B notification tests — `notifications.test.ts`'s "bulk reassign coalesces" (22.4s) and "A→B→A
notifies A twice" (21.6s), each chaining 2-3 full actions plus several `listNotifications` reads.
Next: `cross-tenant.test.ts`'s activity-dedup test (17.6s) and Dashboard-payments-math test
(16.1s), then a cluster of payment/undo/pagination tests at 9-15s. File totals: `cross-tenant.
test.ts` alone is ~330s of the 806s (163 tests, the single biggest file by far), `csv-import-
commit.test.ts` ~128s, the new `notifications.test.ts` ~111s, `own-mode.test.ts` ~92s including
its ~22s of sequential `beforeAll` fixture creates — every other file (17 of them, mostly pure unit
tests with Clerk mocked and no DB) is negligible.

**Thousands-of-rows / many-sequential-creates audit.** Only one test creates anywhere near
"thousands" of rows: `csv-import-commit.test.ts`'s per-org-cap test, seeding ~5,000 leads to reach
`PER_ORG_RECORD_CAP` — it already uses `createMany` (one batched statement), so it's already the
right shape; no change needed there. The real many-sequential-creates pattern is in `beforeAll`
fixture setup across `own-mode.test.ts`/`cross-tenant.test.ts`/`notifications.test.ts`/
`csv-import-commit.test.ts`/`lead-follow-up.test.ts` — each creates 10-15+ independent sibling
rows (leads/contacts/deals/tasks for two reps) one `await` at a time. `createMany` doesn't fit
(it doesn't return the created rows, and the fixtures need their ids), but parallelizing the
independent creates with `Promise.all` would, without changing what any test asserts — not done in
this pass (diagnosis-and-policy only), flagged here for a future pass.

**Local Postgres (proposed, not built).** A `docker-compose.yml` running `postgres:16` (the
official image already supports `CREATE EXTENSION pg_trgm`, which this repo's own migration
`20261023110512_pg_trgm_search_indexes` already issues — no special image needed), a `.env.test`
with a local `DATABASE_URL`/`DIRECT_URL`, and a Vitest `globalSetup` that runs
`prisma migrate deploy` against it once per run. Nothing in the current suite asserts anything
Neon-specific (no committed test checks connection-pool exhaustion, cold-start latency, or a real
query plan under production-scale data) — every test is exercising application logic, not Neon's
own behavior — so the whole suite could move to local Postgres, with at most a small smoke test
kept under a separate `npm run test:neon` purely to confirm real Neon reachability before a
deploy. Estimated speedup: eliminating ~250ms RTT per query (loopback is sub-millisecond) plus
removing the cold-start tax should cut total time roughly 5-10x on its own; it also removes the
`fileParallelism: false` constraint (a local Postgres has far more headroom than Neon's pooler),
which could compound another 3-5x depending on CPU cores. Rough combined estimate: 806s → 20-40s.

**CI workflow (proposed, not built).** A GitHub Actions workflow (`.github/workflows/test.yml`) on
`push`/`pull_request`, using a `postgres:16` service container (same pg_trgm note as above — no
secrets needed for the DB, it's an ephemeral container), running: checkout → setup Node → `npm ci`
→ `prisma migrate deploy` against the service container → `npm run typecheck` → `npm test`. No
Clerk secrets needed either — every test file already mocks `@clerk/nextjs/server` directly
(`vi.mock('@clerk/nextjs/server', ...)`), confirmed by grepping every integration test file.

**Built: testing policy + `test:related` (item 5).** New `CLAUDE.md` (didn't exist before) states
the policy: at the end of a task, run `tsc` and `npm run test:related -- <changed files>` (Vitest's
own module-graph "related" mode — verified working: `vitest related src/lib/utils.ts` correctly
found 9 of 24 affected files); run the full suite only on "stage complete" or before pushing a
change touching `lib/auth`/`lib/scope`/`lib/actions`/`lib/data`/`middleware.ts`/
`prisma/schema.prisma`; and never skip `cross-tenant.test.ts`/`own-mode.test.ts`/
`action-route-matrix.test.ts`/`scope.test.ts`/`scope-required.test.ts` before such a push, even if
`test:related` doesn't surface them on its own (a Prisma schema change doesn't get "imported" the
way a TS import does). New `package.json` script: `"test:related": "vitest related --run"`. No
test assertions were changed anywhere in this pass.

## Reminders and notifications — Stage A (follow-up date) + Stage B (assigned notifications) (Oct 25 2026)

Built per the approved design, one stage at a time, with the user's explicit four-check sign-off
on Stage A before starting Stage B. 445 tests passing (24 files), up from 414 at the end of Stage
A (which itself started from 399 at the end of the CSV-import work).

### Stage A (424 tests after the fixes below, 414 at initial build)

`Lead.followUpAt` (nullable `DateTime`, additive migration + index on `[orgId, followUpAt]`):
schema, `createLeadAction`/`updateLeadAction` validation, the Leads list/filter/detail/new-lead UI,
and CSV export. The user's four sign-off checks, run with evidence, found and fixed two real bugs:

1. **Timezone display bug.** `followUpAt`/`dueDate` are calendar dates stored as UTC midnight of
   the picked day, but the existing `dueLabel`/`dayDelta`/`formatDate` helpers read them with
   local-time `Date` methods — for any negative-UTC-offset viewer (most of the Americas), that
   silently shifted the displayed date back one day. Verified concretely with real Playwright
   browser contexts (`timezoneId: 'Asia/Karachi'` vs `'America/Los_Angeles'`), not just a unit
   assertion. Fixed with new zone-safe helpers (`asCalendarDate`/`calendarDayDelta`/
   `calendarDueLabel` in `src/lib/utils.ts`) used specifically for `Lead.followUpAt`; `Task.dueDate`
   has the identical pre-existing bug but was explicitly out of scope for this check.
2. **No-op-edit false positive.** Editing a lead and saving with nothing changed always logged a
   spurious "Changed: follow-up date" activity — `src/store/crm.tsx`'s client-side diff compared
   the server's full ISO string against the date input's bare "YYYY-MM-DD" with a raw `!==`, never
   equal even when unchanged. Fixed by comparing `Date.getTime()` values, matching the server's own
   (already-correct) diff in `lib/data/leads.ts`.

Check 3 (converted/closed leads must never count as "follow-up due") had no bug — confirmed with a
corrected live-verification script after finding and fixing three script-only bugs (premature
assertions, checking duplicate-strategy state after all iterations instead of per-iteration, and a
test date that was actually in the past given this environment's Oct 2026 "today"). Check 4: CSV
export was missing the follow-up date — added.

### Stage B (445 tests)

The `Notification` model (`assigned` kind only this stage; `NotificationKind`/`SubjectType` enums
extended additively — `SubjectType` gained `task`, discovered mid-build as a real representability
gap), two additive migrations, no drift.

**Write sites**: every create/update/convert action that can set `ownerId` to someone other than
the actor (`createLeadAction`/`createContactAction`/`createDealAction`/`addTaskAction`,
`updateLead`/`updateContact`/`updateDeal`/`updateTask`'s reassignment branches, and
`convertLeadToDeal`'s reassign-on-convert path) now writes an `assigned` notification inside its
own existing transaction — never a standalone write. Self-assignment never notifies. Reassignment
retracts the former owner's notification about that record in the SAME transaction (write-time
retraction, not read-time re-validation — the only event that can make an `assigned` notification
stale is a reassignment away, so retracting at that one moment is the complete mechanism, and keeps
the frequently-polled unread-count query cheap). Dedupe keys reuse the mutation's own activityId
(fresh per event, so A→B→A notifies A twice, never suppressed) with a `:contact`/`:deal`/`:lead`
suffix where one action call could notify the same recipient more than once (lead conversion).

**Owner.active**: every CREATE action checks it unconditionally; every UPDATE's reassignment branch
checks it only when the owner is actually changing (editing another field on a record an inactive
owner already owns must keep working — the nit deferred in the original scale/visibility pass).
Client-side assignment pickers (`assignableOwners()` in `src/lib/utils.ts`) now filter out inactive
owners in every assignment context (NewLeadModal, NewContactModal, EditLeadModal, EditContactModal,
ReassignModal, the lead-conversion owner picker, Tasks' Assignee field) while always keeping the
currently-selected owner visible even if inactive — filter dropdowns (list-screen "All owners")
were deliberately left untouched.

**Coalescing**: `bulkReassignLeadsAction` (new; replaces the client's old per-lead `updateLead()`
loop in `ReassignModal`) reassigns a whole batch in one transaction and writes exactly one "N leads
assigned to you" notification per recipient. CSV import's commit route calls a new
`writeImportBatchSummaryNotifications` once, at `isFinalChunk`, grouping the batch's own rows by
`ownerId` — one coalesced notification per recipient per batch, never per row (the data-layer
`createLead`/`createContact` import uses directly never write per-row notifications at all — only
the action layer does). Both coalesced paths are idempotent against a retry via a dedupe key scoped
to the operation (`bulk-reassign:${activityId}` / `import:${batchId}:${recipientId}`).

**Reading**: titles are always built at read time from the subject through the same scoped by-id
read every other feature uses (`getLeadById`/`getContactById`/`getDealById`/`getTaskById`) — never
stored on the row. A notification is silently omitted when its subject is gone or outside the
recipient's current scope. Titles contain only the kind + record name, never a value or amount
(verified directly: a deal notification's title never contains its dollar figure). Two new Route
Handlers, `GET /api/notifications` (newest 50) and `GET /api/notifications/unread-count` (a single
indexed COUNT, polled ~60s by the eventual bell) — both `force-dynamic` + `Cache-Control: private,
no-store`, same reasoning as `GET /api/crm-refetch`. EXPLAIN ANALYZE against the real Neon DB (200
seeded rows, 20 unread) confirmed the new `@@index([orgId, recipientId, readAt])` is used via an
Index Only Scan, not a sequential scan. Two new Server Actions, `markNotificationReadAction`/
`markAllNotificationsReadAction`, each scoped by id + orgId + recipientId.

No bell UI yet — Stage D per the approved design.

Extended both exhaustiveness matrices: `tests/integration/own-mode.test.ts`'s action matrix (new
`bulkReassignLeadsAction` exemption with its own dedicated OWN-mode test, since it takes an array
of ids and doesn't fit the single-id matrix shape) and
`tests/integration/action-route-matrix.test.ts` (a new `lib/actions/notifications.ts` bucket, and
both new routes). `tests/integration/test-guard.test.ts` gained the new
`tests/integration/notifications.test.ts` entry.

Tests added cover: a Member can't read or mark another user's notifications; OWN-mode reassignment
removes the record from the former owner's list/count entirely; an inactive recipient gets no
notification and can't be a new assignment; self-assignment writes nothing; A→B→A notifies A twice
(not deduped); bulk reassign and CSV import each coalesce into exactly one notification per
recipient (import verified idempotent against a retried final chunk); titles never contain a
stored value/amount; `assignableOwners()` excludes inactive owners but keeps the current selection
visible.

## Pre-launch checklist (recorded Oct 24 2026 — not started)

Deferred items, recorded so they aren't lost between now and launch. Nothing here has been
built or investigated yet.

- **Databases at launch.** The current Neon database is disposable until launch — no real
  customer data goes into it before then. At launch: create a NEW, EMPTY Neon database for
  production (migrations only; pooled connection string for the app, direct connection string for
  migrations), together with the Clerk production instance. The current database then becomes
  the permanent dev/test database and keeps the synthetic "Scale Test Org" for scale testing.
  Production connection strings live only in Vercel, never in the local `.env`. Add a guard so
  the test suite and every data-writing script (`scripts/*.js`) abort unless `DB_ROLE=dev` is set
  locally.
- **Investigate the slow single-record creates (~2-4s) and the ~2-hour-for-2,000-rows import
  throughput figure**, measured from the deployed region, not just the local/direct-DB
  measurement this session used (see the CSV-import entry below for what was already found: the
  cost traces to `Lead`/`Contact`'s GIN trigram indexes, likely worsened by the leftover "Scale
  Test Org").
- **Live import checks on the deployed site**: a 50-row file, an over-limit file, a malformed
  file, the three duplicate strategies, a Member in OWN mode, an Admin owner column with an
  unknown email, and undo with an edited record and one with a deal.
- **New sign-up and invite-accept on the deployed site under the enforced CSP.**
- **Check Settings → Team in every real org for unknown admins.**
- **Domain, Clerk production instance, webhook re-registration, terms and privacy policy.**
- **Rate limiting, error monitoring, and a backup test restore** (the production-hardening
  report's items 8-10 — recommended, not built).
- **Upgrade Vercel to Pro before taking paying customers** (Hobby is non-commercial; Pro also
  gives proper cron and higher function limits).
- **Hard gate: the full test suite must be green, with the local-Postgres test setup built first
  if the suite is still slow, before any real user touches the app.**

## CSV import for leads and contacts (Oct 24 2026)

Built in four commits per the approved design. 399 tests passing (20 files), up from 320 at the
start. Verified live against a real production build in every commit that touched behavior —
26/26 live checks pass on the final build (upload → map → preview → progress → done, both
entities, all three duplicate strategies, OWN-mode scoping, an unknown owner email, both undo
skip cases, malformed/over-limit files, and the admin-only Data tab).

**Commit 1 — phone-aware CSV export fix.** `csvCell()`'s formula-injection guard was treating a
leading `+` as an injection attempt, which mangled every phone number on export (this app formats
them "+1 555 010 0199"). Added a narrow exemption: a leading `+` followed by only digits/spaces/
parens/dots/dashes is left alone; a bare leading `-`, or a `+` hiding a real formula (e.g.
`+=cmd`), still gets neutralized.

**Commit 2 — schema, shared validation, parse/validate routes.** Added `ImportBatch` (tracks one
import run, needed for undo) and a nullable `importBatchId` on `Lead`/`Contact` — both additive,
no drift, no data loss. Extracted the field-validation rules `createLeadAction`/
`createContactAction` already enforced into `lib/validation.ts`, and `assertOwnerInScope` into
`lib/scope.ts` (it was only ever a scope helper, not an action — exporting it from
`lib/actions/crm.ts` broke that file's own action-exhaustiveness test), so import validates a row
to the exact same standard as the single-record form. `lib/data/import.ts` handles encoding (BOM
strip, strict-UTF-8-then-Windows-1252 fallback, rejects unreadable binary), delimiter/quoted-
newline-safe parsing via Papa Parse, column-mapping suggestion, and duplicate-email/company/owner
resolution. `POST /api/import/parse` and `POST /api/import/validate` are Route Handlers (not
Server Actions, same reasoning as `GET /api/crm-refetch`), `force-dynamic`, `no-store`. Found and
fixed a real leak before it shipped: a scoped Member's duplicate-email match on another rep's
record was returning that record's id/name in the response. Fixed at the type level —
`DuplicateMatch` is now `{editable: true, recordId, name} | {editable: false}`, so there's no
field left to leak on the non-editable branch.

**Commit 3 — chunked commit, idempotency, scope, cap, undo.** `POST /api/import/batches` creates
the `ImportBatch` up front; `POST /api/import/commit` processes one chunk, re-verifying on every
call that the batch belongs to the caller's org/importer and is still open. Found and fixed a real
bug: the idempotent-retry check (does this row's id already exist under this batch?) ran *after*
duplicate-email detection, so a retried chunk's own successful create looked like a duplicate of
itself on the second attempt and got diverted into the skip/update path. Moved it to run first.
OWN-mode Members get their cross-rep duplicate matches force-skipped with a generic message
regardless of the chosen strategy; the owner-column mapping is admin-only, stripped server-side
independent of validate's own stripping; update preserves every blank cell's existing value and
never touches `ownerId` or a lead's `status`. The per-org cap (5,000 leads/contacts) is checked
after the idempotent-retry check, so a retry past the cap doesn't double-fail. Undo (admin-only,
24h window) removes only rows with no Activity beyond the import's own "created" one and no
dependents (a conversion, or a linked Task/Deal) — everything else is kept and reported.

Real finding from sizing the commit chunk: couldn't reach a deployed Vercel preview (behind
deployment protection; generating a bypass secret would have weakened that project-wide —
correctly refused, not attempted). Measured directly against the real production DB instead:
creating one lead with its nested "created" activity took 2.0-4.3s across 20 consecutive calls
(median 2.7s) — genuine write cost from `Lead`'s two GIN trigram search indexes (name/email),
not network noise. Sized the commit chunk to 10 rows and `maxDuration` to 60s from that real
number. **This cost applies to every single lead/contact creation in this app today, not just
import** — worth a dedicated look on its own. A full 2,000-row import is ~200 sequential chunks,
on the order of two hours of real wall-clock time at this rate, which is why the progress bar in
the UI isn't cosmetic.

**Separately found while measuring**: a leftover `"Scale Test Org (synthetic, safe to delete)"`
in production with 5,000 leads / 10,000 contacts / 5,000 deals / 50,000 activities / 1,500
companies — right at the import cap, and very likely the single biggest contributor to the
measured write cost (GIN index maintenance cost scales with total table size, not per-org size).
**Not deleted** — it's real production data I didn't create this session, and bulk-deleting it is
exactly the kind of action to confirm first. Its own name says it's safe to delete; recommend
doing so and re-measuring the real per-row cost on a cleaner table.

Also found: running 20 test files in parallel (vitest's default) against the same real Neon
database exhausted its pooled-connection limit outright once this suite grew past 20 files —
several files failed from their very first query, not a timeout. `vitest.config.mts` now sets
`fileParallelism: false` (one file at a time) and raised `testTimeout`/`hookTimeout` from 30s to
60s for the slower-but-correct operations the GIN-index finding surfaced.

Extended the action-exhaustiveness matrix (`tests/integration/action-route-matrix.test.ts`) to
`lib/actions/import.ts`, and demonstrated it actually fails on an unbucketed export (added a
dummy export, watched the test fail, removed it) before moving on.

**Commit 4 — UI, admin record-count view, operator script.** `src/components/common/
ImportWizard.tsx`: upload → column mapping (auto-suggested, admin-only owner column) → preview
(per-row errors, duplicate-strategy picker) → chunked commit with a progress bar → done (summary,
downloadable error-report CSV via the existing `exportCsv()`, admin-only undo button). Wired into
Leads and Contacts via a new "Import" button next to Export. Found and fixed a real accessibility
gap during live verification: the mapping and duplicate-strategy `<Select>`s had a visual
`<Label>` next to them with no `htmlFor`/`id` association, so a screen reader (and Playwright's
`getByLabel`) couldn't connect the two — fixed for both.

Settings → a new admin-only "Data" tab (hidden entirely for a Member) shows this org's own
leads/contacts/deals/tasks/activities/companies counts (`getOrgRecordCountsAction`, own org only
— no platform-operator role exists in this app's auth model). For the cross-org view ("see orgs
approaching the scale limit"), `scripts/org-counts.js` — a local, read-only script for the app
operator, run against whatever `.env` points at, never exposed as a route or action. Flags any org
above 80% of the import cap; running it is what surfaced the leftover Scale Test Org above.

## Production hardening pass (Oct 24 2026)

314 tests passing (17 files) at the end of this pass, up from 280 at the start. All work below
verified against the real app (production build, real Clerk sessions, real DB) — not just unit
tests.

### Confirmations

**A. OWN-mode CSV export and command-palette search are correctly scoped.** Live-verified as a
real Member (Jordan Ellis) in an OWN-mode org: the Leads CSV export's name set matched a direct
`prisma.lead.findMany({ownerId: Jordan.id})` query exactly, and searching the command palette for
another rep's lead name and another rep's contact name both returned the exact "No matches for
…" empty state. No code change needed.

**B. `requireLiveAdminAccess()` shares `requirePaymentWriteAccess()`'s membership-pagination logic.**
It didn't — each had copy-pasted the same "page through every Clerk membership, confirm
`org:admin`" logic. Extracted into one shared `confirmLiveOrgAdmin()` helper in `lib/auth.ts`, so
the two checks can never silently drift apart. Added two tests in
`tests/integration/cross-tenant.test.ts` mirroring the existing >100-membership tests, now run
against `requireLiveAdminAccess()` directly.

**C. Production Vercel deployment matches `origin/main`.** Confirmed via the Vercel REST API
(`gitSource.sha` on the latest Ready/Production deployment): `516763e6cefa5cd832a2b980daa01c858e01ee0e`,
an exact match for `origin/main` — the GitHub integration is auto-deploying and production is
current.

**G. The six admin-gated actions without `persist()` show a clear message when demoted mid-session.**
Live-verified for `deleteCompanyAction`, `deleteStageAction`, `deletePaymentAction`,
`updateRepVisibilityAction`, `splitPaymentAction`, and `inviteMemberAction`: sign in as Admin,
demote the Owner row in the DB with no page reload, interact with the already-rendered control.
All six already returned their typed `{ ok: false }` result and the UI already showed a specific
message (e.g. "Only admins can delete companies") — none showed silence or a raw error. No code
change needed (this is what the prior `tryAdminSession`/`FORBIDDEN` conversion was for).

### Build

**1. Security headers + CSP.** `next.config.ts` now sets HSTS, X-Content-Type-Options,
X-Frame-Options (+ CSP's own `frame-ancestors 'none'`), Referrer-Policy, and Permissions-Policy on
every route, plus a CSP built from an actual audit of what the app loads (only Clerk — no
analytics, no Google Fonts, no third-party scripts). Verified report-only first, then enforced,
against a real production build (`next build && next start`) through sign-in, sign-up, org
switching, navigation, and sign-out — zero violations either way. `CSP_ENFORCE=false` is a one-env-
var rollback with no redeploy if a future change introduces a real violation. Added
`app/api/webhooks/clerk/route.ts`'s missing `Cache-Control: private, no-store` (it had none at
all, unlike the other two routes), and `tests/integration/cache-control.test.ts`, which discovers
every `app/api/**/route.ts` file from the filesystem and statically verifies every returned
`Response`/`NextResponse.json` carries that header.

**2. Error handling.** Added `app/error.tsx` and `app/global-error.tsx` (friendly message + Try
again/Back to dashboard, never a stack trace) and rewrote `app/not-found.tsx`, which used to just
`redirect('/')` — silently bouncing every 404 with no explanation. Added `app/(app)/loading.tsx`
for the one async gap that runs on every navigation into that segment (Clerk's dynamic `auth()`
forces `resolveAuth()` + `loadCrmData()` to re-run on every navigation, not just a hard reload —
see next.config.ts's CSP comment for the same mechanism). That gap used to be a blank screen.

**3. Input validation.** Audited every server action in `lib/actions/crm.ts`/`payments.ts` and all
three route handlers. Found and fixed real gaps: `setLeadStatusAction` and `reorderStageAction`
took their enum-typed argument with zero runtime check; `convertLeadAction`'s embedded deal fields
(`name`/`value`/`priority`) had none of `createDealAction`'s validation on the identical fields;
`toggleTaskAction`'s `done` wasn't checked to actually be a boolean; `logActivityAction`'s `kind`
had no enum check and `title`/`body`/subject `label` had no length caps; the webhook's
`handleOrgCreated` was missing the `if (!clerkOrgId) return` guard every sibling handler has, and
had no length cap on `name`; `splitPaymentAction`'s `parts` array had no explicit upper bound
(implicitly ~99 via the percent-sum constraint, now an explicit, documented check). Fixed CSV
formula injection: `csvCell()` in `src/lib/utils.ts` (the one function every export — Leads,
Contacts, Companies, Payments, Pipeline, Reports — funnels through) now prefixes a cell starting
with `=`, `+`, `-`, or `@` with a single quote. Live-verified: created a lead named
`=HYPERLINK("http://evil.test")`, exported via the real Export button, confirmed the downloaded
CSV contains the neutralized form, not the raw formula. New tests:
`tests/unit/csv-formula-injection.test.ts`.

**4. Secrets and logging.** No `NEXT_PUBLIC_` variable exposes a secret (checked `.env`/
`.env.example`; the only `NEXT_PUBLIC_*` values are Clerk's publishable key, Stripe's publishable
key, route paths, and the app URL — all designed to be public). `.env` was never committed and is
gitignored. Scanned the full git history (`git log --all -p`) for secret-shaped strings
(`sk_live_`, `whsec_`, AWS keys, PEM blocks) — none found. The handful of `console.error` calls in
the codebase log generic messages/error digests only, never request bodies, personal data, or
amounts.

**5. Test guard.** New `tests/integration/test-guard.test.ts`: maintains its own list of every
expected `*.test.ts` file and fails if the real filesystem (discovered the same way
`vitest.config.mts`'s `include` glob would) has one more or one fewer, and greps every discovered
file for `.skip`/`.todo`/`xit`/`xdescribe` — fails if any are found. Caught one real gap
immediately: `tests/types/scope-required.test.ts` existed on disk but wasn't in any
exhaustiveness list anywhere.

**6. Dependencies.** `npm audit fix` (no `--force`) resolved 5 of 10 flagged vulnerabilities
(`@vitest/mocker`, `vite`, `source-map-js`, `sharp` — all patch/minor bumps, `package.json`
unchanged, only `package-lock.json`). The remaining 5 (Next.js critical cache-poisoning/RCE
advisories, `postcss`, `deepmerge-ts`/`prisma`) all require a major-version bump
(`next@16`, `prisma@8`) — **not applied**, since a Next.js major bump is exactly the kind of
auth-routing-adjacent change that caused the earlier redirect loop, and deserves its own
deliberate, tested migration, not a bundled fix in this pass. Pinned `@clerk/nextjs` to an exact
version (`7.9.5`, no `^` range at all) so no future `npm install` can silently change Clerk's auth
behavior. `middleware.ts`'s `createRouteMatcher` was not touched, per instruction.

**7. Database reliability.** Every `prisma.$transaction(...)` call across `lib/data/*.ts` (25 call
sites) now goes through one new `withTransaction()` helper in `lib/prisma.ts`, which sets explicit
`maxWait: 10_000, timeout: 20_000` (Prisma's 5s default was too tight for a cold Neon pooler
spin-up) and retries the whole transaction once on a connection-level error only (`P1001`, `P1002`,
`P1008`, `P1017`, `P2024` — codes that all mean "never committed," so a retry can't double a
write; the one remaining edge, a committed write whose acknowledgment was lost, is already covered
because every create takes a client-generated id and goes through `guardAgainstIdCollision`).
`loadCrmData()`'s top-level `Promise.all([...])` of reads gets the same one-retry via a new
`withRetry()` helper (reads have no side effect to worry about doubling). Confirmed the local
`DATABASE_URL` uses Neon's pooled connection string (`-pooler` hostname, unpooled alternative
explicitly commented out). **Could not confirm the production Vercel env var's value directly** —
it's stored as a Vercel "sensitive" secret and the sandboxed session is blocked from decrypting
secrets via the API (by design). Please confirm directly in the Vercel dashboard (Project →
Settings → Environment Variables → `DATABASE_URL`) that it also contains `-pooler`.

### Report only — needs an external service and your decision, not built

**8. Rate limiting.** Needed on every mutation, `GET /api/crm-refetch`, `GET /api/activities`,
`inviteMemberAction`, and the Clerk webhook. In-memory counters don't work here: Vercel runs each
request on an isolated, often-cold serverless instance, so a module-level counter resets per cold
start and isn't shared across concurrent instances — trivially bypassed by any real load, not just
an attacker. Recommended: **Upstash Redis** via `@upstash/ratelimit` (sliding-window/token-bucket
out of the box, one-click provisioning through Vercel's integrations marketplace, which also wires
the env vars automatically). Free tier covers roughly 10K commands/day; paid usage is metered per
100K commands and should stay in the low dollars/month range at this app's likely traffic. Setup:
provision the integration, `npm install @upstash/ratelimit @upstash/redis`, then a `limit()` check
at the top of each sensitive action/route, keyed by `ownerId` (actions/GETs) or source IP (the
public webhook, defensive only since Svix already verifies the signature).

**9. Error monitoring.** Recommended: **Sentry** (`@sentry/nextjs` — official Next.js SDK, auto-
instruments server actions, route handlers, and the `error.tsx`/`global-error.tsx` boundaries just
added). PII scrubbing: keep `sendDefaultPii: false` (the default — strips headers/cookies/IP),
and add a `beforeSend` hook that drops `request.data` entirely for any payment- or activity-
related error, so a Lead/Contact's email/phone, a Payment's amount, or an Activity's note/body text
can never leave the server inside an error report — matching the same discipline this pass's
`console.error` calls already follow. Free tier (5K errors/month) likely covers this app to start;
Team plan is roughly $26/mo beyond that.

**10. Backups.** Neon's restore mechanism is branching, not separate backup files: a new branch
can be created from any point-in-time within the plan's retention window (Free: ~1 day; Launch:
up to 7 days; Scale: up to 30 days — confirm the org's actual plan and window in Neon console →
Project → Settings → Backup/Restore). Test-restore steps: (1) Neon console → Branches → Create
branch → pick the source branch and a past timestamp within the window; (2) wait for the
copy-on-write branch (seconds); (3) connect to its own connection string from `psql`/Prisma Studio
— never the production string — and confirm the expected data is present at that point in time;
(4) delete the test branch once verified. Promoting a branch to replace production is the same
mechanism, reserved for an actual incident, not a drill.

## Fixed: Members hitting a raw production error on every admin-only action (Oct 24 2026)

A Member who tried to invite a teammate got Next's generic "An error occurred in the Server
Components render" in production — the admin-only role check was correctly rejecting them, but
by *throwing*, which Next.js redacts to that generic message for any Server Action in production.

### 1. Confirmed the cause from the server logs, before changing anything

Reproduced live (real dev server, real Member session, real invite attempt) and read the
terminal:
```
⨯ Error: Admins only
    at requireAdmin (lib\auth.ts:121:39)
    at async inviteMemberAction (lib\actions\crm.ts:208:47)
  digest: '1332033175'
}
 POST /settings?section=team 500 in 2014ms
```
The digest traces exactly to `requireAdmin()`'s throw inside `inviteMemberAction` — confirmed,
not a different failure. Dev mode passes the real message through (which is why the modal showed
"Admins only" inline, not yet the generic one); production redacts it to the generic message.

### 2. Every admin-gated action now returns a typed result, never throws for the permission check

New `lib/actions/shared.ts`: `tryAdminSession(check)` runs `requireAdmin`/
`requireLiveAdminAccess`/`requirePaymentWriteAccess` and returns `null` instead of letting the
throw escape; `FORBIDDEN = { ok: false, error: 'forbidden' }` is the typed result every action
returns in that case. Deliberately narrow — only the auth check itself is caught; a later
validation throw (e.g. "Invalid email", "Unsupported currency") still throws exactly as before,
unchanged.

All 16 actions converted: `inviteMemberAction`, `updateQuotaAction`, `updateCurrencyAction`,
`updateOrgTimezoneAction`, `createStageAction`/`renameStageAction`/`reorderStageAction`/
`deleteStageAction`, `deleteCompanyAction`, `updateRepVisibilityAction`, and all 6 payment actions
(`createPaymentAction`, `updatePaymentAction`, `splitPaymentAction`, `markPaymentPaidAction`,
`cancelPaymentAction`, `deletePaymentAction`).

Client side, a new `FriendlyActionError` class (`src/store/persistRun.ts`) is how a specific,
already-safe-to-show message ("Only admins can invite teammates.") reaches `persist()`'s toast
without ever risking a redacted server message leaking through: `persist()`'s `onFailure` now
receives the caught error and shows `err.message` only when it's a `FriendlyActionError`,
otherwise the caller's own fixed generic message — so an *unexpected* throw from `run` (which
could be anything, including a production-redacted one) is never shown verbatim. Every client
wrapper that calls one of the 16 actions now checks `result.ok` and throws a `FriendlyActionError`
with its own specific message when it's false; `deleteCompanyAction`/`deleteStageAction`/
`deletePaymentAction` (which already returned `{ok,error}` rather than going through `persist()`)
map the `'forbidden'` code to a friendly sentence directly instead of showing the raw code.

**Tests**: every existing test that previously asserted `.rejects.toThrow(/Admins only/|/Forbidden/)`
for one of these 16 actions now asserts the typed `{ ok: false, error: 'forbidden' }` result
instead (found and fixed ~20 such assertions across `cross-tenant.test.ts` — several only
surfaced via `tsc`, a couple only at actual test-run time since they didn't touch the result's
shape). Added net-new coverage where a Member-rejection test didn't already exist for a given
action (`splitPaymentAction` already had one in a different describe block; added the others
inline). Every one of the 16 now has a test proving: a Member gets `{ ok: false, error:
'forbidden' }` (not a throw), and nothing was written to the database.

### 3. Hid every control a Member can't use

`Settings → Team`: the "Invite" button, the per-member role `<Select>` (now a plain read-only
`Badge`), the "Remove" button, and the "Revoke" button on pending invitations are all gated on
`currentUser.role === 'Admin'` now — previously none of them were, so a Member saw the *entire*
admin team-management UI, all of it non-functional for them.

Re-checked every other admin-only control from the Stage 1c audit, all already correctly gated:
workspace currency/timezone/quota inputs (disabled, with a "Only admins can..." note), the
`RepVisibilitySection` switch (already read-only for a non-admin), `StageManager` (already
read-only), `CompanyDetail`'s Delete button (already hidden). Nothing further needed there.

### 4. Confirmed Clerk itself independently rejects role change / remove / revoke

Role change, member removal, and invitation revocation go through Clerk's own client SDK
(`organization.updateMember()`/`removeMember()`/`Invitation.revoke()`), not one of our Server
Actions — checked live, as the real Member, calling these directly (bypassing our now-hidden UI
entirely) via `window.Clerk`:
```
updateMember (role change) as Member: { ok: false, status: 403, message: "Current user is missing an organization permission." }
removeMember as Member:               { ok: false, status: 403, message: "Current user is missing an organization permission." }
Invitation.revoke() as Member:        { ok: false, status: 403, message: "Current user is missing an organization permission." }
```
Clerk rejects all three with a 403 before our app is even involved — confirmed the target
membership's role was unchanged afterward. What a Member sees when this happens: nothing, now —
the controls that would trigger these calls are hidden, so a Member never reaches Clerk's
rejection in the first place; if they somehow did (e.g. a stale cached page), Clerk's own error
would surface, not a crash — the SDK call rejects cleanly with a normal JS error object, not an
uncaught server-side throw.

### 5. Live-verified, as the real Member and the real Admin

14/14 checks, real dev server, real sessions, no shortcuts:
- **As Jordan (Member)**: Team page loads cleanly; no "An error occurred in the Server Components
  render" anywhere; no raw "Admins only" text either; no Invite button; no role-change `<select>`;
  no Remove/Revoke icon buttons; zero uncaught page errors in the browser console. On the
  Workspace tab: currency select disabled, and the "Only admins can set the quarterly quota" /
  "...change record visibility" / "...change the workspace time zone" notes all render.
- **As the real Admin**: Invite button present, role-change `<select>` present for every
  teammate. (The dev Clerk instance was at its 5-membership/invitation cap from earlier test
  runs, so an actual end-to-end send wasn't repeated live here — already proven by the automated
  suite's `a real admin can invite a new member with either role` test, which does send one.)

### Test total: 273/273 (272 pre-existing + net 1 new — most of the ~20 touched assertions were

existing tests rewritten in place from "expect a throw" to "expect a typed result," not additions;
one genuinely new test was added, `splitPaymentAction returns a friendly { ok: false } result...`,
alongside the pre-existing one in a different describe block). `tsc --noEmit` and `next build`
both clean.

## Stage 1c: the OWN-mode switch is live (Oct 24 2026)

Five items, done in order, with a required gate: the full matrix had to pass before the switch
became reachable by any real admin.

### 1. Two more permissions fixed: pipeline stage management and company delete → admin-only

Audit finding: `createStageAction`/`renameStageAction`/`reorderStageAction`/`deleteStageAction`
and `deleteCompanyAction` were Member-accessible (`requireAuth()`), same gap category as the
`inviteMemberAction`/`updateQuotaAction` bugs fixed in the prior round. Per instruction: all four
stage actions and company delete → `requireAdmin()`. **Company edit stays open to Members** —
only unchanged, per instruction.

- `createStageAction`/`renameStageAction`/`reorderStageAction`/`deleteStageAction`: now
  admin-only. A stage's structure (including its `isWon`/`isClosed` flags, which are only ever
  set once at creation — never independently editable, see `createStage`'s doc comment in
  `lib/data/stages.ts`) affects every deal in the org.
- `deleteCompanyAction`: now admin-only — destructive and org-wide, unlike `createCompanyAction`/
  `updateCompanyAction`, which stay Member-accessible.
- **UI hidden to match**: `StageManager.tsx` now checks `currentUser.role === 'Admin'` and
  renders a read-only stage list (no reorder arrows, no click-to-rename, no delete button, no
  "add stage" field) for a Member, with a one-line "Only admins can add, rename, reorder, or
  delete pipeline stages" note. `CompanyDetail.tsx` hides its Delete button for a non-admin
  (Edit stays visible).
- **Tests**: rewrote the two "Member-accessible by design" assertions that were now wrong
  (`cross-tenant.test.ts`) into "Member is rejected" assertions, and added a new describe block
  proving a real Admin can still do all of it. `own-mode.test.ts`'s `EXEMPT_ACTIONS` reasons
  updated to say which role each of the 15 entries actually requires.

### 2. Truthful numbers when scoped — every org-wide figure checked

Went through Dashboard, Reports, the Sidebar, and Pipeline looking for anything presented as
team-wide that a scoped Member's own data couldn't actually support, or anything that should
explicitly say "yours."

| Surface | Before | After (scoped Member only — unchanged for Admins/ALL-mode) |
|---|---|---|
| Dashboard "Recent activity" | Subtitle said **"Across the whole team"** — actively false once `activities` is scoped | "Your own records" |
| Dashboard "Won this month" quota comparison | Compared the Member's own (scoped) won-this-quarter value against the **team-wide** quota target | **Hidden entirely** — comparing "your number" against "the team's target" isn't a comparison either figure actually supports once scoped |
| Dashboard "Pipeline snapshot" | No scope indicator | Appends "(your records)" |
| Reports page subtitle | No scope indicator | Appends "— your own records only" |
| Reports "Rep attainment" table subtitle | "Closed-won and open pipeline **per owner**" — implies multiple rows | "Your closed-won and open pipeline" (the leaderboard itself was already restricted to one row in Stage 1b) |
| Sidebar "Saved views" | No scope indicator | "Your own records" note under the heading |
| Pipeline toolbar | No scope indicator | "Showing your own deals" note (column totals themselves were already scoped from Stage 1a) |

**Figures checked and found already correct, nothing to change**: Sidebar nav badges, Dashboard's
"Open pipeline value"/"Active deals"/"Conversion rate" metrics, Reports' "Win rate"/"Closed-won
revenue"/"Performance by lead source" — all computed purely from the already-scoped `leads`/
`contacts`/`deals`/`tasks` arrays, so a scoped Member's numbers were already their own, just
without an explicit label (added one where the instruction named the surface; left the rest,
since Reports' and Dashboard's page-level subtitles already cover them).

**Found and fixed, unrelated to scoping but a real gap left over from the quota permission fix
two rounds ago**: the "Quarterly team quota" input in Settings had no `disabled={!isAdmin}` —
a Member could type a new value and click Save, which would silently fail server-side
(`updateQuotaAction` is admin-only) and just toast an error. Now disabled for non-admins, with a
"Only admins can set the quarterly quota" note, matching the currency field's existing pattern.

### 3. The switch itself

- **Schema** (migration `20261023211432_rep_visibility_change_tracking`):
  `Organization.repVisibilityChangedBy` (`String?`, Owner.id — bare, no formal relation, same
  no-cross-table-FK convention as every `orgId` column) and `repVisibilityChangedAt`
  (`DateTime?`). Both null until the first change.
- **`requireLiveAdminAccess()`** (`lib/auth.ts`) — copy of `requirePaymentWriteAccess()`'s exact
  pattern (pages through every Clerk org membership via the Backend API, not just the DB
  `Owner.role`), for the stated reason: switching back to ALL hands every Member visibility into
  every other rep's records again, which is exactly as sensitive as restricting it in the first
  place, so a stale DB role must never be enough to make either change.
- **`updateRepVisibilityAction`** (`lib/actions/crm.ts`) — the only writer of `RepVisibility`,
  `repVisibilityChangedBy`, and `repVisibilityChangedAt` (`updateRepVisibility` in
  `lib/data/organizations.ts`). Validates the value, stamps the caller's own id and `now()`.
- **UI**: `RepVisibilitySection` in `src/screens/Settings.tsx` (Workspace card, admin-only) — a
  `Segmented` control ("Everyone sees all records" / "Reps see only their own"), a confirmation
  `Modal` using the copy drafted in Stage 1b (`repVisibilityConfirmCopy.ts`, revised to say
  "within about a minute" for an already-open tab rather than "immediately," matching the real
  live-poll mechanism), and a "Changed by `{name}` on `{date}`" line underneath once it's ever
  been changed. A non-admin sees the current value read-only with "Only admins can change record
  visibility."
- **Propagation mechanism, unchanged from Stage 0/1a**: the live poll
  (`src/store/livePoll.ts`, 60s steady-state) re-fetches `repVisibility` on every tick;
  `QueryCacheSecurityGuard` already clears the whole TanStack Query cache the moment that value
  differs from what a tab already had. Nothing new needed here — Stage 1c only had to give it a
  real write to react to.
- **Tests**: new describe block in `cross-tenant.test.ts` — a real admin flips ALL→OWN and
  OWN→ALL (stamps who/when correctly each time); a Member is rejected outright; **a stale-DB-role
  Admin is rejected the moment Clerk reports a live demotion, in BOTH directions** (the
  OWN→ALL-while-actually-demoted case was the one explicitly worth a dedicated test, since that's
  the "granting more visibility" direction); an invalid value is rejected even for a real admin.
  `own-mode.test.ts`'s exhaustiveness bucket gained `updateRepVisibilityAction` (exempt,
  org-level by definition).

### 4. Final red team, live, on the real dev org — 33/33 checks passed

Used the real Settings switch (not a direct DB write) throughout. Member tab (Jordan Ellis)
opened **before** each switch flip, in both directions, and never reloaded — the only way to
actually prove the live-poll + cache-clear mechanism works in a real open tab, not just that a
fresh load picks up the right value.

- **ALL → OWN, via the switch**: confirmation modal showed the drafted copy (confirmed it
  mentions "minute"), DB stamped `repVisibilityChangedBy`/`repVisibilityChangedAt` correctly.
  Jordan's already-open tab, never reloaded, picked up `repVisibility: "OWN"` within the 70s
  window and re-rendered every gated screen correctly (no Team toggle, no owner filters, the
  Pipeline/Reports/Sidebar "your own records" notes) **purely from the poll — no manual refresh**.
- **Every path tried as the scoped Member**: Dashboard, Pipeline, Tasks, Leads (+ search),
  Contacts, Companies, Reports, Settings (read-only switch) all loaded correctly. `/payments`
  stayed unreachable. Command palette worked. **CSV export produced a real file download** (not
  just a button that's present). **Direct URL navigation to another rep's Lead and Contact detail
  pages produced a friendly "not found" page — no 500, no stack trace** (confirmed by scanning
  the page text for error-indicating strings). A Company detail page loaded normally (shared by
  design). `GET /api/activities` for another rep's lead subject returned 404, not 500.
- **Reassignment**: moved a real lead ("Marcus Chen") from Jordan to another rep. Within the 70s
  window, it disappeared from Jordan's still-open tab's `GET /api/crm-refetch` response.
- **OWN → ALL, via the switch**: confirmation modal showed the "whole team" copy. Jordan's
  (freshly reopened, but still never-manually-refreshed-after-flip) tab picked up `repVisibility:
  "ALL"` and `scopeOwnerId: null` within the window, lead count back to the full 13, and the
  Pipeline's "All owners" filter reappeared — all without a reload.
- **One script bug, not a product bug**: the first run's script tried to reuse the same
  single-use Clerk sign-in ticket for a second admin session and failed with a timeout at that
  exact point — 24 checks had already passed by then, including the critical reassignment-
  propagation one. Re-minted a fresh ticket and ran the OWN→ALL half as a second pass; all 9 of
  those checks passed too. **33/33 real checks, combined.**
- Restored afterward: `repVisibility` back to `ALL`, `repVisibilityChangedBy`/`At` cleared,
  "Marcus Chen" back to Jordan — confirmed by a direct DB read.

### 5. Test total

Full suite run before the switch was considered reachable by any admin, and once more after all
fixes: **272/272** (265 pre-existing + 7 new: 2 in the new "Admin can still manage stages/delete a
company" block, 5 in the new `requireLiveAdminAccess`/`updateRepVisibilityAction` block — the two
rewritten "Member is rejected" assertions replaced existing tests 1:1, not net-new). `tsc
--noEmit` and `next build` both clean.

### What OWN mode does and does not cover (plain language)

**What it does**: once an admin switches "Record visibility" to "Reps see only their own," every
Member (not Admins) sees only the leads, contacts, deals, and tasks they own or are assigned to —
everywhere: the Dashboard, Pipeline, Tasks, Leads, Contacts, Reports, search, CSV export, the
activity feed, and the live-refresh/refetch path. A task is visible if you're either its assignee
or its creator. If a task's related lead/contact/deal belongs to someone else, the task itself
still shows, but the link to that parent record is replaced with a "Restricted record" notice.
Reassigning a record moves it (and its history) to the new owner immediately; the previous
owner loses it everywhere, usually within a minute even in a tab they already have open.

**What it does NOT cover, by design, not as a gap**:
- **Companies, pipeline stages, and the team roster (Owners) stay shared and visible to
  everyone**, regardless of mode — they're not "whose" in the way a lead or deal is. Only the
  per-rep *rollup counts* on the Companies page are scoped.
- **Task assignment itself is unrestricted** even when scoped — a Member can still hand a task to
  any teammate. Only who can later *see* that task is gated.
- **Admins are always unrestricted**, in every mode — this switch changes what Members see, never
  what an Admin sees.
- **Payments has its own, separate, always-on gate** (admin-only, independent of this switch
  entirely) — turning OWN mode on or off has no effect on who can see Payments.
- It is a **visibility** control, not a data-partitioning one: nothing is duplicated, deleted, or
  made permanently inaccessible. Flipping the switch back to "Everyone sees all records" restores
  full visibility immediately for every Member, with no data loss or migration involved either
  way.

## Part 1 (role-rule audit + structural hardening) and Stage 1b (UI gating) (Oct 24 2026)

Two parts, done in order, both reported with evidence. **No Stage 1c (the Settings switch
itself) started.**

### Part 1.1 — `getCompanyDetail` fail-open gap: deleted; `scopeOwnerId` made required

Confirmed again (grepped the whole repo) that `getCompanyDetail` had zero production callers —
`CompanyDetail` (`src/screens/CompanyDetail.tsx`) derives its leads/contacts/deals from the
client's already-loaded, already-scoped `useCrm()` state (`leads.filter(l => l.companyId ===
company.id)`, etc.), never calling this function. **Deleted it** rather than fixing its optional
param, per the instruction ("delete the function if it has no caller").

`listCompanies`'s `ListCompaniesOptions.scopeOwnerId` — the one real, called Scope-adjacent
parameter left in `lib/data/companies.ts` — changed from optional (`scopeOwnerId?: string |
null`) to **required** (`scopeOwnerId: string | null`), and the `options` parameter itself lost
its `= {}` default. A caller now cannot compile without explicitly writing `scopeOwnerId: null`
for an unscoped read — "I forgot to scope this" can no longer silently happen.

New compile-time structural guard, `tests/types/scope-required.test.ts`: asserts every
Scope-consuming export of `leads.ts`/`contacts.ts`/`deals.ts`/`tasks.ts`/`activities.ts` takes
`Scope` as a **required** first parameter (`Parameters<F> extends [Scope, ...unknown[]]`, which is
`false` for an optional leading element), asserts `companies.ts`'s `scopeOwnerId` key is required
(not optional), and pins `payments.ts` as **confirmed scope-independent by design** (no export
takes a Scope-shaped first parameter at all — Payments is gated by its own two-source Admin check,
independent of `RepVisibility`). The real enforcement is `tsc --noEmit`, not the test runner: each
assertion fails to *compile* the moment a signature regresses. **Demonstrated live**: temporarily
made `getLeadById`'s `scope` parameter optional — `tsc --noEmit` failed at both the function's own
now-unsafe body AND at `tests/types/scope-required.test.ts(54,16): error TS2344: Type 'false' does
not satisfy the constraint 'true'` — reverted, confirmed clean again.

### Part 1.2 — Exhaustiveness extended to `lib/actions/payments.ts` and every `app/api/**/route.ts`

New `tests/integration/action-route-matrix.test.ts`. Route files are discovered from the real
filesystem (`fs.readdirSync`, recursive), not hand-listed, so a new `app/api/**/route.ts` file with
no bucket entry fails immediately — same guarantee `own-mode.test.ts`'s action matrix already
gives `lib/actions/crm.ts`. Buckets: `scoped` (`activities/route.ts`, `crm-refetch/route.ts` — both
already behaviorally proven elsewhere), `exempt` (all 6 `lib/actions/payments.ts` exports —
admin-gated, independent of `RepVisibility`), `public` (`webhooks/clerk/route.ts` — Clerk's own
signed webhook, no session/Scope involved at all).

**Demonstrated live**: created `app/api/__dummy_demo_route/route.ts`, ran the route-coverage test
— failed, naming it exactly (`expected ['__dummy_demo_route/route.ts'] to deeply equal []`) —
deleted it, reran: 3/3 passed, `git status --short app/api` empty.

### Part 1.3 — Role-rule audit: every action in `lib/actions/crm.ts`'s 15-entry exempt bucket

**Correction**: the Stage 1a report said "14 exempt actions" — miscounted. There are **15**.
Corrected in `own-mode.test.ts`'s `EXEMPT_ACTIONS` comment and here.

| Action | Role required | Why |
|---|---|---|
| `createCompanyAction` / `updateCompanyAction` / `deleteCompanyAction` | Member or Admin | Companies are a shared CRM entity (like leads/contacts/deals), not org-level configuration — no role gate in the UI either (checked `Companies.tsx`/`CompanyDetail.tsx`), so this is consistent, not an oversight. **Pinned by a new test** (Member successfully creates/renames/deletes a company). |
| `inviteMemberAction` | **Admin only — FIXED, was none at all** | Previously called bare `auth()` with no role check whatsoever: any Member could invite a new member AND choose `role: 'org:admin'` for them, handing out Admin access. Now `requireAdmin()`. New tests: a Member is rejected *before Clerk's API is ever called* (asserted via a mock spy never invoked) including an attempt to invite someone as `org:admin`; a real Admin can invite either role; an invalid role is still rejected even for an Admin. |
| `addTaskAction` | Member or Admin | Task **assignment** is unrestricted by design even once scoped — only *visibility* (assignee-or-creator) is gated. Confirmed intentional via its own doc comment, not re-litigated here. |
| `logActivityAction` / `addNoteAction` | Member or Admin | Delegates to `assertSubjectInScope` — a scoped Member can only attach an activity to a subject they can already see. |
| `updateProfileAction` | Member or Admin | The caller's own profile only (`requireAuth()`'s own `ownerId`) — never a client-supplied target, never an org-wide setting. |
| `updateOrgTimezoneAction` | Admin only | Already correctly gated (`requireAdmin()`) — confirmed, not a finding. |
| `updateQuotaAction` | **Admin only — FIXED, was Member-accessible** | Previously called `requireAuth()`, letting any Member set the org's quarterly quota — found by noticing `updateCurrencyAction`'s own doc comment already (wrongly) claimed parity with this one as an admin-gated setting. Now `requireAdmin()`. New tests: a real Admin can set it; a Member is rejected and the quota is confirmed unwritten. |
| `updateCurrencyAction` | Admin only | Already correctly gated — confirmed, not a finding. |
| `createStageAction` / `renameStageAction` / `reorderStageAction` / `deleteStageAction` | Member or Admin | Pipeline stages are shared/org-wide structure, same category as Companies — `StageManager.tsx` has no role gate either, consistent across UI and server. **Pinned by a new test** (Member successfully creates/renames/reorders/deletes a stage). |

Two real bugs found and fixed (`inviteMemberAction`, `updateQuotaAction`); nothing left for a
"list for my decision" bucket — the two ambiguous-looking categories (Companies, pipeline stages)
turned out to be consistently Member-accessible in both the UI and the server, not a mismatch, so
there was no judgment call actually needed once checked.

Fixing `inviteMemberAction` surfaced a test-environment gap: it was never actually exercised past
its auth check before, so its real body's `headers()` call (for the invitation's redirect URL) hit
`next/headers`'s "called outside a request scope" error under Vitest. Added `vi.mock('next/headers',
...)` to `cross-tenant.test.ts`, same pattern as the existing `next/cache` mock.

### Part 2 — Stage 1b: UI gating (no user-visible change while every org is in ALL mode)

New client-visible field, `scopeOwnerId: string | null`, added to `CrmInitialData`
(`lib/data-loader.ts`, set from `scope.scopeOwnerId`) and threaded into `CrmProvider`
(`src/store/crm.tsx`), updated on every refetch exactly like `repVisibility`. A derived
`isScopedMember = scopeOwnerId !== null` is what every gate below reads — never a role-based
guess re-derived in the UI, so the UI can never show something more permissive than what the
server actually enforced for this exact request.

- **Dashboard** (`Dashboard.tsx`): the Task workload "Mine"/"Team" segmented toggle is hidden for
  a scoped Member (`taskScope` already defaults to `'mine'`, so hiding it needs no force-override).
- **Pipeline** (`Pipeline.tsx`): the "All owners" select and the "All deals"/"My deals" segmented
  toggle are both hidden for a scoped Member.
- **Tasks** (`Tasks.tsx`): the "My tasks"/"Team tasks" toggle and the "All assignees" select are
  both hidden.
- **Leads** / **Contacts** (`Leads.tsx`, `Contacts.tsx`): their "All owners" filter selects are
  hidden.
- **Reports leaderboard** (`Reports.tsx`): `owners` (the full roster) is filtered down to just
  `currentUser` for a scoped Member before computing rows — previously every teammate still got a
  row showing $0/0, which reads as "they won nothing" rather than the truth ("you can't see their
  numbers"); now there's just the viewer's own row.
- **TaskRow redacted-parent chip**: `lib/data/tasks.ts`'s `redactOutOfScopeParent` now always
  returns an explicit `relatedToRedacted: boolean` (previously a redacted parent and a genuinely
  standalone task were indistinguishable to the client — both just had `relatedTo: undefined`).
  Threaded through `mapTask`/`Task` (`lib/mappers.ts`, `src/data/types.ts`). `TaskRow.tsx` renders
  a muted `Badge` reading "Restricted record" in place of the parent link when this is true.
- **Skipped "completed" activity on a redacted parent**: `toggleTask` in `src/store/crm.tsx` now
  skips creating the "completed X" activity entirely (not just without a subject link) when
  `task.relatedToRedacted` is true — logging even a subject-less version would misrepresent an
  event whose real context the viewer can't see as if it had none.
- **Companies / company picker**: confirmed unchanged by design and already correct from Stage
  1a — `Companies.tsx` and `CompanyPicker.tsx` both read from the client's already-loaded
  `useCrm().companies`, whose `_count` rollups already come from `listCompanies(scope.orgId, {
  scopeOwnerId: scope.scopeOwnerId })`. Company *names* stay shared/org-wide (confirmed: every
  company is still pickable), only the rollup counts are scoped (confirmed: see the live numbers
  below).
- **Sidebar counts**: confirmed unchanged by design — every count (`newLeads`, `overdueTasks`,
  `openTasks`, `closingSoon`, `champions`) is derived purely from the client's `leads`/`tasks`/
  `deals`/`contacts` arrays, which are already server-scoped. No code change was needed; this was
  already correct by construction once Stage 1a scoped the data loader.
- **Settings confirmation copy, written but not rendered**: new
  `src/components/common/repVisibilityConfirmCopy.ts` — `REP_VISIBILITY_ENABLE_CONFIRM` /
  `REP_VISIBILITY_DISABLE_CONFIRM` title/body/confirm-label text, for whoever wires the real
  Settings switch in Stage 1c. Deliberately not imported or rendered anywhere yet — the switch
  itself stays completely hidden, satisfying "no user-visible change" for every current org.

### Live verification: Nexo Verified Org flipped to OWN, walked as Member then Admin, restored

Flipped `Organization.repVisibility` to `'OWN'` directly via Prisma for the real dev org
("Nexo Verified Org", id `cmui9z4s60005f8g8w9tchde5` — test-only, reverted at the end). Jordan
Ellis (a real Member) owns 2 leads / 1 contact / 0 deals / 0 tasks there, against org totals of
13 / 12 / 10 / 8 — a large enough gap that any leak would have been obvious. Minted fresh Clerk
sign-in tickets and drove a real headless browser through every surface named above, plus
`/payments`, the command palette, and both `GET /api/crm-refetch`/`GET /api/activities` read
directly from the signed-in browser session (not just clicking through pages).

**32/32 checks passed.** What each role actually saw:
- **As Jordan (Member, scoped)**: Dashboard, Pipeline, Tasks, Leads, Contacts all loaded with
  every toggle/filter listed above absent. `GET /api/crm-refetch` returned exactly 2 leads / 1
  contact / 0 deals / 0 tasks (matching Jordan's own rows, not the org's 13/12/10/8), with
  `repVisibility: "OWN"` and `scopeOwnerId` set to Jordan's own id — but `companies` (15) and
  `owners` (4) came back as the full, unscoped sets, confirming those stay shared by design.
  Companies and Reports pages loaded without error. Settings showed no visibility-switch text.
  `/payments` stayed unreachable (pre-existing, role-based, unrelated to this stage). The command
  palette opened and searched without error.
- **As the real Admin, same OWN-mode org**: Dashboard's "Team" toggle, Pipeline's "All owners"
  filter and "All deals"/"My deals" toggle, and Tasks' "Team tasks" toggle were all still present.
  `GET /api/crm-refetch` returned the full 13 leads with `scopeOwnerId: null` — an Admin stays
  completely unrestricted even once the org itself is in OWN mode, exactly per `computeScopeOwnerId`'s
  two-source rule.
- Restored `Organization.repVisibility` to `'ALL'` for this org immediately after — confirmed via
  a direct read afterward.

### Test total: 265/265 (248 pre-existing, net +17: 3 new in `action-route-matrix.test.ts`, 7 new
in `scope-required.test.ts`, 8 new role-rule tests in `cross-tenant.test.ts`, minus the 1
`getCompanyDetail` test removed along with the deleted function). `tsc --noEmit` and `next build`
both clean.

**No Stage 1c (the actual Settings switch) started** — waiting for go-ahead.

## Stage 1a verification report + pg_trgm drift fixed permanently (Oct 23 2026)

Requested before starting Stage 1b: an evidence-backed report on Stage 1a's five claims, plus a
permanent fix for the pg_trgm migration-drift trap flagged (but not fixed) in Stage 0 commit 3.
**No Stage 1b (UI gating) work started.**

### Part 1 — Stage 1a report, with evidence

**1. First run of the existing suite after `Scope` was threaded through, before any OWN-mode
behavior existed.** `tests/integration/own-mode.test.ts` did not exist yet at this point — only
`lib/data/*.ts`, `lib/actions/crm.ts`, `lib/actions/payments.ts`, `lib/data-loader.ts`, and both
routes had been changed. Captured output:
```
 Test Files  10 passed (10)
      Tests  215 passed (215)
   Start at  21:49:08
   Duration  439.44s (tests 99%)
```
215/215, same total as before Scope was threaded through at all — the required checkpoint.

**2. How the OWN-mode matrix is generated, demonstrated live.** `own-mode.test.ts` builds a
`covered` set from three explicit object literals — `SCOPED_MUTATION_ACTIONS` (9 entries),
`SCOPED_CREATE_ACTIONS` (3 entries), and `EXEMPT_ACTIONS` (14 entries, each with a one-line
reason) — then asserts it against `Object.keys(actions).filter(k => typeof actions[k] ===
'function')`, i.e. every real function export of `lib/actions/crm.ts` (26 actions today). This
covers every server action in the file and, transitively, both route handlers (`GET
/api/crm-refetch`, `GET /api/activities`) since they're exercised by name in separate describe
blocks, not folded into this count.

Demonstrated by temporarily adding a 27th export to `lib/actions/crm.ts`:
```ts
export async function dummyDemoAction() {
  return null
}
```
Running just the exhaustiveness test:
```
 ❯ lib/actions/crm: OWN-mode matrix is exhaustive over every exported action (1)
   × every export is covered by the mutation matrix, the creation matrix, or an explicit exemption
AssertionError: expected [ 'dummyDemoAction' ] to deeply equal []
- []
+ ["dummyDemoAction"]
```
It fails immediately, naming the exact uncovered export. Removed the dummy
(`git diff --stat lib/actions/crm.ts` showed empty afterward — confirmed no trace left), reran the
same test: 1 passed.

**3. The two items "not enforced exactly as planned," verbatim from the Stage 1a report:**
> - **Task-activity ownership on edit** wasn't in the original plan explicitly: when `updateTask`
>   writes its "edited" activity and the task has a `relatedTo` subject, `Activity.ownerId` is set
>   to that subject's *current* owner (queried fresh inside the transaction), not the task's own
>   assignee — consistent with every other activity's "denormalized from the subject" rule, but
>   this required one extra query inside `updateTask`'s transaction that wasn't in the original
>   sketch.
>   **Risk**: none identified beyond the extra round trip itself — it's strictly more correct than
>   the alternative (stamping the assignee), and the extra query is the same shape as the one
>   already added to every other reassignment path.
> - **One flaky transaction timeout, not a logic bug**: the reassignment test's `updateContact`
>   call (`findFirst` → `update` → `cascadeActivityOwner` → `activity.create`, all in one
>   transaction) occasionally hit Prisma's default 5000ms interactive-transaction timeout on a cold
>   Neon connection in this dev environment (confirmed by re-running: failed once at 9.4s elapsed
>   cold, passed immediately after on a warm connection).
>   **Risk**: real, but environment-dependent, not logic-dependent — every multi-step write
>   transaction in this app (not just the ones touched in Stage 1a) is one extra round-trip away
>   from this same timeout under slow-connection conditions. Re-confirmed present in this session:
>   the full combined suite (`own-mode.test.ts` + the pre-existing suite) passed cleanly end to end
>   on both full runs this session, with no recurrence — consistent with "cold-connection-only,"
>   not a reliably reproducible failure. **Not fixed** — raising Prisma's `maxWait`/`timeout` or
>   restructuring these transactions needs the user's sign-off, since it's a cross-cutting change,
>   not scoped to Stage 1a's files.

**4. Reassignment and conversion, test results.** Both pass; evidence from this session's full
run of `own-mode.test.ts` (33/33):
- `Reassignment: the former owner loses visibility across loadCrmData, crm-refetch, and GET
  /api/activities` — reassigns a contact from repA to repB via `updateContactAction`, then,
  still logged in as repA: `loadCrmData` excludes the contact, the live `GET /api/crm-refetch`
  response excludes it, and `GET /api/activities` for that contact 404s.
- `convertLeadToDeal: the owner-move-on-convert path (reachable only by an unscoped caller)` —
  new test, added for this report (not present in the original Stage 1a commit). Logs in as a
  real Admin in the same OWN-mode org (the only way to reach `input.ownerId !== lead.ownerId` at
  all — a scoped Member's `convertLeadAction` is restricted to converting to themselves, already
  covered by the scoped-creation-equivalent rejection in the mutation matrix), converts repA's
  lead to repB, and asserts: the lead's own `ownerId` moved to repB, a pre-existing activity on the
  lead cascaded to repB's `ownerId`, the new contact is owned by repB, the new "converted..."
  activity is owned by repB, and — switching back to repA — the converted lead no longer appears
  in repA's own `loadCrmData`.

**5. Red-team pass — as a scoped Member, every path tried:**
- **By-id actions** (updateLead/Contact/Deal/Task, setLeadStatus, moveDeal, toggleTask, deleteTask,
  convertLead) — rejected, matrix-proven.
- **Creation with another rep's `ownerId`** (createLead/Contact/Deal) — rejected, matrix-proven.
- **Lists** (leads/contacts/deals/tasks/activities) — zero out-of-scope rows, proven.
- **Search** — added a new test this session (`listLeads' search param still excludes another
  rep's matching record`): two leads sharing the term "Zephyr," one per rep — the scoped search
  returns only the caller's own match. `contacts.ts`/`deals.ts` use the identical
  `scope.scopeOwnerId ? {ownerId} : ownerId ? {ownerId} : {}` where-clause shape for their own
  `search` option, proven once directly for leads and not independently re-tested for the other
  two, since the enforcement is the same code pattern, not a separately-derived one.
- **Aggregates** — added a new test this session: `getPipelineTotals` (the one real aggregate
  query in the app, currently unused by any screen) counts only the scoped caller's own deals per
  stage, confirmed against two reps' deals in the same stage.
- **Export (CSV)** — traced, not independently tested: `exportCsv()` (`src/lib/utils.ts`) runs
  entirely client-side over whatever `useCrm()` already holds, which comes from `loadCrmData`
  (already scoped). There is no separate server-side export endpoint — nothing to attack
  independently of the already-scoped initial load.
- **Command palette** — same reasoning: indexes the client's already-loaded (already-scoped)
  state; no separate query.
- **`GET /api/activities` / `GET /api/crm-refetch`** — scoped, proven (including the 404-on-
  another-rep's-subject case and the reassignment test above).
- **Every other API route** — `app/api/webhooks/clerk/route.ts` is the only other route in the
  app; it's Clerk's own webhook, not reachable by an in-app caller with a session at all, and
  carries no record-by-id path.

**One real latent gap found, not exploitable today but worth flagging for 1b:**
`getCompanyDetail(orgId, id, scopeOwnerId?)` (`lib/data/companies.ts`) defaults to **unscoped**
nested `leads`/`contacts`/`deals` arrays when its optional third parameter is omitted — unlike
every other scoped function in this app, which fails toward "more restrictive" by default, this
one fails toward "show everything" when a caller forgets the parameter. It is **not reachable by
any real request today** — grepped the whole repo; its only callers are `lib/data-loader.ts`
(which doesn't call it; it calls `listCompanies` instead) and the test suite. It exists for the
Company detail screen, which currently reads its data from the client's already-loaded (already
-scoped) state rather than calling this function directly. Flagging rather than fixing
unprompted, since it's dead code in production right now and changing its default signature is a
design call, not a bug fix — worth deciding explicitly before or during 1b, whenever a real
caller for this function is wired up.

### Part 2 — pg_trgm migration drift, fixed permanently

Checked directly: Prisma 6.19.3 (this repo's installed version) supports declaring a GIN index
with the `gin_trgm_ops` operator class natively in `schema.prisma` — `extendedIndexes` is no
longer preview-gated at this version, confirmed by `prisma validate` accepting the syntax with no
`previewFeatures` entry needed for it. `postgresqlExtensions` (for declaring the `pg_trgm`
extension itself) is still preview-gated and needed `previewFeatures = ["postgresqlExtensions"]`.

Added to `prisma/schema.prisma`:
```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}
datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [pg_trgm]
}
```
and, on `Lead`/`Contact`/`Deal`/`Company`, the exact six indexes the raw-SQL migration
(`20261023110512_pg_trgm_search_indexes`) already created, each pinned with an explicit `map:` to
the index name that migration gave it (so Prisma recognizes them as the *same* index, not a
same-purpose duplicate to create alongside the old one):
```prisma
@@index([name(ops: raw("gin_trgm_ops"))], type: Gin, map: "leads_name_trgm_idx")
@@index([email(ops: raw("gin_trgm_ops"))], type: Gin, map: "leads_email_trgm_idx")
// ...and the matching one/two per model on Contact, Deal, Company
```

**Verified, in order:**
1. `npx prisma validate` — valid.
2. `npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script` → `-- This is an empty migration.` (zero drift, either direction).
3. `npx prisma migrate status` → `Database schema is up to date!`
4. `npx prisma migrate dev --name trgm_declared_in_schema` → `Already in sync, no schema change or pending migration was found.` — no new migration file was even created, because none was needed; the DB already physically has these indexes, this change only makes `schema.prisma` describe reality correctly.
5. `npx prisma generate` and `npx tsc --noEmit` both clean after regenerating the client.

The original raw-SQL migration file is untouched (migration history is never rewritten). The
"must stay" warning comment in the follow-up migration
(`20261023161534_org_timezone_configured_flag`) is now historical — the drift it warned about
can't recur, since `schema.prisma` and the database agree.

### Test total: 248/248 (215 pre-existing, unchanged + 33 in `own-mode.test.ts` — 30 from the
original Stage 1a commit + 3 added for this report: the search-scoping test, the
`getPipelineTotals` aggregate test, and the conversion owner-move test)

`tsc --noEmit` clean. **Still waiting for go-ahead on Stage 1b** — not started.

## Scale/visibility redesign, Stage 1a of 11 (data-layer + action enforcement, OWN-mode test matrix — still no UI change) (Oct 23 2026)

Per the approved plan: `Scope` replaces the bare `orgId` on every exported function in
`lib/data/{leads,contacts,deals,tasks,activities}.ts` and every server action in
`lib/actions/crm.ts`, with ALL-mode behavior (`scopeOwnerId: null`) required to stay byte-for-byte
unchanged before any OWN-mode-specific code or test was added — proven by running the full
pre-existing suite (215/215) immediately after the threading was done and before writing a single
new test. **`repVisibility` still defaults to `ALL` for every org; nothing in this commit is
reachable or visible to a real user yet** — that's Stage 1b (UI gating) and the Settings switch
after it.

### What changed

- **Inlined `where`-clause scoping, no new `isInScope`-style helper.** Every scoped read/write adds
  `...(scope.scopeOwnerId && { ownerId: scope.scopeOwnerId })` (or, for list filters,
  `scope.scopeOwnerId ? { ownerId: scope.scopeOwnerId } : ownerId ? { ownerId } : {}` so a scoped
  caller's own id always wins over any free-form filter param). An out-of-scope id is rejected via
  the exact same `findFirst → null → throw "not found"` path already used for a cross-tenant id —
  no new rejection code path to keep in sync with the old one.
- **`Activity.ownerId` wired at every creation site** (inline creates in `createLeadAction`/
  `createContactAction`/`createDealAction`, `logActivityAction`/`addNoteAction` via
  `assertSubjectInScope`'s returned subject, and every `updateX`'s "edited" activity), and kept in
  sync on reassignment by a new shared helper, `cascadeActivityOwner(tx, subjectField, subjectId,
  newOwnerId)` in `lib/data/activities.ts` — called inside the same transaction as the `ownerId`
  change in `updateLead`, `updateContact`, `updateDeal`, and `convertLeadToDeal` (which also moves
  the lead's own `ownerId` to match the new contact/deal's owner when they differ, cascading the
  lead's existing activities too — reachable only by an Admin or in an ALL-mode org, since a scoped
  Member can only ever convert to themselves).
- **`Task.createdById` wired at creation** (`addTaskAction` connects it to the caller). Task
  visibility for a scoped Member is "assigned to them OR created by them"
  (`taskVisibilityWhere` in `lib/data/tasks.ts`) — the one list in the app that isn't a plain
  `ownerId` gate. Task **assignment stays unrestricted even when scoped** (a Member can hand a task
  to any teammate) — only who can *see* it afterward is gated.
- **Redacted task parents + no writes to out-of-scope parents**: `listTasks`/`getTaskById` null out
  `relatedToType`/`relatedToLabel`/`leadId`/`contactId`/`dealId` when the parent's *current* owner
  isn't the scoped caller (the task itself can still pass its own assignee-or-creator visibility
  check independently of who owns its parent). `updateTask` still updates the task's own fields in
  that case, but skips writing the attached "edited" activity onto a parent the caller doesn't own.
- **Companies kept deliberately narrow, per the approved design**: company identity (name,
  website, industry, notes) stays org-wide and unscoped — shared company names are not per-rep
  data — but `listCompanies`/`getCompanyDetail` gained an optional `scopeOwnerId` parameter (not a
  full `Scope`, since companies.ts was explicitly excluded from the Scope-replacement list) that
  narrows the `_count`/nested leads/contacts/deals to just the caller's own records.
  `getContactByEmail` deliberately still searches the *whole* org regardless of scope — email
  uniqueness is an org-level invariant, not a per-owner one — but takes `Scope`, not a bare
  `orgId`, for structural consistency with every other function in `contacts.ts`.
- **The two-source role rule** (`computeScopeOwnerId` from Stage 0) is now actually exercised:
  every `requireAuth()`/`resolveAuth()` call already computed `scopeOwnerId`; this stage is what
  makes every downstream read/write actually use it.
- **`GET /api/activities`**: the subject lookup (`getLeadById`/`getContactById`/`getDealById`) is
  now the scoped-by-id read — a subject owned by another rep 404s identically to a cross-tenant
  one. Once that passes, every activity attached to it is already known to share its current owner
  (the cascade above), so no second scope filter is needed on the activities query itself.
  **`GET /api/crm-refetch`** and `loadCrmData` (the `(app)` layout's first load) both now take a
  `Scope` built from `requireAuth()`'s own `scopeOwnerId`.
- **Owner rules for Members, enforced in `lib/actions/crm.ts`**: `assertOwnerInScope()` rejects
  `createLeadAction`/`createContactAction`/`createDealAction`/`convertLeadAction` when the
  client-supplied `ownerId` isn't the scoped caller's own. Reassignment (editing an *existing*
  record's owner to someone else) is deliberately **not** restricted by this — only creation — and
  the data layer's own scoped `findFirst` already guarantees a scoped Member can only be
  reassigning a record they currently own.

### The generated OWN-mode test matrix (`tests/integration/own-mode.test.ts`, new file)

Built by iterating `Object.keys(actions)` against three explicit buckets — a **scoped-mutation**
matrix, a **scoped-creation** matrix, and an **exempt list with a one-line reason each** — then
asserting every real export of `lib/actions/crm.ts` falls into exactly one bucket. A newly added
action that isn't placed in one of the three fails that exhaustiveness test immediately, rather
than silently shipping without OWN-mode coverage.

- **Scoped-mutation matrix (9 actions)**, each called with another rep's record id while logged in
  as a scoped Member, asserted to reject like a cross-tenant id: `setLeadStatusAction`,
  `convertLeadAction`, `updateLeadAction`, `updateContactAction`, `updateDealAction`,
  `moveDealAction`, `toggleTaskAction`, `updateTaskAction`, `deleteTaskAction`.
- **Scoped-creation matrix (3 actions)**, each called with another rep's id as the target
  `ownerId`, asserted to reject: `createLeadAction`, `createContactAction`, `createDealAction`.
- **Directly tested outside the generated matrix** (different shape — a `subject`, not a bare
  record id): `logActivityAction` and `addNoteAction`, via `assertSubjectInScope`.
- **Exempt, with reasons recorded in the test file itself**: `createCompanyAction`/
  `updateCompanyAction`/`deleteCompanyAction` and `createStageAction`/`renameStageAction`/
  `reorderStageAction`/`deleteStageAction` (companies and stages are shared/org-wide, never
  per-owner); `inviteMemberAction`/`updateProfileAction`/`updateOrgTimezoneAction`/
  `updateQuotaAction`/`updateCurrencyAction` (org-level or caller's-own-profile, not a scoped CRM
  record); `addTaskAction` (assignment is unrestricted even when scoped, by design).
- **Lists/loaders/aggregates**: `listLeads`, `listContacts`, `listDeals`, `listTasks`,
  `listActivities`, and `listCompanies`' scoped rollup `_count` all asserted to return zero
  out-of-scope rows/counts for a scoped Member, against a real two-Member OWN-mode org fixture.
  `loadCrmData` and `GET /api/crm-refetch` asserted the same, end to end.
- **Reassignment test**: reassigns a contact from the (scoped) caller to a teammate via
  `updateContactAction`, then — still logged in as the *former* owner — asserts `loadCrmData`, `GET
  /api/crm-refetch`, and `GET /api/activities` (404) all show nothing of that contact anymore.

### Anything that couldn't be enforced exactly the planned way

- **Task-activity ownership on edit** wasn't in the original plan explicitly: when `updateTask`
  writes its "edited" activity and the task has a `relatedTo` subject, `Activity.ownerId` is set to
  that subject's *current* owner (queried fresh inside the transaction), not the task's own
  assignee — consistent with every other activity's "denormalized from the subject" rule, but this
  required one extra query inside `updateTask`'s transaction that wasn't in the original sketch.
- **One flaky transaction timeout, not a logic bug**: the reassignment test's `updateContact` call
  (`findFirst` → `update` → `cascadeActivityOwner` → `activity.create`, all in one transaction)
  occasionally hit Prisma's default 5000ms interactive-transaction timeout on a cold Neon
  connection in this dev environment (confirmed by re-running: failed once at 9.4s elapsed cold,
  passed immediately after on a warm connection). Not something to paper over with a longer
  timeout without the user's sign-off — flagged here as a known, environment-dependent flake, not
  fixed in this commit.

### Test total: 245/245 (215 pre-existing, unchanged + 30 new in `own-mode.test.ts`)

`tsc --noEmit` clean across the whole repo. The pre-existing suite was run and confirmed
215/215 passing *before* `own-mode.test.ts` was written, per the required checkpoint, then the
full 245 run again after.

### Next (1b): UI gating — waiting for go-ahead

Sidebar counts/toggles/owner filters closing per the design, still with `repVisibility` staying
`ALL` for every real org (so still nothing user-visible changes) until the Settings switch after
that. Not started.

## Stage 0 follow-up: a real regression found and fixed, four other points verified with evidence (Oct 23 2026)

**1. Org timezone default — real regression, found and fixed.** Checked every call site: before
commit 2's timezone work, Dashboard/Reports/Sidebar ran entirely client-side with plain
`new Date()` — the *browser's* local zone, whatever that happened to be, for every viewer. After
commit 2, those same call sites read `Organization.timezone`, which defaults to `"UTC"` for every
org that existed before this feature shipped (none has ever saved one). That is a real, silent
behavior change for any org whose viewers aren't in UTC — confirmed directly: this dev
environment's own resolved zone is `Asia/Karachi` (UTC+5):
```
$ node -e "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)"
Asia/Karachi
```
Comparing the dev org's real deals under UTC vs. Asia/Karachi *right now* (Oct 23 2026) shows
**no numeric difference** for won-this-month/closing-in-30-days/quota — simply because none of
its 10 deals' close dates happen to fall inside the ~5-hour disagreement window between the two
zones at this exact moment. That's not the same as "no bug": it's data-dependent and latent,
exactly the kind of thing that passes review and then breaks for a real customer near a boundary
— which is exactly what the golden tests in `tests/unit/time-periods.test.ts` already prove
happens in general (constructed cases where UTC and Karachi/New_York genuinely disagree on the
day/month/quarter).

**Fixed**, per the instructed rule — until an admin sets it, keep the previous (viewer's-zone)
behavior, never silently shift anyone's boundaries:
- New `Organization.timezoneConfigured` (`Boolean @default(false)`) — the only way it ever
  becomes `true` is `updateOrgTimezoneAction` actually being called by an admin.
  `Organization.timezone` itself is unchanged (still defaults to `"UTC"`), but is now documented
  as untrustworthy until that flag is true.
- `lib/timezones.ts`'s new `resolveOrgTimezone()`: returns the stored org zone once configured,
  otherwise the *viewer's own* resolved zone (their `Owner.timezone`, or the browser's if that's
  unset too) — the exact behavior every org had before `Organization.timezone` existed.
- `CrmProvider` exposes `effectiveOrgTimezone` (the resolved value) alongside the raw
  `orgTimezone`/`orgTimezoneConfigured` — Dashboard, Reports, and Sidebar now all read
  `effectiveOrgTimezone` for every org-wide calculation instead of the raw stored value.
- Settings → Workspace now shows a visible **"Set your workspace time zone"** prompt to admins
  (not just a quiet pre-filled input) whenever `orgTimezoneConfigured` is false, explicitly
  naming which numbers are affected.
- Tests: `tests/unit/resolve-org-timezone.test.ts` (the fallback logic) +
  `tests/integration/cross-tenant.test.ts` (new `updateOrgTimezoneAction` sets the flag,
  admin-only, scoped, rejects an invalid IANA id). **Live-verified** (Playwright, browser
  timezone forced to Asia/Karachi): the Settings prompt renders, pre-filled with
  `Asia/Karachi` (not `UTC`), for the real dev org, which has never configured one.

**2. Existing Owner.timezone values — confirmed, null never becomes UTC.** Before the commit-2
migration (captured live at the time): `{ null: 26, "Eastern Time (US & Canada)": 1 }`, DB-wide.
Now: `{ null: 30, "America/New_York": 1 }` — the null count grew only because later test runs
created more owner rows (synthetic org, fixtures), not because anything got nulled; the one
mapped legacy value migrated correctly and nothing new has appeared. **`"UTC"` has never once
appeared as an `Owner.timezone` value** — confirmed directly in that distribution — because the
column has no DB-level default at all (nullable, no `@default`), and every runtime read of it
(Dashboard/Sidebar/Settings) falls back to `resolveBrowserTimezone()` on `null`, never to the
string `"UTC"`.

**3. Date semantics — documented exhaustively.** `lib/timePeriods.ts`'s module doc comment now
lists every `DateTime` column in `prisma/schema.prisma` by name, classified as a calendar date
(`Task.dueDate`, `Payment.dueDate`, a still-open `Deal.closeDate`) or an instant (every
`createdAt`/`updatedAt`, `Lead.lastTouchedAt`, `Contact.lastInteractionAt`, `Payment.paidAt`,
`Activity.at`, and `Deal.closeDate` once Won/Lost) — including exactly how `closeDate` changes
kind: an expected date while the deal is open, stamped to "now" by `closeDateOnStageChange`
(`lib/data/deals.ts`) the moment it enters a closed stage, after which it's a real instant. This
lives in the code, not just here, so it stays next to the functions it governs.

**4. pg_trgm — re-confirmed, fresh EXPLAIN against the synthetic org:**
```
-- BEFORE (index dropped)
Seq Scan on contacts (actual time=0.612..39.977 rows=513) Rows Removed by Filter: 9806
Execution Time: 40.093 ms

-- AFTER (index restored)
Bitmap Heap Scan on contacts (actual time=0.096..0.430 rows=513)
  -> Bitmap Index Scan on contacts_name_trgm_idx (actual time=0.066..0.066 rows=513)
Execution Time: 0.479 ms
```
Yes — confirmed using the trigram index (`Bitmap Index Scan on contacts_name_trgm_idx`), ~84x
faster this run (cold-buffer "before," which is the realistic worst case). **Found and fixed a
related latent trap while re-verifying**: because the trigram indexes were created via raw SQL
(not represented in `schema.prisma`), the very next `prisma migrate dev` wanted to silently
**drop all six of them** as "drift" — caught before applying, stripped from the new migration
(see the follow-up fix's own migration file, `20261023161534_org_timezone_configured_flag`, for
the note). This is a standing trap for every migration from now on until these indexes are
represented natively (Prisma's `postgresqlExtensions` preview feature) — flagged as a real,
unresolved risk, not fixed in this commit.

**5. Cache security — confirmed, and a Stage 2 gate recorded.** The existing
`tests/unit/query-cache-security.test.ts` "end to end against a real QueryClient" block already
seeds the cache by hand before testing (`client.setQueryData(['payments', ...], [...])`,
`['dashboard-aggregates', ...]`, `['leads', ...]`) — not an empty cache — then asserts `clear()`
empties all of it. **Stage 2 gate, recorded here**: before Stage 2 (Tasks — the first screen to
populate this cache with real data) is considered complete, rerun the live demotion check against
the real cache — demote a real admin with the tab open, confirm no payment data remains in it —
the same check already done against `requirePaymentAccess()` and `GET /api/crm-refetch`, now
against the TanStack Query cache specifically, with real query data to lose for the first time.

**Test total: 215/215** (207 + 8 new: 4 `resolveOrgTimezone` unit tests, 4
`updateOrgTimezoneAction` integration tests). `tsc --noEmit`, `next build`, and a live Playwright
check (forced browser timezone, real dev org, real Settings page) all clean.

## Scale/visibility redesign, Stage 0 of 11 (foundation, no user-visible behavior change except one) (Oct 23 2026)

Full design (Part A: per-org record visibility; Part B: scale — pagination, SQL aggregates,
TanStack Query, timezones, measurement) is in the design discussion preceding this entry in the
session log, approved with revisions across three rounds. This entry covers Stage 0 only — three
separate commits, each its own test run, as instructed. **Nothing in Stage 0 enforces visibility
scoping or changes how any screen loads its data** — that starts at Stage 1. The one real,
user-visible change is the Settings timezone picker (below).

### Commit 1 — `657b812`: Scope type, schema, requireAuth computing scope (no behavior change)

- `RepVisibility` enum + `Organization.repVisibility` (default `ALL`).
- `Activity.ownerId` and `Task.createdById`, both nullable — no write path populates them yet (a
  `NOT NULL` constraint today would break every current create/activity-log call), backfilled
  once for existing rows from their subject/assignee.
- `lib/scope.ts`: the `Scope` type and `computeScopeOwnerId()` — the same fail-closed, two-source
  rule `requirePaymentAccess()` already uses (null only when the DB role AND the live session
  both say Admin; otherwise scoped).
- `requireAuth()`/`resolveAuth()` both compute `scopeOwnerId` now. Always `null` today (every org
  defaults to `ALL`); nothing reads it yet.
- **Test total: 180/180.**

### Commit 2 — `e93bbeb`: named helpers extracted; real IANA timezones end to end

- Behavior-preserving extraction: `weightedValue`, `isTaskOverdue`, `isTaskDueToday`,
  `isClosingSoon` replace their inline duplicates in Dashboard/Sidebar/Pipeline — one definition
  each instead of two copies that could silently drift apart.
- **Timezone redesign** (the one user-visible change in Stage 0):
  - **Owner.timezone** is now a real IANA zone id, picked from a searchable dropdown
    (`Intl.supportedValuesOf('timeZone')`, ~400 entries, filtered as you type) — not the old
    4-option free-text list (`"Pacific Time (US & Canada)"` etc.).
  - Existing values migrated via a one-time static map (the 4 old labels → their IANA
    equivalents); anything that doesn't map stays `null`, and Settings prompts for it (pre-filled
    with the browser's own resolved zone, confirm-and-save) rather than silently defaulting to UTC.
  - New **Organization.timezone** (default `"UTC"`, admin-editable in Settings → Workspace,
    pre-filled with the admin's browser zone while still at that untouched default).
  - `lib/timePeriods.ts` (new): `isThisMonth`, `isMonthsAgo`, `monthlyWonRevenue`,
    `isClosingSoon`, `isTaskOverdue`, `isTaskDueToday`, and a new `isInCurrentQuarter` all take an
    explicit timezone now. **Org-wide business periods** (won this month, quota progress, monthly
    charts, MoM, closing in 30 days) use `Organization.timezone`; **personal day boundaries**
    (task overdue/due today) use the viewer's own `Owner.timezone`. `dayDelta` itself
    (`src/lib/utils.ts`) stays zone-naive — every other, unnamed use of it (relative-time labels,
    the generic "due in Nd" text, payment overdue/awaiting-milestone, stalled-deal detection)
    wasn't named in the policy and wasn't touched; `Payment.dueDate`'s overdue check is a known
    open item for whenever the Payments stage lands.
  - Golden boundary tests (`tests/unit/time-periods.test.ts`) prove genuine disagreement at day,
    month, and quarter boundaries for Asia/Karachi and America/New_York (including a DST-season
    case), computed from real ground truth (`Intl.DateTimeFormat`), not hand-derived arithmetic —
    the first draft of these tests had the comparison direction backwards in three places until
    verified against actual `Intl` output.
  - Every date column's nature (calendar date vs. instant) is documented directly in
    `lib/timePeriods.ts`'s own doc comment, including `Deal.closeDate`'s dual nature (an expected
    date while open; an instant once stamped Won/Lost).
- **Test total: 195/195.** Live-verified: the searchable timezone picker and the new workspace
  timezone field, in a real browser.

### Commit 3 — `b0044e1`: TanStack Query infrastructure, query-cache security, pg_trgm, P2002

- `@tanstack/react-query` added and wired (`QueryProvider`) — **no screen uses it yet**; Stage 2
  (Tasks) is the first real query.
- `lib/queryKeys.ts`: every future query key is built here, always `[entity, orgId, scopeOwnerId,
  ...]` — "query keys include the orgId and the viewer's scope" by construction, not convention.
- `QueryCacheSecurityGuard` (rendered inside `CrmProvider`): clears the **entire** QueryClient
  cache — never a targeted subset — on an org switch, sign-out, or any change in role,
  `repVisibility`, or payment access. No persistence anywhere (no localStorage/sessionStorage/a
  persist plugin). Found and fixed a real pre-existing gap while wiring this: `CrmProvider`'s own
  `orgId` prop was received but never actually used anywhere — needed it for the guard's
  org-switch check, so it now actually flows through. `repVisibility` threads through the data
  flow too now (always `"ALL"` today, same treatment as `scopeOwnerId`).
- `pg_trgm` extension + trigram GIN indexes on every column `lib/data/*.ts`'s existing
  `contains`/insensitive searches already target (Lead/Contact name+email, Deal name, Company
  name). Confirmed against the synthetic org: `Seq Scan` (1.97ms) → `Bitmap Index Scan` via the
  new index (0.48ms) for `name ILIKE '%james%'` on 10,000 contacts — real EXPLAIN output, not
  estimated:
  ```
  -- before
  Seq Scan on contacts (actual time=0.013..1.926) Rows Removed by Filter: 9804
  -- after
  Bitmap Heap Scan on contacts (actual time=0.104..0.431)
    -> Bitmap Index Scan on contacts_name_trgm_idx (actual time=0.074..0.075)
  ```
- `vercel.json` added, pinning Vercel Functions to `iad1` — **no region was pinned before this**.
  Caveat: this sets the deploy config; I can't confirm from the repo alone what the live Vercel
  project's actual configured region is today, only that nothing in-repo was constraining it.
- P2002 handling: catches only a primary-key collision (`meta.target` includes `"id"`) across
  every create path and every activity-id-accepting update, converting it to one uniform `"Could
  not create record"` error — explicit application code now, not an accident of Next's
  production-only error redaction (which wouldn't hold in dev mode or off a future plain API
  route). Every other unique-constraint violation (duplicate email, etc.) is untouched. Verified:
  the same id colliding within one org and across two different orgs fails identically — no
  existence leak.
- **Test total: 207/207.** `tsc --noEmit`, `next build`, and a full-app live smoke test (every
  screen, signed in as a real user, zero console/page errors) all clean.

### What changed for users, concretely

- **Settings → Profile → Time zone**: replaced with a searchable picker over real IANA zone ids
  instead of 4 generic labels. If it was never set, it's now pre-filled with your browser's zone —
  confirm or change it, then save.
- **Settings → Workspace**: new "Workspace time zone" field (admin-only to edit), defaulting to
  UTC, pre-filled with the admin's browser zone the first time it's opened. It explicitly says
  what it drives (won this month, quota progress, monthly charts, closing in 30 days) and that a
  Member's own time zone only affects their task due dates.
- Nothing else is visibly different — no new permissions, no new restrictions, no screen loads
  differently. `RepVisibility`/`scopeOwnerId`/TanStack Query are all present in the code but inert.

### Next stage (1): per-org record visibility, shipped dark then exposed last

Per the approved design: data-layer + action enforcement and the full OWN-mode test matrix first
(still no UI change — `repVisibility` stays `ALL` for every org while this lands), then the UI
gating (sidebar counts/toggles/owner filters closing per the design), and **only last**, once the
whole matrix passes, the Settings switch that lets an admin actually turn OWN mode on. Touches:
`lib/scope.ts` consumers added across `lib/data/{leads,contacts,deals,tasks,activities}.ts` and
`lib/actions/crm.ts` (every function gains a required `Scope` param), the lead-conversion
owner-reassignment cascade, the task-complete-redacted-parent guard, `GET /api/activities`
adopting `Scope`, and the OWN-mode cross-tenant test matrix in
`tests/integration/cross-tenant.test.ts`. Waiting for go-ahead before starting.

## Two follow-ups on GET /api/activities: a real de-dup bug fixed properly, status codes split (Oct 23 2026)

**1. De-duplication was content-based and had a real, confirmable bug.** Testing it directly: two
identical calls logged back to back (same kind/title/body, no note) both showed fine immediately
— but logging a *new* call when an *older*, already-fetched identical call existed on the record
made the new optimistic row silently vanish, because the merge matched on content
(`kind|actorId|title|body`) and the old persisted row already "claimed" that content. Fixed
properly rather than patched around: activities now get a client-generated id end to end, the same
pattern already used for leads/contacts/deals/tasks.

- `logActivityAction` and `addNoteAction` (`lib/actions/crm.ts`) now take an `id` param, validated
  with the same `assertClientId` used everywhere else, and save the row under that id
  (`lib/data/activities.ts`'s `logActivity`/`dbLogActivity` already accepted an optional `id` in
  its Prisma input — nothing to change there).
- Every other activity-creating action that embeds its own activity inline in a transaction —
  `createLeadAction`/`createContactAction`/`createDealAction` (the "created X" activity, plus the
  optional note on lead creation), `updateLeadAction`/`updateContactAction`/`updateDealAction` (the
  "edited" activity), `convertLeadAction` (the "converted X" activity), and `updateTaskAction` (the
  "edited" activity, when the task has a related subject) — now takes and uses a client id the
  same way.
- `src/store/crm.tsx`: every optimistic `Activity` the client creates now gets `newEntityId()`
  (a real UUID) instead of the old local counter (`nextId('a')`, now deleted along with the
  `sequence` variable — fully unused once every call site switched over), and every action call
  that creates an activity passes that same id through.
- `src/screens/RecordDetail.tsx`'s merge logic moved to a new, unit-tested pure function —
  `mergeTimeline()` in `src/store/activityTimeline.ts` (same "extract it so it's testable without
  a DOM harness" pattern as `livePoll.ts`/`persistRun.ts`) — and now de-dupes by id only.

**Tests**: `tests/unit/activity-timeline.test.ts` (new) covers both scenarios named in the report —
two identical activities back to back before either is persisted, and a new one logged against an
already-persisted identical one — plus a reload/collapse check and a stability check. An
integration test in `tests/integration/cross-tenant.test.ts` calls `logActivityAction` three times
with identical content and distinct client ids, then fetches the real route, confirming all three
rows exist distinctly server-side (not just in the client's merge logic). **Live-verified**: two
identical "Call" clicks on a real contact both showed immediately and survived a real page reload,
and a third identical call logged against the by-then-persisted pair was not swallowed.

**2. Status codes split: 401 only for a missing session, 404 for everything else.** Previously
`GET /api/activities` returned a uniform 401 for every failure, mirroring `crm-refetch`'s
philosophy — reasonable there (whole-org load, "fail quietly either way" is fine), but wrong here,
where 401 implies "your session expired" and a cross-tenant/nonexistent record is a different kind
of failure entirely. Now: a cross-tenant subject, a nonexistent one, or bad/missing params all
return 404 with no existence leak between them (still can't tell which); 401 is reserved for
exactly one case, `requireAuth()` throwing.
`app/api/activities/route.ts` splits into two `try/catch` blocks — one around `requireAuth()`
alone (→ 401), one around everything after it (→ 404) — so the status code is a direct function of
which stage failed, not a single catch-all.

The client (`useRecordTimeline` in `RecordDetail.tsx`) was checked and confirmed to have no
redirect or sign-out logic on any failure to begin with — a failed fetch here was already just a
silently-swallowed error, never anything that could tear down a session. What changed is the UI:
a failure (404 or otherwise) now surfaces an explicit "Couldn't load activity/notes" state with a
"Try again" button (`retry()` on the hook, which just re-runs the fetch), replacing the ambiguous
fallback to "No activity yet" that made a load failure look identical to genuinely-empty history.

**Tests**: the existing `GET /api/activities` describe block's status-code tests were split
accordingly — 401 only for no session; 404 for a cross-tenant subject, a nonexistent one (new
case), and bad/missing params; a new 404-specific `Cache-Control` test. **Live-verified**: fetching
a nonexistent subject id from a signed-in browser session returns 404 with the right header,
doesn't navigate away from the page, and the session (`window.Clerk.session`) is still intact
afterward — confirming structurally and empirically that this route failing is never what decides
a user is logged out.

All 174 tests pass (166 pre-existing + 5 new unit + 3 net-new integration). `tsc --noEmit` and
`next build` both clean.

## Fixed a live bug: record timelines were incomplete beyond the org's 50 most-recent activities (Oct 23 2026)

Found while measuring payload size for the scale/visibility design work (see the design
discussion below): `loadCrmData` calls `listActivities()` with no `limit`, which defaults to
`take: 50` — so the `activities` array every client holds is capped at the **50 most recent
activities org-wide**, not per record. `RecordDetail.tsx`'s Activity and Notes tabs filtered that
same capped, global array down to one record's subject id. Once an org has more than 50
activities total, any record whose own activity isn't among the org's 50 most recent *overall*
silently showed an incomplete or fully empty timeline — a real, live bug, not a scale concern for
later.

**Fix**: a dedicated endpoint for one record's own history, paginated with no cap.

- `GET /api/activities?subjectType=lead|contact|deal&subjectId=&cursor=` (`app/api/activities/route.ts`,
  new) — a Route Handler, not a Server Action, for the same measured reason `GET /api/crm-refetch`
  already is one (doesn't queue behind the Server Action dispatch queue). Same `requireAuth()`
  gating, same `Cache-Control: private, no-store` + `force-dynamic` as that route. The subject id
  is checked against the caller's org via the existing scoped by-id reads
  (`getLeadById`/`getContactById`/`getDealById`) — a cross-tenant or nonexistent subject gets the
  same uniform 401 as an unauthenticated request; nothing distinguishes "wrong org" from "doesn't
  exist" in the response, same philosophy as `crm-refetch`. Payment-kind activities are excluded
  unless `canAccessPayments()` (session-based, no live Clerk API call) says yes — same enforcement
  point `loadCrmData` already uses.
- `lib/data/activities.ts`: new `listActivitiesForSubject()` — real cursor pagination (`take`/`cursor`
  on `id`, ordered `at desc`), no cap, unlike `listActivities()` which stays exactly as it is (still
  powers the Dashboard's capped, org-wide recent-activity feed — that one is deliberately capped
  and wasn't touched).
- `RecordDetail.tsx`: Activity and Notes tabs now fetch from this endpoint (with a "Load more"
  button) instead of filtering the global capped array. Optimistic, locally-added rows (from
  `addNote`/`logActivity` — unchanged, still land in `CrmProvider`'s global `activities` state
  immediately) are merged in and shown right away, then de-duplicated against the fetched page
  once the real persisted row appears there — matched by content (`kind` + `actorId` + `title` +
  `body`), since the optimistic row's client-generated temp id and the server's real id are never
  the same value and nothing currently reconciles them.

**Tests** (`tests/integration/cross-tenant.test.ts`, new describe block): forced-dynamic, both
`Cache-Control` cases, 401 on no session, 401 on a cross-org subject id, 401 on a bad/missing
subject, a 120-activity record paginating correctly across pages with no row repeated or
reordered, a Member never receiving payment-kind activities on a deal's timeline, an admin
correctly receiving them. All pass — **166/166** total (157 pre-existing + 9 new).

**Live-verified** against the real "Nexo Verified Org": seeded 5 old (backdated) notes on an
existing contact, then flooded the org with 65 newer activities on *other* records — enough to
push those 5 old notes out of any naive "50 most recent org-wide" window, reproducing the exact
bug condition. Loaded that contact's page for real: the response is a real `200` with
`Cache-Control: private, no-store`, all 5 old notes render on both the Activity and Notes tabs, and
none of the 65 unrelated flood activities leaked onto this record's timeline. This test data (5 old
notes + 65 flood activities, clearly titled) is left in the dev org, per the task's own
instruction to create it there — delete it if the clutter matters.

## Feature audit (8 named features) + test-count reconciliation, resolved (Oct 23 2026)

**Feature audit** — checked against the real code and the running app, not PROGRESS.md:

| Feature | Status | Evidence |
|---|---|---|
| CSV import (column mapping, dedup, per-row errors) | **NOT BUILT** | `exportCsv` exists everywhere; no import path anywhere in `src/` — no file upload, no parser, no mapping UI |
| Contact tags/segments | **PARTIAL** | Display (`contact.tags`) and filter-by-tag (`?tag=`, used by the sidebar's "Champions" saved view) both work. Creating/assigning a tag does not: `addContactTag(orgId, id, tag)` exists in `lib/data/contacts.ts` but is never called from any server action or any UI — the "Add" tag button in `RecordDetail.tsx` has no `onClick` at all. No tag-taxonomy management (rename/delete a tag, see all tags in use) exists either. |
| Saved filter views | **NOT BUILT** | Sidebar's "Saved views" are 3 hardcoded links (`/leads?status=new`, `/pipeline?close=30`, `/contacts?tag=Champion`) with no save/create/delete affordance and no persistence model — not a feature a user can add to |
| Calendar view of tasks/follow-ups | **NOT BUILT** | No calendar route, component, or library anywhere in `src/` |
| Reminders for due/overdue tasks (in-app or email) | **NOT BUILT** | No email client (nodemailer/Resend/SendGrid), no cron/scheduled job, anywhere in `lib/`. The only "reminder" surface is the Settings Notifications toggles, now explicitly disabled + labeled "Coming soon" |
| Manager role; reps restricted to own records | **NOT BUILT** | `Owner.role` is an unconstrained `String`; `ownerRoleFromClerk()` (`lib/roles.ts`) only ever produces `'Admin' \| 'Member'`. `listLeads`/`listContacts`/`listDeals` all take an optional `ownerId` filter, but `lib/data-loader.ts` never passes one — every Member sees every record in the org, with no scoping |
| Lead follow-up date + reminder | **NOT BUILT** | No `followUpAt`/equivalent field on the `Lead` model; a generic `Task` can be created against a lead manually, but there's no dedicated field or reminder tied to it |
| Automatic "last interaction" tracking on contacts | **BUILT** | `Contact.lastInteractionAt` is bumped server-side on every activity log (`lib/data/activities.ts:64`) and on contact edits (`lib/data/contacts.ts:99`); surfaced in the UI (`Contacts.tsx`, `RecordDetail.tsx`) via `RelativeTime`, including a "stale" (30+ days) flag |

**Test-count reconciliation** — ran the full suite at both named commits in a temporary, now-removed git worktree (`e0cd8b8` and `14a5b09`; `node_modules` junctioned in rather than reinstalled, working tree never touched), with `--reporter=verbose`, then diffed the sorted test-name lists:

- Both commits have **exactly 156 tests** — confirmed two ways: the actual vitest run, and a direct `it(`/`it.each(` count in the checked-out source at `e0cd8b8`. `14a5b09` only touched UI files, so this was expected, not a coincidence.
- The name-list diff between the two commits is **empty** except for one test's pass/fail status: `Dashboard Payments card math... mirrors PaymentsSummaryCard's own "collected this month" filter on real data` failed at `e0cd8b8` with a 30000ms timeout, then passed cleanly on rerun and at `14a5b09` — a flaky DB-bound timeout, not a lost or regressed test. Nothing was missing; nothing needed restoring.
- The previously reported totals of 164, 153, and 159 do **not** match the actual, reproducible count in the codebase at any point checked. In particular, `e0cd8b8`'s own commit message claimed "159 total, up from 156" — but the actual source at that exact commit has 156 `it()` blocks, confirmed by direct count. That claim was simply wrong when written, not a sign of tests lost afterward.
- **Authoritative current total: 157** (156 existing + the 1 new test added below), all passing, confirmed by `npx vitest run`.

**The four named `GET /api/crm-refetch` cases** — all four already existed by name in the `GET /api/crm-refetch: live-update refetch is scoped and role-gated exactly like first load` describe block (`tests/integration/cross-tenant.test.ts:1575`), except one:

| Case | Test |
|---|---|
| A Member gets no payments or payment-kind activities | `a non-privileged member's refetch carries no Payment rows and no payment-kind activities, same as first load` |
| Another org's data never appears | `is scoped by the caller's own session — never returns another org's rows` |
| An unauthenticated request gets a 401 | `returns 401 (never redirects) when there is no valid session` |
| A demoted admin gets no payment data | **Gap found — no test existed.** The closest existing coverage, `requirePaymentAccess`'s `rejects when the session says org:member but the Owner row says Admin`, only exercised the auth helper directly, never the route end to end. Added `a demoted admin's refetch carries no payment data, even while Owner.role in our DB is still stale` to the same describe block, mirroring that helper-level test's exact scenario (DB role still "Admin", Clerk session already "org:member") through the real `GET()` handler. |

## Made the UI honest about every remaining dead control (Oct 23 2026)

Re-scanned every control named in the earlier Settings/bell audit, plus the leftovers from the
Sep/Oct full-codebase audits (Leads "Add filter" and row menu, Contacts row menu, Dashboard "Last
30 days"/"View full history", Reports "This quarter"). Each got one of three dispositions —
**remove** (purely decorative, no stated plan), **disable + "Coming soon"** (a plausible, commonly
expected feature with zero backing infrastructure), or **wire** (a real capability already exists
elsewhere in the app) — decided per-control before any non-trivial change, per the user's request.

| Control | Disposition |
|---|---|
| Notifications: 5 toggles (Deal stage changes, New lead assigned, Mentions and comments, Overdue task reminders, Daily pipeline digest) | Disabled + one "Coming soon" banner above them (state is local-only, never persisted) |
| Fiscal year starts | Disabled select + "Coming soon" tag; added a note that it would change the Dashboard quota's quarter definition once built |
| Lead sources "Add source" | Disabled button + "Coming soon" tag |
| Upload photo | Disabled button + "Coming soon" tag |
| Account menu: "Profile & preferences" | Wired → navigates to `/settings` |
| Account menu: "Notification settings" | Wired → navigates to `/settings?section=notifications` (added query-param deep-linking to `Settings.tsx`, mirroring the existing `?status=`/`?tag=` saved-view pattern) |
| Account menu: "Keyboard shortcuts" | Removed — no stated plan, nothing to wire |
| Top-bar bell | Wrapped in the existing `Popover` component; now opens a panel reading "Notifications aren't available yet." instead of doing nothing. Removed the hardcoded fake unread dot. |
| Leads "Add filter" | Removed (dead button, no stated plan); also removed the now-unused `activeFilters` state and `SlidersHorizontal` import |
| Leads row menu: "Log activity", "Send email", "Delete lead" | Disabled + "Coming soon" (via `MenuItem`'s new `comingSoon` prop) |
| Contacts row menu: "Log activity", "Add to sequence", "Delete contact" | Disabled + "Coming soon" |
| Contacts row menu: "View company" | Wired → navigates to `/companies/[companyId]` (the company detail page already exists) |
| Dashboard "Last 30 days" | Disabled + "Coming soon" tag |
| Dashboard "View full history" | Disabled + "Coming soon" tag |
| Reports "This quarter" | Disabled + "Coming soon" tag |

**Quarter definition, as requested:** the Dashboard's quota card uses a hardcoded **calendar**
quarter (`Math.floor(now.getMonth() / 3) * 3` → Jan/Apr/Jul/Oct), not a value read from any
org setting. Reports has no quarter-scoping logic at all today, so there's nothing to compare it
against there. Wiring "Fiscal year starts" would change the Dashboard's quarter boundaries once a
non-calendar fiscal year is selected — noted directly in the Settings UI next to that control.

Mechanism: extended `MenuItem` (`src/components/ui/Menu.tsx`) with `disabled`/`comingSoon` props,
and `Toggle` (bottom of `src/screens/Settings.tsx`) with a `disabled` prop — both reused everywhere
above rather than inventing a one-off pattern per site. The existing `Tag` component
(`@/components/ui/Badge`) is the "Coming soon" label everywhere outside a menu item.

**Verified in a real browser** against the live "Nexo Verified Org" data (minted Clerk sign-in
tickets + the scratchpad Playwright harness, not just typecheck/build): 16 checks across Dashboard,
the bell, the account menu, Settings' Profile/Pipeline/Notifications tabs, Leads, and Reports, plus
9 more checks on the Leads/Contacts row menus including the "View company" navigation — all 25
passed. `npx tsc --noEmit`, `npx vitest run` (156 passed), and `npx next build` all also passed
clean on the final state.

## Confirmed GET /api/crm-refetch can never be served cross-user by a shared cache (Oct 23 2026)

Once the live-update refetch moved to `GET /api/crm-refetch` (see the entry below), it needed its
own explicit cache guarantee — unlike a Server Action, a plain Route Handler has no built-in
"never shared" behavior, and this one returns one org's full data, including Payment rows for an
admin. `cache: 'no-store'` on the *client's* `fetch()` call (`src/store/crm.tsx`) only keeps
Next's own client-side fetch cache from reusing it — it says nothing about a browser's disk
cache, a corporate proxy, or a CDN sitting in front of the deployment.

Added two independent, explicit guarantees to `app/api/crm-refetch/route.ts`:
- `export const dynamic = 'force-dynamic'` — the route is never statically optimized/cached by
  Next itself, regardless of whether a "dynamic API" is auto-detected.
- An explicit `Cache-Control: private, no-store` response header, on both the success (200) and
  failure (401) paths, so no shared/intermediary cache between the server and the browser is
  permitted to store or reuse the response either.

New tests (159 total, up from 156): `dynamic` is asserted to be `'force-dynamic'`; the header is
asserted present with the exact value on a successful response and on a 401.

**Live-verified** — the actual response headers from a real request (signed in, real session,
via both Playwright's wire-level response inspection and the browser's own `fetch()` Headers
object, for two independent views of the same response):

```
status: 200
cache-control: private, no-store
content-type: application/json
...
```

## Three follow-ups on the live-update work: a real queuing bug fixed, access flags confirmed, cost measured (Oct 22 2026)

### 1. Action queuing — real bug found and fixed, with measurements

**Yes, Server Actions from the same client do serialize.** Measured it directly: with
`refetchCrmDataAction` (a Server Action) in flight, fired a real `moveDealAction` the instant the
refetch's request was observed. Timeline (ms from the refetch's request being sent):

```
+0ms     refetch request sent
+3743ms  refetch response received
+3746ms  mutation request SENT        <- did not go out until the refetch finished
+5821ms  mutation response received
```

The mutation was clicked at +560ms but its network request didn't fire until +3746ms — it waited
out the entire refetch, adding the refetch's full duration (here ~3.7s) to the mutation's own
latency. This is Next.js's own Server Action dispatch queue serializing concurrent action calls
from the same client — not something a lighter loader alone fixes, since even a near-instant
action would still occupy the queue slot.

**Fix**: moved the refetch off Server Actions entirely, onto a plain Route Handler,
`GET /api/crm-refetch` (`app/api/crm-refetch/route.ts`) — same `requireAuth()` +
`canAccessPayments()` + `loadCrmData()`, same gating, just not dispatched through Next's action
queue. `lib/actions/crm.ts`'s `refetchCrmDataAction` was removed (replaced, not kept alongside) and
`src/store/crm.tsx`'s `refetchTick` now does a plain `fetch('/api/crm-refetch', { cache: 'no-store' })`.

Re-measured after the fix, same scenario:

```
+0ms     refetch (route handler) request sent
+555ms   mutation request SENT        <- genuinely concurrent now
+6291ms  mutation response received
+6321ms  refetch response received
```

The mutation's request now goes out immediately, truly overlapping with the in-flight refetch.
(Both requests took a bit longer individually this run — expected: they're now actually
contending for the same Node event loop / Postgres connections concurrently, instead of one
waiting for the other to finish first. That's real parallel load, not an artificial queuing delay,
and it's far smaller than the ~3.2s the queue was adding.)

**Query/payload cost**, measured directly (`performance.now()` + Prisma query-event logging
around a raw `loadCrmData()` call, against the real dev org and a temporary bulk-seeded org — see
item 3 below) — `loadCrmData` itself takes ~2-4s server-side regardless of org size (confirms no
N+1: the query count is flat), and the end-to-end route round-trip measured above (~3.6-3.7s) is
consistent with that plus normal dev-mode/network overhead.

Updated tests: the `refetchCrmDataAction` cross-tenant/role tests now call the exported `GET()`
from `app/api/crm-refetch/route.ts` directly (same tenant/role assertions, same coverage — a
Route Handler's exported function is just as callable from a test as a Server Action was).

### 2. Access flags — already updated by the refetch; verified live with a real demotion and promotion

Checked `applyFreshData` (`src/store/crm.tsx`, added in the previous entry): it already calls
`setCanAccessPayments(fresh.canAccessPayments)` on every successful refetch, not just the data
arrays — this was built in from the start, not stale. Verified live anyway, for real, rather than
trusting the code read: demoted the real admin (`nexoverify1@mailinator.com`,
`user_3JrXB891yBRmNt1kfQLKzGp2M9J`) in "Nexo Verified Org" to `org:member` via Clerk's Backend API
while their session stayed open in a real browser tab on the Dashboard (no reload):

- Payments nav item present before demotion.
- Demoted via Backend API. A background refetch ~24s later (the session JWT refreshing, then the
  next focus-triggered refetch picking up the new `orgRole` claim) made the Payments nav item
  disappear — never manually reloaded.
- Opened the command palette and searched "payment": no `Payments · Go to` row, confirming
  `canAccessPayments`/`payments` were actually cleared in client state, not just the nav item
  hidden.
- Promoted back to `org:admin`. ~37s later, a background refetch brought the Payments nav item
  back — again with no manual reload.
- Confirmed via the Backend API afterward that the account ended the test correctly restored to
  `org:admin`.

This is the same two-source check (`Owner.role` + the session's `orgRole` claim) `requirePaymentAccess()`
has always used — the refetch doesn't need its own separate staleness logic, it's just calling the
same gate again on a timer.

### 3. Cost — measured, with a scaling note (not building the lighter version now)

Measured directly against the real dev org and a temporary bulk-seeded org (created and fully
deleted for this measurement only — never committed):

| | Dev org (real data) | Bulk org (300 per entity) |
|---|---|---|
| `loadCrmData()` duration | ~2.1-4.3s | ~2.6-3.8s |
| SQL queries issued | 22 | 22 (flat — no N+1) |
| JSON payload size | ~36 KB | ~478 KB |
| Row counts returned | 4 owners, 13 leads, 11 contacts, 10 deals, 8 tasks, 50 activities (capped), 15 companies, 0 payments, 6 stages | 1 owner, 300 leads, 300 contacts, 300 deals, 300 tasks, 50 activities (capped by `listActivities`'s own `limit`), 1 company, 300 payments, 1 stage |

22 queries is from Prisma's per-relation batching across the 9-10 parallel `list*` calls (one base
query per entity plus one batched query per `include`d relation — e.g. `listDeals`'s owner/contact/
stage/company includes), not one-per-row — confirmed flat between the small real org and the
300-per-entity synthetic one. `activities` is the one field that doesn't grow with org size at all:
`listActivities`'s default `limit: 50` caps it regardless.

**Scaling note — when this should move to a changes-only fetch or push-based updates (not built
now, per instructions):** this wholesale "refetch everything" approach is fine while the payload
stays in the tens-to-low-hundreds of KB and the whole round trip stays a low single-digit number of
seconds — true today even for a 300-per-entity org. It stops being fine well before an org reaches
thousands of rows per entity, for two compounding reasons: (1) payload size grows linearly with
total row count with no cap (unlike `activities`), so a few-thousand-row org could mean multiple
MB transferred on every poll tick, every ~60 seconds, from every open tab; (2) 22 queries per
refetch, multiplied across every open tab's independent poll timer, becomes a real concurrent-load
source on Postgres as the number of simultaneously-open tabs across an org grows, independent of
any one org's data size. The concrete trigger point: once a single org's `loadCrmData()` payload
regularly exceeds ~1-2 MB, or once a given org has enough simultaneously-open tabs that their
independent ~60s polls become a visible load pattern in Neon's own metrics — either is the signal
to stop wholesale-refetching and move to either (a) a changes-only endpoint (e.g. "rows touched
since timestamp X," keyed off `updatedAt`, which this schema already has on every table) or (b) a
push-based mechanism (a webhook-style or WebSocket fan-out from the mutation side, so clients stop
polling at all). Neither is built here.

## Fixed the live-update gap: poll + focus/visibility refetch, safe against races (Oct 16 2026)

**Report, before building (as requested):**

*How CrmProvider holds data.* `src/store/crm.tsx`'s `CrmProvider` receives one `initialData:
CrmInitialData` prop from the `(app)` layout's server-side `loadCrmData()` call, and seeds a
separate `useState` for every field off it (`leads`, `contacts`, `deals`, `tasks`, `activities`,
`owners`, `currentUser`, `stages`, `companies`, `payments`, `quarterlyQuota`, `orgCurrency` — plus,
as of this entry, `canAccessPayments` and `orgName`, which used to be plain `const`s off
`initialData` and are now stateful too, for the same reason). Critically: **nothing re-reads
`initialData` after mount.** `useState(initialData.x)` only uses that value on the very first
render; if the parent Server Component re-renders and hands `CrmProvider` a fresh `initialData`
prop later, React does not re-initialize the state from it. So a refetch has to replace each of
those fields explicitly — there's no way to "just refresh the props."

*The `router.refresh()` history, and whether it's safe now.* Per `PROGRESS.md`'s own record, all
seven `router.refresh()` calls were removed Sep 26 2026 as a stopgap: calling it after a mutation
re-ran the `(app)` layout's server render, and at the time, the org picked in `<OrganizationList>`
hadn't reliably propagated to the session the next server request would see, so `resolveAuth()`
bounced the user to `/create-org`. The underlying trigger for *that* bug (`force_organization_
selection` plus a routing-mode mismatch during the sign-in/org-selection flow itself) was fixed
separately and later (see "Fixed: Clerk org-selection redirect loop"). Checked whether it's safe
to reintroduce `router.refresh()` today: confirmed via `grep` that no `router.refresh()` call
exists anywhere in the current codebase (the stopgap was never reverted), and every mutation
already calls `revalidatePath('/', 'layout')` after writing — and across this entire session's
very extensive live Playwright verification (hundreds of real page reloads via `page.goto()`,
many fired within seconds of a mutation), the active org has never once failed to resolve on a
fresh server request. That's reasonably strong evidence the steady-state (post sign-in) propagation
is solid now.

**It doesn't matter for this feature, though** — `router.refresh()` was never going to work here
regardless of that bug's status, for the architectural reason above (`useState` won't re-seed from
new props), so this build uses a different mechanism entirely: a plain server action
(`refetchCrmDataAction`) that the client calls directly, with no Next.js routing/middleware
involved at all, and therefore no bounce risk to inherit either way.

### Built

1. **`refetchCrmDataAction`** (`lib/actions/crm.ts`) — `requireAuth()` + `canAccessPayments()` +
   the exact same `loadCrmData()` the `(app)` layout calls on first load. No new data-access code;
   a refetch gets identical role/tenant gating to first load by construction, not by a second,
   separately-maintained check. `requireAuth()` only ever throws (never redirects, unlike
   `resolveAuth()`), so a refetch failure can only ever be a rejected promise.

2. **`src/store/livePoll.ts`** — the scheduling logic (poll every ~60s while visible, refetch
   immediately on focus/visibility-regained, pause while hidden, exponential backoff on repeated
   failures capped at 5 minutes), extracted into a pure module driven entirely through an injected
   `env` (timers, visibility, focus) so it's unit-testable without a real browser — this repo has
   no DOM/jsdom harness. Also exports `isRefetchStale()`, the small pure predicate the race-safety
   below is built on.

3. **Race safety, in `CrmProvider`**: `pendingCountRef` (how many of *this tab's own* mutations
   are in flight) and `generationRef` (bumped every time one starts) are threaded through `persist()`
   (now accepting an `onSuccess` callback — reused from the Won-payment-setup feature's
   `runPersist()`) and the 7 mutators that don't go through `persist()` (`addLead`, `addContact`,
   `addCompany`, `deleteCompany`, `deleteStage`, `splitPayment`, `deletePayment`). A poll tick
   skips the fetch entirely while `pendingCountRef.current > 0` ("skip ... while any persist()
   mutation is pending"). If a mutation starts *during* an already-in-flight fetch, the response is
   caught by `isRefetchStale()` (generation moved, or a mutation is pending again by the time the
   response lands) and discarded — not applied, not treated as an error, retried again shortly.
   Only once neither condition holds does `applyFreshData()` wholesale-replace every field — safe
   specifically because of that guard, which is what keeps a refetch from reverting a change still
   saving or resurrecting a row a concurrent delete just removed.

4. **Fail quietly**: `refetchCrmDataAction`'s rejection is caught inside `livePoll`'s tick and only
   ever triggers backoff + another timer — no toast, no redirect, no UI flash of any kind.

### Tests (164 total, up from 153)

- `tests/unit/live-poll.test.ts` (11 tests): the full scheduler against a fake `env` — starts
  polling at the steady interval, pauses with zero timers while hidden and resumes on visibility
  change, skips the fetch outright while a mutation is pending, discards-and-retries-soon (no
  backoff) on a stale/discarded result, backs off exponentially on real failures and caps it,
  resets to the steady interval after a success, focus triggers an immediate refetch, and `stop()`
  fully disposes (no further ticks).
- `isRefetchStale` (3 tests): false when nothing changed; true when the generation moved during
  the fetch; true when a mutation is in flight at apply time even with no generation change.
- `tests/integration/cross-tenant.test.ts` (+4): `refetchCrmDataAction` is scoped to the caller's
  own org (never returns another org's rows — the actual tenant check "on whatever the refetch
  uses," which is `loadCrmData`, already exhaustively covered elsewhere in this suite); rejects
  (never redirects) with no valid session; a non-privileged member's refetch carries zero Payment
  rows and zero payment-kind activities, exactly like first load; an admin's refetch does include
  payment access.

### Live-verified with two real sessions (real admin + real Jordan Ellis member, "Nexo Verified
Org"), against real Neon data

- Admin assigned a new task to the Member from one real browser session; the Member's already-open
  `/tasks` tab (never manually reloaded) showed it after 58.4s — within the ~60s poll window.
- A second task, assigned the same way: simulating the Member's tab regaining
  focus/visibility made it appear in 4.0s — the focus path firing immediately rather than waiting
  for the next poll tick.
- **Mutation-during-refetch, the hard case**: delayed the Member's natural poll-triggered refetch
  response by 3.5s via route interception (no synthetic visibility tricks for this one — a real
  ~60s poll tick, genuinely held in flight), and while it was held, the Member toggled a task.
  Confirmed, in order: the optimistic UI flipped immediately; the toggle's own write landed in
  Neon; and *after* the delayed, now-stale refetch resolved, both the UI and Neon still showed the
  Member's toggle — the stale response never overwrote it. (Two earlier attempts at this specific
  check gave confusing results purely from test-harness artifacts — my own request-queuing and a
  hardcoded wrong toggle-direction assumption, not an app bug; documented here in case the pattern
  resurfaces: constructing this exact race deterministically via Playwright is fiddly, and the
  corrected version above is what actually ran clean.)

## Settings + notification bell audit: one real fix, three honest "needs a decision" findings (Oct 16 2026)

Scope: every Settings control and the top-bar bell, excluding what was asked to be skipped as
already verified (Default currency, Quarterly quota, Profile Save, the Team tab).

### 1. Notification bell — NOT BUILT, not a wiring gap

Checked `src/components/layout/PageShell.tsx`: the bell is a plain `IconButton` with **no
`onClick` at all** and a hardcoded "unread" dot (`<span className="... bg-brand-600 ...">`) that
is not driven by any state — it always renders, regardless of whether anything has happened.
Grepped the whole repo for anything notification-related: only this bell, the Settings
Notifications tab's toggles, and the dead "Notification settings" account-menu item exist. There
is no Notification model in `prisma/schema.prisma`, no API route, no data layer, nothing to wire
up. This is not "a panel exists but is unwired" — there is no notification system at all.
Live-confirmed: clicking it opens no panel/dialog and fires no server action.

**Smallest useful version**, for when this gets built (not built here, per instructions):
- **What counts as a notification**: reuse the existing `Activity` log as the source, not a new
  parallel event system — a notification is "an Activity whose actor isn't you, that's relevant to
  you" (you own the subject record, you're @mentioned, or it's your own overdue task crossing into
  overdue). This avoids a second place business events need to be raised from.
- **Storage**: a new `Notification` row per (recipient Owner, Activity) pair — not a single global
  feed — so read/unread is naturally per-recipient. Minimal shape: `id, orgId, ownerId, activityId,
  readAt (nullable)`.
- **Read/unread**: `readAt IS NULL` = unread; the bell's badge count is `count(*) where ownerId =
  me and readAt is null`; opening the panel marks the visible page read (sets `readAt = now()`).
- **Fan-out**: generated at the same point `logActivity`/the payment actions already create an
  Activity — append matching `Notification` rows in the same transaction, not a separate job.

### 2. Every other Settings control, audited and verified against real data

| Control | Does | Verified against | Result |
|---|---|---|---|
| Profile → Avatar "Upload photo" | — | — | **Dead** (already known). Needs a real decision: Clerk's `user.setProfileImage()` could avoid building our own file storage, but that's still a real choice to make, not a trivial wire-up — not attempted here. |
| Profile → Full name / Time zone / Save | `updateProfile` | — | Already verified working; skipped per instructions. |
| Profile → Role (display) | reads `currentUser.role` | Neon (`Owner.role`) | Accurate read-only display, real data. |
| Profile → Email (display) | reads `currentUser.email` | Neon (`Owner.email`) | Accurate read-only display, real data. |
| Workspace → Workspace name | **was** a hardcoded `defaultValue="Acme Revenue Team"`, uncontrolled, no save | — | **Was dead and actively wrong** (showed a fake name, not even the real org's). **Fixed**: now a read-only field showing the real `Organization.name` (`orgName` added to `CrmInitialData`/the store). Live-confirmed: Settings now shows "Nexo Verified Org", not "Acme Revenue Team". No edit action was added — there's no "rename workspace" feature in this app, and `Organization.name` is only ever set once at creation (see `upsertOrg`'s no-op update branch), so making it editable without also calling Clerk's own org-update API would silently drift from Clerk — flagged, not built. |
| Workspace → Default currency | `updateCurrencyAction` | — | Already verified working; skipped per instructions. |
| Workspace → Fiscal year starts | uncontrolled `<Select defaultValue="jan">`, no `onChange`, no save | — | **Dead, needs a decision + new infrastructure.** No `Organization` column backs this at all. Building it for real also means changing how "this quarter" is computed on the Dashboard/Reports (currently hardcoded to calendar-year quarters — `Math.floor(now.getMonth() / 3) * 3`), not just adding a field. Not attempted. |
| Workspace → Quarterly team quota | `updateQuota` | — | Already verified working; skipped per instructions. |
| Pipeline → Deal stages (`StageManager`) | `addStage`/`renameStage`/`moveStage`/`deleteStage` | Neon (`PipelineStage`) | **Works.** Live-verified: renamed "Discovery" to "Discovery (audit test)" from Settings → Pipeline, confirmed the write in Neon, reverted. Same component also backs Pipeline's "Customize stages" modal — one implementation, not a separate untested copy. |
| Pipeline → Lead sources tags | static list mirroring the real `LeadSource` enum | — | The displayed tags are accurate (they match the actual enum) but the list itself isn't dynamic — it's hardcoded JSX, not read from anywhere. |
| Pipeline → "Add source" button | no `onClick` | — | **Dead, needs a decision.** `LeadSource` is a fixed Prisma enum, not a per-org table — adding a source means either a schema migration to extend the enum (needs agreement on the exact taxonomy) or converting the whole lead-source model to a dynamic per-org list (a much bigger change touching every place `LeadSource` is used). Not attempted. |
| Team tab (entire section) | — | — | Already verified working (invite, role change, remove, revoke); skipped per instructions. |
| Notifications tab — all 5 toggles | local `useState` only, never persisted, no backend field | — | **Dead, same root cause as #1.** Even if persisted, there's no notification system for these preferences to gate — building toggle persistence ahead of the system they'd control would be fake progress. Not attempted; comes after a real notification system exists. |
| Top bar → Bell | see #1 | — | NOT BUILT. |
| Account menu → "Profile & preferences" / "Notification settings" / "Keyboard shortcuts" | `onClick={close}` only | — | Confirmed dead, matches what was already known — each just closes the menu. |

### What was fixed vs. reported

Fixed (small, contained, existing patterns): Workspace name now shows the real org name
read-only, instead of a fake hardcoded one.

Reported, not built (each needs a real decision and/or new infrastructure, per instructions):
the notification bell and system; Fiscal year starts; Lead sources "Add source"; the Notifications
tab's toggles; Upload photo (already known).

## Won-deal payment setup prompt: one shared trigger for all four "deal entered Won" paths (Oct 16 2026)

**Confirmed first**: the "two concurrent split requests" test genuinely fires both
`splitPaymentAction` calls in parallel against the real database (`Promise.allSettled([attempt(),
attempt()])` — both start before either is awaited, same concurrency as `Promise.all`; `allSettled`
only so the expected rejection doesn't throw out of the test) and asserts exactly one set exists
afterward. No gap to fill there.

**How a deal reaches Won** (reported before building, per the request): four UI paths — drag,
the deal-card menu's "Move to stage" → Won, EditDealModal's stage select, and creating directly
as Won (only reachable via a Won column's "+") — but only **three store functions** (`moveDeal`,
`updateDeal`, `addDeal` in `src/store/crm.tsx`), all of which already route their server
confirmation through the one shared `persist()` helper. That's the shared trigger point.

**Built**: `persist()` gained an optional `onSuccess` callback, fired only once the mutation is
genuinely confirmed saved (never on rollback). The actual success/rollback branching was extracted
into a standalone `runPersist()` (`src/store/persistRun.ts`) specifically so it's unit-testable
without a component harness (this repo has none — vitest runs in a plain Node environment).
`moveDeal`/`updateDeal`/`addDeal` each detect "entering Won" the same way they already did for
close-date stamping (`nextStage.isWon && !previousStage.isWon`, or just `stage.isWon` for a brand
new deal) and, when true, pass `() => openWonPaymentSetup(dealId)` as that `onSuccess`.
`openWonPaymentSetup` (and the pure `shouldPromptWonPaymentSetup` it's built on, in
`src/lib/utils.ts`) is false for anyone without payment access, and false if the deal already has
any payment row — re-winning a reopened deal that already has payments doesn't re-prompt.

The dialog itself reuses the existing split form, extracted from the Payments screen into a shared
`src/components/common/SplitPaymentModal.tsx` (no second copy) with optional `title`/
`cancelLabel` overrides and a new fallback: if `splitPaymentAction` rejects because the deal
already has payments (a race — e.g. another tab set one up in between), it shows received-vs-value
and a link to `/payments?dealId=` instead of a bare error. Rendered once, in `AppLayout`, since a
deal can enter Won from any screen. Won deal cards in Pipeline now show a "Set up payments" button
(privileged, no-payments-yet) or the existing received-vs-value progress bar (privileged,
has-payments) — never both.

**Gating**: both the dialog and the button read `payments`/`canAccessPayments` from the same
`loadCrmData` gate every other payment surface already relies on — nothing new to gate at the
component level.

**Tests** (138 total, up from 130): unit tests for `shouldPromptWonPaymentSetup` (Member gating,
no-re-prompt-once-has-payments, doesn't false-block an unrelated deal) and for `runPersist` itself
— the real shared code, not a reimplementation — proving `onSuccess` never fires when `run`
rejects (the exact "rolled-back move must not open the dialog" guarantee, for all three call sites
at once) and does fire when it resolves; an integration test proving a Member's loaded `Deal` data
carries no payment-existence signal at all (same shape as a privileged load, `payments` empty).

**Live-verified** against real Neon data, as separate focused scripts after Playwright's native
HTML5 drag-and-drop proved flaky to automate reliably in this environment (confirmed by one
diagnostic run where `dragTo()` did fire the real `moveDealAction`, and by the fact that drag and
the card-menu option call the textually identical `moveDeal()` — so Path 2 below doubles as proof
of Path 1's trigger logic): the card-menu "Move to stage" → Won path opened the dialog for the
correct deal; the edit-modal stage-select → Won → Save path opened it for the correct deal;
creating a deal directly in a Won column opened it for the correct deal; aborting the server
request mid-move (via Playwright route interception) left the deal unmoved and never opened the
dialog; re-winning a deal that already had a real payment did not re-open it; and, as a real
Member, moving a deal into Won (the move itself still succeeds — only the payments UI is gated)
never showed any dialog, and the resulting Won deal card showed neither a "Set up payments" button
nor a received-vs-value line.

## Three checks on the installments work: no bug found, plus a real idempotency fix (Oct 16 2026)

Three requested checks on the previous entry's installments work:

**1. The reported "[7400, 5550, 5550]" was not a bug — it was a misleading test, in my own
verification script, not the app.** `splitAmounts(18500, [30, 40, 30])` is, and was, correct:
`[5550, 7400, 5550]`, order-preserving (index 0 ↔ percent 0). The live UI preview showed the
correct per-row amounts ($5,550 / $7,400 / $5,550 next to Advance/Milestone/Final) before
submission, and the real rows read back from Neon in creation order were exactly
`{Advance: 5550}, {Milestone: 7400}, {Final: 5550}` — correct. What actually happened: my earlier
verification script compared `rows.map(r => r.amount).sort((a,b) => b-a)` against a hardcoded
sorted array — a check that can't tell "right amounts in the right order" apart from "right
amounts, scrambled across labels," and I then reported that sorted array in prose as if it
reflected real order. It was my own test's weakness, not the feature's. Re-verified live against
real Neon data, reading label+amount+creation-order directly this time (no sorting) — correct.
Added order-sensitive tests that would have caught a real version of this: a unit test for
`splitAmounts(18500, [30,40,30])` against the exact reported value, two remainder-producing cases
(`10001` split `50/50` → `[5000, 5001]`; `10001` split `33/33/34` → `[3300, 3300, 3401]`), and an
integration test asserting label-to-amount correspondence (`Advance: 300`, `Milestone: 400`,
`Final: 300` for a 30/40/30 split of a real $1,000 deal) read fresh from Neon rather than through
the action's own in-memory return value.

**2.** Yes — `72bb057` was committed and pushed before this check, tree was clean, and
PROGRESS.md's entry above this one was part of that commit.

**3. Fixed a real gap**: `splitPaymentAction` had no guard against running twice on the same deal.
`createPaymentsSplit` (`lib/data/payments.ts`) now refuses to run if the deal already has *any*
Payment row (from an earlier split or a single manually-created payment) — and does so safely
under concurrency: inside the same transaction as the creates, it first takes a
`SELECT ... FOR UPDATE` row lock on the deal, *then* checks for existing payments. A plain
count-then-create without that lock would let two concurrent transactions both pass the check
under Postgres's default READ COMMITTED isolation (neither sees the other's uncommitted rows) and
both create a set; the lock serializes them — the second transaction blocks until the first
commits, then re-checks and correctly finds the first split's rows already there. Tests: a second
split attempt on an already-split deal is rejected and leaves the first split untouched; splitting
a deal that has only a single manually-created payment is also refused; two concurrent
`splitPaymentAction` calls on the same deal (`Promise.allSettled`) produce exactly one fulfilled
result and one rejection, with exactly one set (not two, not four) ending up in the database.
Live-verified against real Neon data: split a real deal, attempted a second split on it through
the real UI, got the exact "This deal already has payments..." error in the modal, confirmed the
deal still had only the original 2 rows.

## Added installments/milestones and admin-only Dashboard + Pipeline payment surfaces (Oct 16 2026)

**Report, before building (as requested):** `Payment.dueDate` was a required, non-nullable
`DateTime` — a payment could not have no due date. There was no label/type field on `Payment` at
all. There was no split/installment action — creating an advance + completion split meant opening
"New payment" twice by hand, with no validation that the parts summed to the deal's value and no
transaction (a crash partway through left it inconsistent).

**Schema** (`prisma/migrations/20261016150000_payment_label_optional_due/`): additive — a new
`PaymentLabel` enum (`Advance`/`Milestone`/`Final`/`Other`), a `label` column defaulting every
existing row to `Other`, and `dueDate` made nullable (`ALTER COLUMN ... DROP NOT NULL`, safe —
widens the constraint, no backfill needed). Null `dueDate` means "awaiting milestone": pending,
never overdue, its own bucket.

**Installments**: `lib/data/payments.ts` gained `createPaymentsSplit` — creates every installment
row in one transaction (all-or-nothing) and logs a single activity for the whole split (not one
per row). `lib/actions/payments.ts`'s new `splitPaymentAction` validates percentages are integers
1-99 that total exactly 100, fetches the deal's real value server-side, and computes amounts via
a new shared `splitAmounts()` (`src/lib/utils.ts`) — every part but the last is
`floor(total * percent / 100)`, and the last absorbs whatever rounding remainder is left so the
parts always sum to exactly the deal's value. The UI (`src/screens/Payments.tsx`, "Split into
installments" — only shown in the per-deal `?dealId=` view, where "the deal" is unambiguous) has
50/50 and 30/40/30 presets plus a custom row editor, with a live preview using the same
`splitAmounts()` the server uses — the server never trusts the client's preview numbers, it
recomputes from the real deal value.

**Awaiting milestone**: a payment can now be created/edited with no due date at all (an "Awaiting
milestone" checkbox in both New/Edit payment modals). `isPaymentOverdue()`/`isAwaitingMilestone()`
(`src/lib/utils.ts`) are the one place these rules live — a payment with no `dueDate` can never be
overdue by definition. The Payments screen gained summary tiles (Collected / Pending / Overdue /
Awaiting milestone) and a filter (All / Overdue / Awaiting milestone / Paid / Cancelled), plus a
Label column (Tag) and a "Due date" column that reads "Awaiting milestone" instead of blank.
Setting the date later, once the milestone completes, works through the normal edit flow — no
special-casing needed.

**Reversed the earlier "no Dashboard/Reports widgets, no deal-card badges" decision, for
payment-privileged users only** (Members still get nothing — this is a per-session instruction
from the person running this build, reversing that specific line of the originally-approved
design):
- **Dashboard** (`PaymentsSummaryCard` in `src/screens/Dashboard.tsx`): collected this month,
  overdue amount + count, awaiting-milestone count, and a link to `/payments`. Computed from the
  `payments` array only via `receivedTotal()`/`isPaymentOverdue()`/`isAwaitingMilestone()` — never
  from `Deal.value`. Rendered only when `canAccessPayments` is true.
- **Pipeline deal card** (`src/screens/Pipeline.tsx`): a "View payments" menu item (links to
  `/payments?dealId=`) for every deal, and, on Won deals only, a received-vs-value progress bar
  (via `receivedTotal()` on that deal's payments). Both gated on `canAccessPayments`; the
  component itself does no gating of its own filtering — `Pipeline()` passes it `[]` for a
  non-privileged caller, same "gate the data once, trust every consumer" architecture as
  everywhere else in this feature.
- **No lead link** — agreed, unchanged. Payments are deal-scoped (`Payment.dealId` is required;
  there's no `leadId`), and a lead isn't yet a revenue-bearing record, so a lead-level payments
  link wouldn't correspond to anything real.
- **Gating**: both surfaces read `payments`/`canAccessPayments` from the same `loadCrmData` gate
  the rest of this feature already relies on — there's nothing new to gate at the component level,
  because a Member's `payments` is already `[]` and `canAccessPayments` is already `false` before
  either component ever renders.

New tests (124 total, up from 108): a unit suite for `splitAmounts` (even splits, 30/40/30
rounding, exact-sum invariant on values that don't divide cleanly) and `isPaymentOverdue`/
`isAwaitingMilestone`; integration tests for `splitPaymentAction` covering cross-org `dealId`
rejection, non-privileged-member rejection, non-100%-total rejection (nothing written), fewer than
two installments, a 0%/100% installment, and a real 30/40/30 split against a real deal's value
proving the exact rounding behavior end to end; a test proving a paid-then-cancelled payment is
excluded from the exact "collected this month" computation the Dashboard card uses, with real
`paidAt` still set; and a re-assertion (in the Dashboard-card framing) that a Member's loaded data
has no payments for the card to compute anything from.

**Live-verified** against real Neon data, both as a real Admin and a real Member in "Nexo Verified
Org": split a real $18,500 Won deal 30/40/30 (confirmed the exact [7400, 5550, 5550] rounding),
marked the 40% installment paid, confirmed the Pipeline deal card's progress bar read "$7.4K /
$18.5K" and the "View payments" menu item navigated correctly, confirmed the Dashboard Payments
card appeared with the right labels, created a real awaiting-milestone payment and confirmed it
filtered correctly and was never shown as overdue. Then as the real Member: confirmed no Payments
card on the Dashboard, no received-vs-value line and no "View payments" item on the same Calloway
deal card.

## Audited every "received" total after the paidAt-retention fix; added the missing display (Oct 16 2026)

Follow-up to the previous entry: once `cancelPayment` stopped clearing `paidAt`, every place that
sums received money needed auditing for whether it keys off `status === 'paid'` (correct) or
`paidAt` being truthy (now wrong — a cancelled-after-paid row has both). Audited every surface
that could plausibly sum received money:
- **Summary tiles, a Dashboard card, deal-card progress**: none of these exist for Payments —
  confirmed by grep, not assumed. The approved design explicitly excluded Dashboard/Reports
  widgets and deal-card badges, and that held.
- **The received-vs-deal-value banner** (`src/screens/Payments.tsx`): already filtered by
  `status === 'paid'`, already correct — but was its own inline `.filter().reduce()`, duplicated
  logic that the next feature could easily get wrong. Extracted to `receivedTotal()` in
  `src/lib/utils.ts`, the one place this sum is computed, so there's a single thing to test and a
  single thing a future summary tile would reuse.
- **CSV export**: exports raw per-row data (amount, status, paidAt as separate columns), never a
  computed total — nothing to fix.

Added the missing display: a payment that was paid and then cancelled now shows "Paid &lt;date&gt;,
then cancelled" in the Payments list's "Paid" column (`paidColumnText()` in
`src/screens/Payments.tsx`), instead of looking identical to a plain `paid` row.

New tests (108 total, up from 104): a pure-function suite for `receivedTotal` (`tests/unit/
payments-received.test.ts`) proving a cancelled row is excluded regardless of amount, plus an
end-to-end integration test that creates a real payment, marks it paid, cancels it, and confirms
`listPayments` + `receivedTotal` on the real Prisma-shaped row (with `paidAt` genuinely still set)
correctly produces 0, not the payment's amount.

Live-verified against real Neon data: created a $9,001 payment, marked it paid, cancelled it —
the list showed exactly "Paid Oct 15, then cancelled", and the per-deal received-vs-value banner
(with a second, still-pending $500 payment on the same deal for a realistic mix) correctly did not
count the cancelled $9,001 toward anything.

## Fixed a deletion-rule gap: paid -> cancel -> delete used to erase a received payment (Oct 16 2026)

The intent from the start was that a payment ever marked paid can never be erased, but the
original `cancelPayment` cleared `paidAt` when cancelling — so a `paid` payment, once cancelled,
looked identical to one that had never been paid, and `deletePayment`'s `status === 'paid'` check
no longer caught it. `paid -> cancel -> delete` removed the one row proving money had actually
been received.

Fixed in `lib/data/payments.ts`: `cancelPayment` now keeps `paidAt` as-is (a cancelled-but-once-
paid row reads "paid on X, then cancelled"), and `deletePayment` checks `paidAt` directly instead
of `status` — any payment that has ever had `paidAt` set is permanently undeletable, regardless of
its current status. A `pending` payment, or a `cancelled` one that was never paid first
(`paidAt` still null), stays deletable exactly as before. The Payments screen's delete control
(`src/screens/Payments.tsx`) now hides on `!payment.paidAt` rather than `status !== 'paid'`, and
the optimistic store update (`src/store/crm.tsx`) matches — it no longer clears `paidAt` locally
on cancel either. Received-total math (the per-deal "exceeds this deal's value" banner) was
already filtering by `status === 'paid'`, not `paidAt`, so it still correctly excludes cancelled
payments without any change.

New/updated tests (104 total, up from 102): `paid -> cancel -> delete` now asserts `paidAt` stays
set through the cancel and rejects the delete attempt; a `pending` payment and a `cancelled`
payment that was never paid are each confirmed still deletable. Live-verified against real Neon
data as the real admin: created a payment, marked it paid, cancelled it, confirmed `paidAt` was
still set in the database and the delete control stayed hidden in the UI, confirmed the row was
never erased.

Also confirmed (no change needed): the Payments page already has CSV export for admins, with the
raw `amount` as a number plus a separate `currency` column, matching the pattern used by Reports/
Companies exports.

## Built Payments, admin-only, with a two-source auth gate enforced at the data loader (Oct 16 2026)

Full build of the previously-approved Payments design: a `Payment` tracks a single
expected/received amount against a Deal (the "project" — there's no separate Project entity).
Admin-only for now, per the approved design: no Dashboard/Reports widgets, no deal-card badge,
no `PaymentPlan`/installment model — a flat list of rows, each independently created, edited,
marked paid, cancelled, or (while still pending) deleted.

**Schema** (`prisma/migrations/20261016090000_payments/`): new `Payment` model (`amount` as a
whole-unit `Int`, matching `Deal.value`'s existing whole-unit convention — see the Oct 15
currency entry's "whole-unit-Int discussion"), `PaymentStatus` enum (`pending`/`paid`/
`cancelled`), and a new `payment` value on the existing `ActivityKind` enum. Additive only.

**The auth groundwork this sits on** (`lib/auth.ts`, committed separately as checkpoints
`3303b71` and `d4e7e4f` before this feature started): `requirePaymentAccess()` — stricter than
`requireAdmin()` — fails closed unless two independent sources agree the caller is an active
admin: our DB's `Owner.role` (webhook-synced, unbounded staleness after a Clerk-side demotion)
*and* the live session's `orgRole` claim from `auth()` (Clerk refreshes this ~1/minute, so it
self-corrects quickly). `requirePaymentWriteAccess()` goes further for mutations: it confirms the
caller's role *live* against Clerk's Backend API, with no session-refresh window at all, so a
demotion blocks a write immediately rather than within that ~1-minute gap.

**Fixed as part of this build**: `requirePaymentWriteAccess()` only fetched the first 100 Clerk
organization memberships for the caller and did a plain `.find()` — an admin belonging to more
than 100 Clerk orgs could have their own org's membership missing from page one and be wrongly
rejected. It now pages through every membership (using the API's `totalCount`) until it either
finds the match or exhausts the list. Covered by a new test with a mocked 101-membership, 2-page
response where the real match only appears on page two.

**The activity-leak risk, and how it's actually closed** — not with a second role check
sprinkled at every read site, but with one gate at the single place all client state originates:
- `loadCrmData` (`lib/data-loader.ts`) now takes an `includePayments: boolean` — the caller's own
  `canAccessPayments()` result (a new non-throwing wrapper around `requirePaymentAccess()`,
  computed once in the `(app)` layout from the real session). When false, `listPayments` is never
  called at all, and `listActivities` is called with `excludeKinds: ['payment']` — a query-level
  filter (`lib/data/activities.ts`), not a client-side hide.
- Every activity `lib/actions/payments.ts`/`lib/data/payments.ts` logs uses `kind: 'payment'`,
  with no exceptions (create, edit, mark-paid, cancel, delete all log this same kind) — that one
  filter is what has to hold for all of them to stay excluded.
- No dollar amounts ever appear in an activity *title*, for anyone, by policy — titles are plain
  strings and the Payments table itself is the place amounts belong.
- Everything downstream (the Payments route, the command palette's rows, the CSV export, the
  per-deal `?dealId=` view) reads only from this already-gated `payments` array — none of them
  re-check access, because none of them can ever receive data they shouldn't have had in the
  first place. `requirePaymentAccess()` additionally gates the `/payments` route itself
  server-side (redirects home on failure) and `requirePaymentWriteAccess()` gates every create/
  edit/mark-paid/cancel/delete action directly.

**Deletion**: only a `pending` payment can be deleted outright (`deletePayment` in
`lib/data/payments.ts` throws otherwise); the way to undo a `paid` one is to mark it `Cancelled`
(which also clears `paidAt` — a cancelled payment was never actually received). The Payments
screen's delete button is hidden once a payment is paid and shows a confirmation dialog.

**No reconciliation, ever**: Payments never change when the parent Deal changes, and nothing
here changes the Deal either. The per-deal view (`/payments?dealId=...`, linked from a new
"Payments" line in `EditDealModal`'s footer, admin-only) shows a purely informational warning
banner when total `paid` payments exceed the deal's current value — never auto-adjusts anything.

**New tests** (`tests/integration/cross-tenant.test.ts`, 102 total, up from 87): tenant isolation
on `getPaymentById`/`listPayments`; a client-supplied cross-org `dealId` rejected by
`createPaymentAction`; a non-privileged Member rejected on every one of create/update/mark-paid/
cancel/delete plus the read gate itself; `loadCrmData` for that same org, loaded as non-privileged,
proven to carry zero `Payment` rows and zero `payment`-kind activities while every other activity
kind is still present (the activity-leak regression guard); delete-blocked-while-paid → cancel →
delete-now-allowed; the 101-membership pagination case above.

**Live-verified against real Neon data**, not just the test suite: signed in as the real admin in
"Nexo Verified Org" via a minted Clerk sign-in ticket — Payments nav item visible, created a real
$4,200 payment (persisted `pending`, activity logged as "logged a payment on &lt;deal&gt;" with no
digits in the title, nothing leaked onto the Dashboard), marked it paid (delete control
correctly disappeared), cancelled it, deleted it. Then signed in as a real Member in the same
org: no Payments nav item, and hitting `/payments` directly redirected away — confirmed
unreachable, not just hidden.

**Deferred**: `resolveAuth()`'s on-demand path still only sets `Owner.role` the first time a row
is *created* — it never re-syncs an existing row's role from the session's live `orgRole` claim,
even though that claim is available on every request (see `requireAuth()`'s `sessionOrgRole`).
`requirePaymentAccess()` works around this for payments specifically by checking both sources
independently, but every *other* `requireAdmin()`-gated action (currency, stage management) still
trusts `Owner.role` alone and can lag a real-time Clerk promotion/demotion for however long the
`organizationMembership.updated` webhook takes to land. A general fix — having `resolveAuth()`
opportunistically self-heal `Owner.role` from `sessionOrgRole` on every request when they disagree
— would close that gap everywhere at once instead of one-off two-source checks per feature. Not
built here: it's a broader behavior change to the primary auth path that touches every request,
not a payments-scoped fix, and deserves its own sign-off rather than riding in on this feature.

## Added an org-level currency setting, replacing hardcoded USD everywhere (Oct 15 2026)

### Schema

`Organization.currency String @default("USD")` — additive migration
(`20261015120000_org_currency`), so every existing org keeps behaving exactly as today until an
admin explicitly changes it.

### Settings: a real field, not the decorative one that was already there

Settings' Workspace section already had a "Default currency" `<Select>` — it was pure decoration
(`defaultValue="usd"`, no `onChange`, never persisted; found by grep while locating every call
site). Wired it up for real instead of adding a second field next to a fake one: 8 supported codes
(`CURRENCY_CODES` in `src/data/types.ts` — USD, PKR, EUR, GBP, AED, SAR, CAD, AUD, a curated list
rather than any valid Intl code, matching how this app already treats lead sources/task types as
closed sets), admin-only (disabled for non-admins client-side, **and independently rejected
server-side** — see below), persisted through the same dirty-state/Save-Cancel pattern
`updateQuota` already uses. Changing it shows a confirmation modal first: "relabels every amount
... does not convert existing values," with a concrete example, before the save actually fires.

### Admin enforcement: a new `requireAdmin()`, not a UI-only check

`requireAuth()` already fetched the full `Owner` row internally but only returned
`{orgId, ownerId}` — it now also returns `role` (free, same query, no extra DB round-trip). Added
`requireAdmin()` next to it: calls `requireAuth()`, throws `"Admins only"` unless `role === 'Admin'`.
`updateCurrencyAction` uses it, plus validates the code against `CURRENCY_CODES` server-side — a
non-admin or an invalid code is rejected before any write, never trusting client input for either
check. This is the first admin-gated action in the app (`updateQuotaAction`, by contrast, has no
role check at all today — left as-is, out of scope for this task).

### Formatting: every call site found by search, not memory

`currency()`/`currencyCompact()` (`src/lib/utils.ts`) now take a `currencyCode` parameter
(`= 'USD'` default only for the rare caller with no org context) and format through
`Intl.NumberFormat`'s own `style: 'currency'` — no more manually prefixing a hardcoded `$`.
`currencyCompact` previously hand-built its "$148K" string; now Intl's `notation: 'compact'` does
it natively per-currency (verified: `$66.5K` / `PKR 66.5K` / `€148K`, matching the exact compact
format the task asked for). Added `currencySymbol(code)` (pulls just the symbol/prefix via
`formatToParts`) for the three input fields that had a bare hardcoded `$` span: New Deal, Edit
Deal, and the lead-conversion "Convert to deal" modal (all three found by grepping for a literal
`$`, not recalled from memory — also widened their `pl-6` input padding to `pl-10` since 3-letter
codes like "AED" need more room than "$").

Every screen with a money display now pulls `orgCurrency` from `useCrm()` and formats through it:
Dashboard, Pipeline (including the `DealCard` subcomponent, which has its own `useCrm()` call),
Reports (both tables + the revenue chart's `valueFormat`), Contacts, Leads, RecordDetail (lead
est. value, contact account value, deal value, and the convert-to-deal modal), CompanyDetail, and
CommandPalette's deal search results. Confirmed via `grep -rn "currency(\|currencyCompact("` that
zero call sites remained on the old no-currency-code signature after the pass.

CSV exports (Leads, Pipeline, Contacts, both Reports tables) already wrote raw numbers with no `$`
— added a `currency` column to each so the number's unit is still recorded in the file.

### Overdue-no-code-change: `quarterlyQuota`

Left `updateQuotaAction` without a role check and `Deal.value`/`Lead.estValue`/etc. as plain
`Int` — out of scope for this task (the user asked about currency *formatting*, not quota
permissions or a value-precision change).

### Whole-unit Int: still fine, not currency-specific

`Deal.value` and friends stay plain `Int` (whole units — dollars, rupees, euros, whichever).
`currency()` already hardcoded `maximumFractionDigits: 0` for every currency before this change,
so the app has never stored or displayed sub-unit precision for *any* currency — this isn't a
currency-specific limitation, it was already the uniform convention. If fractional amounts (cents)
are ever needed, every supported currency would need it added consistently — minor-unit integers
(cents) or a real decimal type — which is a value-precision change orthogonal to currency
selection, not something picking a different `currency` code triggers on its own.

### Verified against real Neon data, live

Switched **Nexo Verified Org** (real org, real data) to PKR through the actual Settings UI:
confirmed the relabel-not-convert confirmation modal's copy, confirmed persistence to Neon,
then confirmed PKR actually renders on Dashboard ("PKR 285K"), Pipeline, Reports, the Settings
quota field, and the New Deal modal's value-field prefix — and confirmed the old bare `$` is gone
from all of them. Switched back to USD through the same UI and confirmed Dashboard shows `$`
again. Throughout, confirmed **Muhammad Rayan's Organization** (a second, real, unrelated org)
stayed on USD at the database level the entire time — zero leakage between orgs.

Cross-tenant suite grown from 75 to **78** tests: `updateCurrencyAction` only ever changes the
caller's own org (org A's admin changing currency never touches org B's row, even though both
calls go through the same org-resolved-from-session code path with no explicit target id to
mix up); a Member-role caller is rejected with "Admins only" before any write; an unsupported
currency code is rejected even for an admin.

Full `vitest run` (78/78) and `npm run build` both clean.

### Files changed

`prisma/schema.prisma`, `prisma/migrations/20261015120000_org_currency/` (new), `lib/auth.ts`
(`requireAdmin`), `lib/actions/crm.ts` (`updateCurrencyAction`), `lib/data/organizations.ts`
(`updateOrgCurrency`), `lib/data-loader.ts`, `src/data/types.ts` (`CURRENCY_CODES`/`CURRENCY_LABEL`),
`src/lib/utils.ts` (`currency`/`currencyCompact`/`currencySymbol`), `src/store/crm.tsx`
(`orgCurrency`/`updateCurrency`), `src/screens/Settings.tsx`, `src/screens/Dashboard.tsx`,
`src/screens/Pipeline.tsx`, `src/screens/Reports.tsx`, `src/screens/Contacts.tsx`,
`src/screens/Leads.tsx`, `src/screens/RecordDetail.tsx`, `src/screens/CompanyDetail.tsx`,
`src/components/common/NewDealModal.tsx`, `src/components/common/EditDealModal.tsx`,
`src/components/layout/CommandPalette.tsx`, `tests/integration/cross-tenant.test.ts`.

## Refined the Dashboard's task widget into a real workload view (Oct 15 2026)

### Starting point (reported before changing anything)

The Dashboard's only task surface was the "Today's focus" card: `tasks.filter(t => !t.done &&
t.ownerId === currentUser.id)`, sorted by due date, subtitle showing the real total count — but
only the first 4 were ever rendered (`myTasks.slice(0, 4)`), with no grouping, no overdue/today/
upcoming separation (TaskRow itself already tints overdue due-dates red via `dueLabel`, but there
was no section-level grouping), and no team-wide toggle — current-user tasks only. "All tasks"
link and an honest "Inbox zero" empty state both already existed. `TaskRow` (with its working
edit/delete/complete controls) was already being reused, not duplicated.

### What changed

Replaced it with a "Task workload" card:
- Three grouped sections — **Overdue** (`dayDelta < 0`, header styled `text-negative` for visual
  distinction), **Due today** (`dayDelta === 0`), **Upcoming (7 days)** (`0 < dayDelta <= 7`) —
  each with its own real count in the header, computed the same way as the rest of the app
  (`dayDelta` from `lib/utils.ts`).
- A `Segmented` "Mine" / "Team" toggle (same pattern Pipeline's "All deals / My deals" already
  uses), defaulting to Mine. Team rows show the owner avatar (`TaskRow`'s existing `showOwner`
  prop — no new prop needed).
- Each section renders through the existing `TaskRow` unmodified — same edit/delete/complete
  controls, no second implementation. Rows are capped at 5 per section for card real estate; when
  a section has more, a "+N more — view all" link to `/tasks` appears **below** the cap, but the
  section header's count is always the true, uncapped count.
- A single combined empty state ("Inbox zero") when all three sections are empty for the active
  scope, with scope-aware copy.

### Verified against real Neon data

Seeded 6 real test tasks spanning all three buckets, split across "mine" and a teammate ("Casey"),
since every pre-existing task in the dev org had drifted into "overdue" by the time this ran
(system clock had moved to Oct 15). Then, live against the real app:
- Computed expected overdue/due-today/upcoming counts directly from Neon using the exact same
  `dayDelta` logic, for both Mine and Team scopes, and confirmed the on-screen section headers
  match exactly (6/6 count checks passed).
- Confirmed the 5-row display cap and its "+N more" indicator work correctly: with 6 real overdue
  team tasks, the 6th (the newest/least-overdue, since overdue sorts most-overdue-first) correctly
  doesn't render as a row, and "+1 more overdue" appears instead — the section header still shows
  the true "6", not "5".
- Confirmed completing a task from the Dashboard updates the section count **immediately**
  (optimistic: before=2, after=1, same render cycle) and that it actually **persists to Neon**
  (confirmed via a direct follow-up query, after accounting for a test-script timing issue — my
  first check ran before the server action's own write had landed, not an app bug).
- Rollback-on-failure was **not** re-tested live: it's the same `toggleTask` call `TaskRow` already
  made before this change (unmodified), already verified earlier this session for the Tasks page
  and record-detail tabs. Since Overdue/Today/Upcoming are plain `.filter()`s derived from the same
  live `tasks` array on every render, a rollback (which just resets `task.done` back to `false` in
  that array) reappears in its section automatically — there's no separate cache to go stale.
- Full `vitest run` (75/75) and `npm run build` both clean. All test fixtures cleaned up from Neon
  afterward.

Files changed: `src/screens/Dashboard.tsx`.

## Applied the RelativeTime hydration fix everywhere `relativeTime()` was called during render (Oct 2 2026)

Follow-up to the Dashboard hydration fix immediately below: found and fixed every other place in
the app with the identical structural bug.

**Found by searching, not guessing:** grepped the whole `src/` tree for `relativeTime(` call
sites. Found four beyond the one already fixed in `ActivityStream.tsx`:
- `src/screens/Leads.tsx` — the "last activity" list column.
- `src/screens/Contacts.tsx` — both the "by company" group header's relative time and the flat-view
  "last interaction" column.
- `src/screens/RecordDetail.tsx` — the "Last activity" field in the profile panel.

All four called `relativeTime(iso)` directly during render, on 'use client' pages that still get
server-rendered on first load — the exact same SSR-vs-hydrate race as the Dashboard bug.

**Fix:** extracted the `RelativeTime` component out of `ActivityStream.tsx` into its own module,
`src/components/common/RelativeTime.tsx` (same structural fix as before — renders the stable
`formatDate` on both the server pass and the client's first/hydrating pass, swaps in the live
`relativeTime` label via a post-mount `useEffect`), and swapped all five call sites (the original
plus these four) over to it.

**Verified, not just applied:**
- Live-checked all four locations after the change: Leads list, Contacts "by company" view,
  Contacts flat view, and RecordDetail's profile panel all still show real relative-time text
  ("Xm ago" / "Just now" / etc.), with zero hydration errors across those navigations.
- Ran the same deterministic near-minute-boundary test used for the Dashboard fix against Contacts'
  detail page: bumped a real contact's `lastInteractionAt` to ~2s before a minute boundary, then
  fired a fresh navigation timed so hydration would land on the other side of it — 0 hydration
  errors, confirming the race is closed there too, not just reasoned about.
- Full `vitest run` (75/75) and `npm run build` both clean.

Files changed: `src/components/common/RelativeTime.tsx` (new), `src/components/common/ActivityStream.tsx`,
`src/screens/Leads.tsx`, `src/screens/Contacts.tsx`, `src/screens/RecordDetail.tsx`.

## Fixed the Dashboard hydration-mismatch warning (Oct 2 2026)

Investigated the hydration warning the previous task flagged as a minor aside.

**Reproduced first, not assumed:** scripted 10 fresh full-page navigations to Dashboard from
various starting pages. It fired on 1 of 10 (confirming the original "fired once" report) —
genuinely intermittent, not deterministic.

**Root cause, found by code trace:** `ActivityFeed` (`src/components/common/ActivityStream.tsx`,
used only by Dashboard's "Recent activity" card) called `relativeTime(item.at)` — which renders
"Just now" / "2m ago" / etc. — directly during render. Dashboard is a `'use client'` page that
still gets server-rendered on the initial load; `relativeTime` is called once on the server at
request time and once more on the client during hydration, a few seconds later. Any activity
timestamped near a whole-minute boundary at request time can tick from "Just now" to "1m ago" in
that gap, so the server-rendered text and the client's hydration-time text genuinely disagree —
a real mismatch, not a flake in the tooling. (Checked the rest of the app for similar `new
Date()`-during-render patterns first — `dayDelta`-based text elsewhere compares at day granularity,
which is for-practical-purposes never going to flip within an SSR-to-hydrate gap, so this was the
one real culprit.)

**Fix:** `ActivityFeed` now renders through a small `RelativeTime` component that shows the stable,
minute-insensitive `formatDate(iso)` on both the server pass and the client's first (hydrating)
pass — identical by construction, since `formatDate` has no second/minute-level time dependency —
then swaps in the live `relativeTime` label via a `useEffect` that only ever runs post-mount, after
hydration has already committed. This isn't a probabilistic improvement; it's structurally
impossible for the initial paint to mismatch anymore, since neither render pass touches "now" at
all until after React has already reconciled against the server HTML.

**Verified, not just reasoned about:**
- Re-ran the same 10-navigation sweep against the fixed code: **0/10** hydration errors (down from
  1/10 before the fix).
- Ran a second, deterministic test: created a real Activity timed a couple seconds before a minute
  boundary (the exact condition that should trigger the bug) and navigated to Dashboard — 0
  hydration errors.
- Full `vitest run` (75/75) and `npm run build` both clean after the change.

**Scope note:** `relativeTime` was also called the same way at a few other call sites (Contacts'
"last interaction" column, Leads' "last activity" column, RecordDetail's "Last activity" field).
Only Dashboard's activity feed was fixed in this pass — see the entry above this one for the
same fix applied everywhere else.

Files changed: `src/components/common/ActivityStream.tsx`.

## Wired Reports export, Companies export, and Tasks/Owners in the command palette (Oct 2 2026)

Follow-up to the audit immediately below, fixing three of its findings.

- **Reports "Export" button** (`src/screens/Reports.tsx`) was fully dead (no `onClick` at all). Unlike
  Leads/Contacts/Pipeline, Reports has no single flat list — it shows two real tables ("Performance
  by lead source" and "Rep attainment"). Rather than picking one arbitrarily, Export now calls the
  same `exportCsv()` twice, once per table, same pattern as every other export in the app. Verified
  live: clicking Export produces `reports-by-source.csv` and `reports-rep-attainment.csv`, both with
  real header rows and real data (`Inbound,7,6,86,209000,129500,100`, etc.) matching what's on screen.
- **Companies export** (noted missing in the audit — Companies never had an Export button at all).
  Added one in the same position/style Leads and Contacts use (secondary button, Download icon,
  left of the primary "New company" button), exporting the currently-filtered/sorted rows with
  name, industry, website, and the three real rollup counts (leads/contacts/deals) shown in the
  table. Verified live against real data — `Audit Corp,,,4,3,2,...` matches its known rollup
  (4 leads/3 contacts/2 deals) exactly.
- **Command palette** (`src/components/layout/CommandPalette.tsx`) now indexes Tasks and Owners,
  following the exact pattern the existing Leads/Contacts/Deals/Companies rows already use. Tasks
  have no detail route of their own (same situation Deals were already in), so a task result opens
  `/tasks`, same fallback Deals already used for `/pipeline`. Owner results open `/settings`. Both
  verified live: searching a real task's title and a real owner's name both surface the correct
  result.

Full test suite (75/75) and `tsc`/`npm run build` all clean after the change. Files changed:
`src/screens/Reports.tsx`, `src/screens/Companies.tsx`, `src/components/layout/CommandPalette.tsx`.

The Oct 2 audit below is otherwise unchanged — these three items are now fixed, out of its
"prioritized findings" list; everything else in that audit (the Tasks real-time gap, the other
dead controls, the "known/acceptable gaps" and "not built" lists) still stands as written.

## Full honest state-of-the-codebase audit (Oct 2 2026)

Re-verified every major feature area against the real running app and real Neon data — not
against what earlier changelog entries claimed. **The old "Status" section below (originally
written Sep 27 2026) and most of "Known gaps / explicitly deferred" (originally Sep 24–27 2026)
are stale** — many of the gaps they list were fixed in the weeks since and never removed from that
list; this section is the current source of truth. See each area for specifics.

| Area | Verdict | Notes |
|---|---|---|
| Auth & multi-tenancy | **PASS** | Sign-in, org creation/selection, sign-out all real (`useClerk().signOut()`). Org switching live-verified: switching to an empty second org via the real `OrganizationSwitcher` correctly reloads to zero records, with the first org's data (e.g. "Audit Corp") gone from the page — proves a real org-scoped server reload, not stale client cache. Brand-new sign-up (password + email-code) could not be click-tested end-to-end in this sandbox (Clerk's Cloudflare bot-check is unreachable from here); the redirect-destination half of that flow was separately verified fixed (see the invite-redirect entry below), and the membership→Owner-row webhook path was independently proven live. |
| Leads | **PASS** | Create (incl. inline company creation), edit, status, both conversion paths (contact-only live end-to-end: lead→qualified, real Contact row created, zero Deal rows; with-deal verified by code path + live dialog), activity logging, note persistence — all confirmed live against Neon or by direct code trace. |
| Contacts | **PASS** | Create with real company link, duplicate-email rejection (UI error shown AND zero duplicate row written), edit, company linkage — all live-verified against Neon. |
| Companies | **PASS** | List/detail rollups match Neon exactly (spot-checked "Audit Corp": 4 leads/3 contacts/2 deals, all correct); inline create-or-select from Lead/Contact/Deal forms verified live (again, independently, this audit); delete blocked with a clear message while linked, verified live. |
| Deals | **PASS** | All four creation entry points wired to real `createDealAction`; kanban drag-and-drop is genuine HTML5 DnD (not a menu-only fallback) persisting via tenant-checked `moveDealAction`; Won/Lost close-date stamping rule identical on client and server; stage rename/reorder/add/delete-with-safety all call real, tenant-checked server actions. No gaps found. |
| Tasks | **PASS** for create (3 entry points)/edit/delete/completion/assignment — all real, tenant-checked, reachable from every `TaskRow` (Dashboard, Tasks page, record detail). **CONFIRMED GAP (still present):** an assigned task does **not** appear for the assignee without a manual refresh/navigation — `CrmProvider` only re-fetches on a fresh server render of the layout; `revalidatePath` only affects the acting user's own next request, there is no websocket/SSE/polling anywhere in the repo. This was flagged as a concern and is now definitively confirmed true, not fixed. |
| Dashboard & Reports | **PASS** | Every stat on both screens traced to a real query over real data; no `Math.random()`, no hardcoded literals, no TODO/mock markers found anywhere in `src/` or `lib/`. Quota comparison reads real `Organization.quarterlyQuota`, has an honest null-state prompt, and is tenant-checked end to end. **`src/data/mock.ts` is gone** (deleted as dead code during the Company migration) — the old "Known gaps" entry below describing it as still-imported fabricated chart data is stale. |
| Team Settings | **PASS** | Invite now redirects into this app (not Clerk's hosted portal) — re-verified live via the actual UI this audit. Role change persists to Neon and was reverted cleanly after testing. Pending invitations list and Revoke both live-verified against real Clerk data. Remove-with-confirmation verified by code (identical confirm/persist/rollback pattern already proven for Task/Company/Stage deletion) — not exercised against the real second member live, to avoid disrupting an actual account. |
| Search & Export | **PASS.** ~~Command palette indexes Leads/Contacts/Deals/Companies (not Tasks or Owners)~~ / ~~Companies has no export button~~ / ~~Reports' "Export" button has no `onClick`~~ — **all three fixed same-day**, see "Wired Reports export, Companies export, and Tasks/Owners in the command palette" above. |
| Cross-tenant isolation | **PASS** | `tests/integration/cross-tenant.test.ts`: **75/75 passing** (grown from 63 after the Company work). Manually spot-checked live by switching the test user into a second, empty org — zero leakage of the first org's data. |

### Dead controls found (not previously flagged, or previously flagged and never actually fixed)

- `src/screens/Leads.tsx`: "Add filter" button (shows a filter count, no `onClick`); bulk "Email" button; bulk "Delete selected" icon button; per-row menu's "Log activity" / "Send email" / "Delete lead" (all just close the menu).
- `src/screens/Contacts.tsx`: per-row popover's "Log activity" / "Add to sequence" / "View company" / "Delete contact" (all just close the menu).
- `src/components/layout/Sidebar.tsx`: account menu's "Profile & preferences" / "Notification settings" / "Keyboard shortcuts" (all just close the menu).
- `src/screens/Dashboard.tsx`: "Last 30 days" button; "View full history" button.
- `src/screens/Reports.tsx`: "This quarter" button; **"Export" button** (no `exportCsv` wiring at all — the only dead Export button in the app; every other Export button actually works).
- `src/screens/Settings.tsx`: "Upload photo" button.

None of these regressed from a previously-working state — they were never wired. PROGRESS.md's Sep 30
"Wired up dead controls" entry addressed a different set (activity logging, export, reassign, profile
save); these are additional ones that entry didn't cover.

### Prioritized findings

**Real bugs needing a fix (if this app were going to real customers):**
1. Tasks: no live-update mechanism, so an assignee doesn't see a newly-assigned task without reloading. Would need polling, SSE, or a websocket layer — a real architectural addition, not a quick fix.
2. ~~Reports "Export" button is fully dead~~ — fixed same-day, see the entry above this audit.

**Known/acceptable gaps (fine for now, not blocking):**
- ~~Command palette doesn't index Tasks or Owners~~ / ~~Companies list has no CSV export~~ — both fixed same-day, see the entry above this audit.
- The dead per-row menu items (Log activity, Send email, Add to sequence, View company, Delete contact/lead) and dead header buttons (Add filter, bulk Email/Delete, Last 30 days, View full history, This quarter, Upload photo, Profile & preferences, Notification settings, Keyboard shortcuts) — all look like intentionally-scaffolded future features, consistent in style with the rest of the app, not broken regressions.
- Brand-new sign-up couldn't be click-tested in this sandbox due to a Cloudflare bot-check network limitation specific to the test environment.

**Not built (by design, not a regression):**
- No real-time/live-collaboration layer anywhere in the app.
- No Companies CSV export.
- No deal detail page (deals are only ever shown inline — Pipeline board, record-page "Deals" tab, company-page rollup).

### Stale PROGRESS.md entries corrected by this audit

The "Status" section (originally Sep 27 2026) claims "field editing, a Company entity and
contact-only convert are not built" — all three have since been built (see the dated entries
above them) and are now confirmed working; that section is historical only, not current state.
The "Known gaps / explicitly deferred" section is similarly stale in several places: it still
describes `src/data/mock.ts` as imported by Dashboard/Reports (the file no longer exists — deleted
as confirmed-dead code during the Company migration), still lists "no field editing" and "pending
invitations aren't listed" as open gaps (both fixed), and still calls Settings profile/workspace
Save unwired (it persists via `updateProfile` → `updateProfileAction`, confirmed working). Left
in place below for historical record, but **do not treat anything in "Status" or "Known gaps" as
current without re-checking against the code** — that's exactly what this audit found rotted.

## Fixed Team Settings "Invite" landing on Clerk's hosted portal instead of this app (Oct 1 2026)

A real invite test showed the recipient getting "a plain 6-digit numeric code with no mention of
the organization" instead of a proper org invitation. Investigated end to end rather than guessing.

### What was actually happening

`handleInvite` (`src/screens/Settings.tsx`) was calling the client SDK's
`organization.inviteMember()`, which **is** the real Clerk org-invite API — confirmed via the
Clerk Backend API that it creates a genuine `OrganizationInvitation` record, and confirmed (by
reading the actual email through Mailinator's public inbox for a fresh test address) that Clerk
sends a correctly-worded invitation: *"Muhammad Rayan has invited you to join the Muhammad Rayan's
Organization organization on CRM... Accept invitation"*. So the invite creation and the email
content were never the bug.

The bug was the **destination of the "Accept invitation" link**. `organization.inviteMember()` (the
client SDK method) has no `redirectUrl` parameter, and nothing else in the app configured one. Without
it, Clerk falls back to its own hosted Account Portal (`<slug>.accounts.dev`) to complete the
invitation — a generic, unbranded Clerk page, not this app's own `/sign-up`. Landing there to
complete a brand-new sign-up (password + email verification code) is almost certainly what looked
like "just a 6-digit code with no org mention" — the invitation *email* mentioned the org correctly,
but the page the link led to didn't carry that framing, because it was never this app's own UI.
This is the same class of bug `middleware.ts` already pins `signInUrl`/`signUpUrl` against for the
ordinary sign-in/up flows (see its comment) — organization invitations just aren't covered by that
fix, since they need their own, separately-configured redirect.

### The fix

Moved invitation creation server-side: `inviteMemberAction` (`lib/actions/crm.ts`) uses
`clerkClient().organizations.createOrganizationInvitation()` (the Backend SDK, which *does* accept
`redirectUrl`) instead of the client SDK, deriving the base URL from the request's own `host` header
so it works in any environment without a new hardcoded/env-configured app URL. `orgId`/`userId` come
straight from `auth()`, not client input. `Settings.tsx`'s `handleInvite` now calls this action
instead of `organization.inviteMember()`.

### Verified for real, not just "an email was sent"

- Confirmed via the Clerk Backend API that the invitation ticket created by the **actual Settings
  UI** ("Invite" button, clicked through Playwright) now carries `redirectUrl: http://localhost:3000/sign-up`
  in its signed ticket payload, where before the fix it carried no `rurl` claim at all and the
  browser landed on `<slug>.accounts.dev` instead of this app.
- Followed the real "Accept invitation" link end to end: before the fix, it landed on Clerk's
  hosted portal; after the fix, the same flow redirects to `http://localhost:3000/sign-up` with the
  ticket attached — this app's own branded sign-up page.
- Could not fully click through a **brand-new** account's password + email-code steps inside this
  sandboxed headless-Chrome environment — Clerk's bot-protection (Cloudflare Turnstile) challenge
  subdomain is unreachable from here even with a Clerk testing token appended, which looks like a
  sandbox networking limitation (the exact hostname resolves to IPv6-only addresses; outbound IPv6
  appears blocked in this environment) rather than an app issue. Flagging this honestly rather than
  claiming a full UI click-through that didn't actually complete.
- Independently verified the other half of the loop instead: created a real Clerk user and added
  them as an org member directly via the Backend API (what a completed sign-up produces), and
  confirmed the existing `organizationMembership.created` webhook (already built and tested in an
  earlier task) created a real `Owner` row in Neon within seconds, with the correct `orgId`,
  `clerkUserId`, and `role: "Member"`. Cleaned up all test invitations, memberships, and users
  created during this investigation.

### Why earlier verification missed this

Every previous live-verification pass this session signed in via a **sign-in ticket** for an
*existing* account (`ticket.js`), never through a brand-new account's actual sign-up — so the
organization-invitation-specific redirect path was never exercised. The bug was invisible to every
check that only ever used already-provisioned test accounts.

### Files changed

`lib/actions/crm.ts` (new `inviteMemberAction`), `src/screens/Settings.tsx` (`handleInvite` now
calls it instead of the client SDK).

## Made Company a real entity, replacing the plain string field (Oct 1 2026)

Lead/Contact/Deal each had a plain `company: String`. Promoted it to a real `Company` model with
its own id, relations, and detail page — the actual payoff being company-level rollups (every
Lead/Contact/Deal at a company, visible in one place) and a real place to hang a website/industry/
notes, instead of a free-text string that drifted across records.

### Schema: additive FK, then cutover, in two separate migrations

Went in two steps, each applied directly to Neon and verified before the next:

1. **`20261001150000_add_company`** (additive) — created the `companies` table (`id, orgId, name,
   website, industry, notes, createdAt, updatedAt`) and added a **nullable** `companyId` to
   `leads`/`contacts`/`deals`, alongside their existing `company` string column (left untouched).
   This let the backfill run and be verified before anything destructive happened.
2. **Backfill** (one-off script, not a migration) — per org, grouped every Lead/Contact/Deal's
   `company` string by `.trim().toLowerCase()`; one `Company` row created per distinct group
   (name = the first-seen original casing), every record in that group linked via `companyId`. No
   fuzzy matching across different-looking names, as decided — "Fjord Marine" and "Fjord Marine
   Group" became two separate Company rows, not one.
3. **Verified lossless** before touching anything else: every Lead/Contact/Deal has a non-null
   `companyId` (0 unlinked), 0 orphaned `companyId` references, 0 cross-org leakage (a record's
   `companyId` always resolves to a Company in that same org), and every linked Company's `name`
   round-trips the original string case-insensitively. Real counts: **17 companies created, 38
   records linked** across the only two orgs with real company data (15 companies / 34 records in
   "Nexo Verified Org", 2 companies / 4 records in "Muhammad Rayan's Organization"; the other three
   real orgs had zero Lead/Contact/Deal data to migrate).
4. **`20261001160000_company_cutover`** — once verified, dropped the old `company` string columns
   on all three tables and made `companyId` `NOT NULL`. The stale `contacts_orgId_company_idx`
   (on the now-gone string column) was dropped in the same migration; the `(orgId, companyId)`
   indexes added in step 1 replace it.

**Near-duplicates found during the backfill survey, flagged here per instructions (not merged):**
- **"Fjord Marine" vs "Fjord Marine Group"** (Nexo Verified Org) — likely the same company,
  different suffix. Left as two separate Company rows.
- **"Meridian Health" vs "Meridian Health Systems"** (Nexo Verified Org) — same shape of
  near-duplicate. Left as two separate Company rows.

These are flagged for a human to resolve manually (e.g. merging one into the other and
re-pointing its linked records) — nothing in this change attempts that automatically.

### Deletion: blocked while linked, not soft-deleted

`deleteCompany` (`lib/data/companies.ts`) explicitly counts linked Leads/Contacts/Deals first and
throws a clear, actionable error (`"Can't delete this company — it's still linked to N
record(s)..."`) rather than letting the DB's `ON DELETE RESTRICT` surface a raw constraint error.
No soft-delete flag was added — deleting an unlinked company is a real, permanent delete.

### Company picker: create-or-select inline, shared by all three forms

`CompanyPicker` (`src/components/common/CompanyPicker.tsx`) is a single component used by the
Lead/Contact/Deal new and edit forms: typing filters the org's existing companies (via a Popover +
search input), picking one selects it, and a name with no exact case-insensitive match offers
"Create '<name>'" — which calls `addCompany` (client-generated id, same `persist()`-less
optimistic-then-reconcile pattern as `addContact`) and selects the result in one step.
`createCompanyAction` itself also resolves to an existing case-insensitive match server-side
(returning `{existing: true}`) rather than ever creating two rows for the same name within an org —
covered by its own cross-tenant test (a same-named company created by org B never resolves to org
A's row).

### Frontend shape: `companyId` + a derived display `company` string

Rather than rewrite every display site (`lead.company`, `CompanyMark name={...}`, CSV exports,
etc.) to walk a nested relation, the frontend `Lead`/`Contact`/`Deal` types keep a `company: string`
field — now populated from the real `Company.name` by the mappers/store (via a new `companyById`
lookup, the same pattern `ownerById`/`stageById` already use) — alongside the new `companyId:
string` that every mutation actually sends to the server. Editing a company's name live-propagates
that string onto every Lead/Contact/Deal that links to it, both optimistically and on rollback.

### Tenant checks and the cross-tenant suite

Every Company operation is tenant-checked the same way every other entity in this app is:
`getCompanyById(orgId, id)` in the data layer, called by the action layer before any `connect`.
Extended the permanent `tests/integration/cross-tenant.test.ts` suite from 63 to **75 tests**,
adding: `getCompanyById`/`getCompanyDetail` read-isolation, `deleteCompany` write-rejection,
`updateCompanyAction`/`deleteCompanyAction` id-rejection, `createLeadAction`/`createContactAction`/
`createDealAction` rejecting a `companyId` from another org, `updateLeadAction`/
`updateContactAction`/`updateDealAction` rejecting a `companyId` from another org even on the
caller's own record, and the same-name-never-crosses-orgs test above.

### Live-verified against real Neon data

Via a minted Clerk ticket against "Nexo Verified Org" (the richest real dataset): the companies
list correctly shows "Fjord Marine"/"Fjord Marine Group" and "Meridian Health"/"Meridian Health
Systems" as separate rows with correct rollup counts; "Audit Corp"'s detail page lists all 4 real
linked leads, 3 contacts, and 2 deals exactly matching Neon; creating a new company inline from the
New Lead form persisted a real row and linked the new lead to it; deleting a still-linked company
is blocked with the exact "linked to N records" message (confirmed after a test-script timing fix —
the first pass checked the dialog before the server's 500 response had round-tripped, a bug in the
verification script, not the app). Full `vitest run` (75/75) and `tsc --noEmit` both clean; `npm
run build` succeeds with `/companies` and `/companies/[id]` both compiling as dynamic routes.

### Files changed

Schema/migrations: `prisma/schema.prisma`, `prisma/migrations/20261001150000_add_company/`,
`prisma/migrations/20261001160000_company_cutover/`.
Data layer: `lib/data/companies.ts` (new), `lib/data/leads.ts`, `lib/data/contacts.ts`,
`lib/data/deals.ts`, `lib/data/index.ts`, `lib/mappers.ts`, `lib/data-loader.ts`.
Actions: `lib/actions/crm.ts`.
Frontend types/store: `src/data/types.ts`, `src/store/crm.tsx`.
UI: `src/components/common/CompanyPicker.tsx` (new), `src/screens/Companies.tsx` (new),
`src/screens/CompanyDetail.tsx` (new), `src/screens/Leads.tsx`, `src/screens/Contacts.tsx`,
`src/screens/RecordDetail.tsx`, `src/components/common/NewDealModal.tsx`,
`src/components/common/EditDealModal.tsx`, `src/components/layout/Sidebar.tsx`,
`src/components/layout/CommandPalette.tsx`.
Routes: `app/(app)/companies/page.tsx` (new), `app/(app)/companies/[id]/page.tsx` (new).
Removed: `src/data/mock.ts` (dead code — unused mock dataset that would otherwise have needed 20+
fake company ids maintained for no reader).
Tests: `tests/integration/cross-tenant.test.ts` (63 → 75 tests).

## Added task editing and deleting (Oct 1 2026)

Tasks could previously only be created and toggled done/not-done. Added full edit and delete,
following the exact patterns already established for Lead/Contact/Deal editing and the Team
Settings Remove confirmation.

### Schema: Task.description

"Description" was one of the explicitly requested editable fields, but the `Task` model had no
such column. Added `Task.description` (`String?`, additive migration
`20261001140000_task_description`) — nothing else used this column before, so no backfill
concerns.

### Edit: same shape as updateLead/updateContact/updateDeal

`updateTask` (`lib/data/tasks.ts`) is a transaction with a `findFirst({id, orgId})` tenant check,
a diff against the existing row, a no-op skip when nothing actually changed, and an atomic
activity log — identical structure to the other three. `updateTaskAction` tenant-checks a
reassigned `ownerId` via `getOwnerById` before connecting it, same as every other action that
accepts a client-supplied owner.

**The one real wrinkle, and how it's handled:** `Activity` has no "task" subject type and no
`taskId` column — editing a Lead/Contact/Deal logs its "edited" activity against *itself*, but a
task has no "itself" to point at. The activity is instead attached to the task's own `relatedTo`
(the lead/contact/deal it's already linked to, if any) — exactly mirroring how `toggleTask`'s
existing "task" activity kind already works. A **standalone** task (no `relatedTo`) still gets a
real activity row logged (for the global "Recent activity" feed), just with no subject — it won't
show up on any specific record's timeline, because there isn't one for it to show up on. This
required no new migration or enum value, as asked — `ActivityKind.edited` is reused exactly as
it already exists.

### Delete: no activity logged, and why

`deleteTask` removes the row outright. Decided against logging an activity for it, for two
reasons: (1) same structural issue as above — there's no subject to attach a "deleted" activity
to for a standalone task, and attaching it to the related record for a *deletion* read oddly ("a
task that doesn't exist anymore was edited on this record"); (2) deleting a stale to-do is routine
list cleanup, not a business event like a deal closing or a lead converting — the kind of thing
this app already treats as audit-worthy. No FK depends on `Task.id` (confirmed — nothing else in
the schema references it), so deletion is safe and has no cascading-reference concerns the way
Owner deletion did.

Confirmation dialog follows the Team Settings Remove pattern exactly: `Delete "[title]"? This
can't be undone.`, Cancel/Delete footer, nothing fires until confirmed.

### Where it's wired: TaskRow itself, not per-screen

Rather than deciding separately for the Tasks page vs. the Dashboard's "Today's focus" card vs. a
record detail page's Tasks tab, the Edit/Delete "…" menu (and both modals) were added to the
shared `TaskRow` component all three already render through. One change wires every surface that
shows a task — including the record-page task box, which the task explicitly asked about —
rather than choosing to leave some of them minimal or duplicating the controls three times.

### Cross-tenant regression suite: extended again

Added to the permanent `tests/integration/cross-tenant.test.ts` suite: `updateTask`/`deleteTask`
(data layer) and `updateTaskAction`/`deleteTaskAction` (including the reassigned-`ownerId`
rejection, even on the caller's *own* task) all reject another org's ids. **63/63 total, all
passing** (58 previous + 5 new).

### Verified against real Neon data

Playwright + a real Clerk sign-in ticket, against real tasks in a real org (some fresh
self-provisioned fixtures to avoid depending on leftover state from other runs). 10 checks, all
passing:
- Edit persists title, description, *and* a real same-org reassignment to Neon, and shows
  correctly in the UI.
- A standalone task's edit logs exactly one activity with no subject; a task linked to a lead
  logs a real "edited" activity on that lead.
- A no-op save (clicking Save with nothing changed) leaves `updatedAt` untouched — confirmed by
  timestamp comparison, not just "no error."
- Delete's confirmation dialog shows the exact task title and consequence text; Cancel leaves the
  row in Neon untouched; Confirm actually removes it, and the row disappears from the UI.
- A genuine server-side rejection — the task's row deleted out from under a stale browser edit,
  a real race rather than a forged request — shows a real toast and the optimistic edit reverts
  cleanly, with no phantom "(edited)" row left on screen. (The cross-org-`ownerId` rejection
  itself is covered with real Neon assertions in the permanent test suite above; the UI
  structurally can't produce a cross-org owner id to forge that *specific* failure through real
  interaction, since the assignee dropdown only ever lists the caller's own org.)

Two of my own test assertions were initially wrong in ways worth recording honestly: one expected
zero activities for a standalone task's edit when the actual (correct, documented) behavior logs
one with a null subject; the other checked for the rollback too soon after the failure toast
appeared and needed a longer wait. Both were script bugs, confirmed by direct Neon queries and a
screenshot-driven retest — not application bugs.

Full 63-test suite and `npx tsc --noEmit` both pass. Files touched: `prisma/schema.prisma` + new
migration, `lib/data/tasks.ts`, `lib/actions/crm.ts`, `src/data/types.ts`, `lib/mappers.ts`,
`src/store/crm.tsx`, `src/components/common/TaskRow.tsx`,
`src/components/common/EditTaskModal.tsx` (new), `tests/integration/cross-tenant.test.ts`.

## Wired the Dashboard quota comparison to a real, persisted quota (Oct 1 2026)

Closes the recommendation from the Dashboard-honesty task: "Quarterly team quota" in Settings →
Workspace existed but had never been wired to save anything (`<Input defaultValue="1,200,000" />`
— a static placeholder, not backed by any field). Wired it end to end.

### The field itself needed wiring first

Added `Organization.quarterlyQuota` (`Int?`, additive migration
`20261001130000_org_quarterly_quota` — nullable and defaulting to unset, since "no quota has been
set yet" is a real, expected state this feature has to handle honestly, not an error). It's
org-level ("applies to all members of this organization," per the card's own subtitle), not
per-owner, so it lives on `Organization`, not `Owner`. New `updateOrgQuota`
(`lib/data/organizations.ts`) and `updateQuotaAction` (`lib/actions/crm.ts`) follow the exact
same shape as the earlier profile-save fix: `orgId` comes from `requireAuth()`'s own session,
never client input, so there's no separate tenant check needed beyond using that `orgId`
directly — the org row itself *is* the tenant boundary.

Settings' quota field now has its own small inline Save/Cancel (a checkmark/X next to just that
input, appearing only while it's dirty) — scoped deliberately to just this one field. The
Workspace card's other three fields (name, currency, fiscal year) are still the same unwired
placeholders they always were; giving the whole card one shared Save button would have implied
those saved too, which isn't true and wasn't part of this task.

### Dashboard: quarter-to-date revenue vs. the quota, not month-to-date

The old hardcoded target lived on the "Won this month" tile, but comparing a *month's* revenue
against an explicitly *quarterly* quota would have been a real (if easy to miss) unit mismatch. The
new comparison sums Won deals with a `closeDate` in the **current calendar quarter** and compares
that to the quota — shown as an addition to that same tile's footer: `"$X of $Y quota this
quarter (Z%)"`. Reused `useCrm()`'s already-loaded `deals`/`stageById` — no new query, following
the same "the data's already there, just compute it honestly" approach as the earlier trend-delta
work.

When no quota is set, the footer shows the exact honest prompt the task specified — "Set a quota
in Settings to see progress" — linked straight to the Settings page, instead of a zero-looking or
broken comparison.

### Data flow

`quarterlyQuota` is now part of `CrmInitialData` (`lib/data-loader.ts`, via the already-available
`getOrgById`) and exposed through `CrmState` alongside a `updateQuota` store method that follows
the store's standard `persist()`/toast/rollback pattern — identical in shape to `updateProfile`.

### Verified against real Neon data

Confirmed the full round trip on a real org with real Won-deal history:
1. **Before setting a quota**: Dashboard showed the honest "Set a quota in Settings to see
   progress" prompt (quota was genuinely `null` in Neon at this point).
2. **Set a quota via the UI** ($200,000) → confirmed it landed in Neon (`quarterlyQuota: 200000`).
3. Added one real Won deal closing in the current quarter ($50,000) and reloaded the Dashboard —
   it showed **"$50K of $200K quota this quarter (25%)"**, which is exactly correct
   (50,000 / 200,000).
4. **Cleared the quota** via the UI → confirmed Neon went back to `null`, and the Dashboard
   correctly reverted to the honest prompt rather than showing a stale or zero-looking figure.

All 6 real checks passed. (One of my own verification script's assertions initially "failed" over
an exact-string mismatch — it expected `"25.0%"`, the app correctly rendered `"25%"` per the
existing `percent()` helper's default of 0 decimal places; the app's output was right, my
assertion string was wrong, fixed by just reading the real output rather than rerunning.) Fixture
deal deleted afterward; quota left cleared (`null`) in that org, matching its state before this
verification began.

Full 58-test suite and `npx tsc --noEmit` both pass. Files touched: `prisma/schema.prisma` +
new migration, `lib/data/organizations.ts`, `lib/actions/crm.ts`, `lib/data-loader.ts`,
`src/store/crm.tsx`, `src/screens/Settings.tsx`, `src/screens/Dashboard.tsx`.

## Added the missing organizationMembership.deleted webhook handler (Oct 1 2026)

Closes the gap noted at the end of the previous Team Settings task: removing a member in Clerk
had no handler at all, so their `Owner` row just sat there forever with no indication they'd
left.

### Soft-delete, not a hard delete — and why

Checked the actual FK constraints before deciding anything: every `Lead.ownerId`, `Contact.ownerId`,
`Deal.ownerId`, `Task.ownerId`, and `Activity.actorId` foreign key to `Owner` is `ON DELETE
RESTRICT` (confirmed directly in the original migration SQL). A real `DELETE FROM owners` would
throw for any member who ever created a record or logged an activity — in practice, every real
team member. So a hard delete was never actually viable here, independent of preference.

Added `Owner.active` (`Boolean @default(true)`, additive migration
`20261001120000_owner_active`, applied to the real Neon database — confirmed all 7 existing owners
came through as `active: true`, which is correct: every current Owner really is still active).
`deactivateOwner(orgId, clerkUserId)` (`lib/data/owners.ts`) flips it to `false` via `updateMany`
(not `update`) so a webhook for a membership that was never fully synced to an Owner row is a
harmless no-op rather than a thrown error.

### Does this orphan any Lead/Contact/Deal/Task rows? No — by construction

Because the Owner row is never actually deleted, every record still assigned to a departed
member keeps a perfectly valid `ownerId`/`actorId` reference — there's nothing to reassign, and
nothing to block. Verified directly: created a real Lead and a real Task assigned to a test
owner, removed that owner, and confirmed both rows were untouched — same id, same `ownerId`,
still resolvable. The Owner's `name`/`email` are also preserved (not blanked out), so historical
activity/ownership attribution ("who actually did this") stays accurate instead of turning into
"Unknown" once someone leaves.

**Deliberately not built in this pass:** excluding inactive owners from the owner-assignment
dropdowns (`NewLeadModal`, `EditDealModal`, the bulk Reassign modal, etc.) so a departed member
can't be picked for *new* work. `getOwnerById` — the check every create/update action already
runs on a client-supplied `ownerId` — doesn't distinguish "this ownerId is unchanged from what's
already on the record" from "this is a brand-new assignment," so filtering it to active-only
would break editing any *existing* record still legitimately owned by someone who's since left
(the edit modals always resubmit the current `ownerId` even when the admin is only changing, say,
the name). Doing this properly needs the action layer to skip the active check when `ownerId`
isn't actually changing — a real but separate piece of work, not a side effect of wiring this
webhook. Flagging it here rather than either half-building it or silently leaving it unconsidered.

### Order-proofing, matching the pattern already used for org/membership updates

`handleMemberDeleted` (`app/api/webhooks/clerk/route.ts`) reads Clerk's *current* membership list
for that user before deactivating — the same principle `handleOrgUpdated`/`handleMemberCreated`
already use, for the same reason: Svix can redeliver or reorder events, so a stale `.deleted`
event arriving after the person has already rejoined must not deactivate someone who is, right
now, a real active member.

### Verified against real Clerk + Neon state (not a mock)

A disposable Clerk test user was created via the Backend API, added as a real membership to a
spare test org (`Nexo Fresh Org`), and assigned a real fixture Lead and Task. The webhook itself
was exercised by signing a real Clerk-shaped payload with the actual `CLERK_WEBHOOK_SECRET`
(via the `svix` package, mirroring this session's established local-webhook-verification
pattern — a live public tunnel isn't kept running for the whole session) and POSTing it straight
to the local `/api/webhooks/clerk` route, so the handler code under test is exactly what a real
Svix delivery would invoke.

12 checks, all passing:
- `organizationMembership.created` syncs a new, active Owner row.
- The real Clerk membership was actually removed (checked via `GET /organizations/.../memberships`)
  before the `.deleted` webhook was sent.
- `.deleted` → `200`, and the Owner row is soft-deleted (`active: false`) — never hard-deleted.
- The fixture Lead and Task, previously assigned to that owner, are completely untouched —
  same id, same `ownerId`, no orphaning.
- The removed owner's name/email survive for historical attribution.
- Redelivering the same `.deleted` event is a harmless no-op (idempotent).
- Rejoining (`organizationMembership.created` again) correctly reactivates the Owner
  (`upsertOwnerFromClerk`'s update branch now explicitly sets `active: true`).
- A *stale* `.deleted` event delivered after a real rejoin does **not** deactivate the
  now-current member — the order-proofing actually works, not just in theory.

Test Clerk user, membership, and the fixture Lead/Task/Owner rows were all cleaned up afterward.
Full 58-test suite and `npx tsc --noEmit` both pass. Files touched: `prisma/schema.prisma` +
new migration, `lib/data/owners.ts`, `app/api/webhooks/clerk/route.ts`, `src/data/types.ts`,
`lib/mappers.ts`, `lib/data-loader.ts`, `src/data/mock.ts` (type-only fixture update).

## Fixed three gaps in Team Settings (Oct 1 2026)

### 1. Remove member now confirms first

Clicking "Remove" on a team member used to fire `organization.removeMember()` immediately, no
undo. Added a confirmation `Modal` (`TeamSection` in `src/screens/Settings.tsx`) with the exact
required wording — "Remove [name] from the organization? They'll lose access immediately." —
before the real call fires. Cancel does nothing; Confirm runs the removal.

### 2. Role-change and Remove failures are no longer silent

Both used to swallow every error (`catch { /* silently fail */ }`) — an admin could get a genuine
Clerk API failure (network blip, permission issue, a stale/already-changed membership) and see
nothing, with no way to tell the change didn't take. Wired both into the store's existing
`persist()`/toast pattern: exposed `persist` from `CrmState` (`src/store/crm.tsx`) as a generic
escape hatch for mutations that don't map to the store's own optimistic CRM record state — the
exact same function every Lead/Contact/Deal edit already uses, just called with `activity:
undefined` since there's nothing to log here. On failure it shows a toast and re-syncs the list
from Clerk's real state (there's no local optimistic copy of the membership list to roll back —
the `<Select>`'s value comes straight from Clerk's own cache — so the "rollback" here is a
defensive revalidate rather than reverting a local mutation that never happened).

### 3. Pending invitations are now listed, with revoke

Added a "Pending invitations" section to Team settings using Clerk's own `useOrganization({
invitations: { status: ['pending'] } })` — no custom invitation tracking, exactly as asked. Shows
email, role, and sent date for every outstanding invitation, with a revoke button
(`invitation.revoke()`) wired through the same `persist()` pattern as #2. Sending a new invite now
also revalidates the invitations list (previously it only revalidated `memberships`, which was
never the right resource for showing a *pending* invite in the first place) so a freshly-sent
invite appears immediately. Resend was considered and deliberately not built: Clerk's SDK has no
resend primitive for an existing invitation, and the task only asked for revoke — building a fake
"resend" out of revoke+reinvite wasn't asked for and would have been new, undiscussed behavior.

### Verified against real Clerk + Neon state, not just the UI

Two disposable Clerk test users were created via the Backend API and added as real memberships to
a disposable test org (`Nexo Fresh Org`) for this — none of the app's other seeded test orgs had
enough membership quota headroom to add two more (Clerk's free-tier cap is 5 memberships +
outstanding invitations per org).

- **Confirmation dialog**: real dialog text matched exactly; clicking Cancel and then checking
  Clerk's own `GET /organizations/.../memberships` confirmed the member was still there; clicking
  Remove → Confirm and re-checking confirmed the membership was actually gone from Clerk, and the
  row disappeared from the UI.
- **Role-change happy path**: changed a real member's role via the UI, confirmed the change landed
  in Clerk's membership record, then polled Neon and confirmed `Owner.role` updated too — proving
  the existing `organizationMembership.updated` webhook sync (built earlier this session) still
  picks up a role change made through this exact UI path.
- **Role-change failure path**: deleted that same member's Clerk membership directly via the
  Backend API (simulating an external removal/race condition) without letting the browser's stale
  row refresh, then changed its role through the UI — a genuine Clerk API rejection, not a mock.
  Confirmed a toast appeared (`role="alert"`) and the page didn't crash.
- **Pending invitations**: sent a real invite through the UI, confirmed it appeared in the new
  section *and* in Clerk's own `GET /organizations/.../invitations?status=pending`; revoked it
  through the UI, confirmed it disappeared from the list and Clerk's API now reports
  `status: "revoked"` for that invitation.

13 checks, all passing. Test Clerk users and their Neon `Owner` rows were cleaned up afterward.

**Gap noticed and disclosed, not fixed (out of this task's scope):** removing a member from
Clerk currently leaves their `Owner` row behind in Neon — there's no `organizationMembership.deleted`
webhook handler (only `.created`/`.updated` are handled, see `app/api/webhooks/clerk/route.ts`).
Had to manually delete two orphaned `Owner` rows this test created. Worth a follow-up task.

Full 58-test suite and `npx tsc --noEmit` both pass. Files touched:
`src/screens/Settings.tsx`, `src/store/crm.tsx` (exposed `persist`).

## Replaced fabricated Dashboard/Reports/sidebar numbers with real data (Oct 1 2026)

Dashboard, Reports, and the sidebar were showing several hardcoded literals dressed up as real
metrics: a fabricated `monthlyPerformance` array for the two "revenue by month" bar charts, four
made-up trend percentages on Dashboard plus four more on Reports, a `$280K` "target" and a
sidebar "Q3 quota" widget with no underlying data at all, and sidebar "Closing in 30 days"/
"Champions" counts that were just literal props (`count={5}`, `count={3}`) never computed from
anything. Replaced all of it with real, honestly-computed values — and where a comparison
genuinely can't be made honestly, removed it or said so instead of inventing a number.

### What's real now

- **Monthly revenue chart** (Dashboard's "Closed-won revenue" card, Reports' matching card):
  `monthlyWonRevenue()` (new, `src/lib/utils.ts`) buckets actual Won deals by their `closeDate`
  into the last 6 calendar months and sums `value` per month — every bucket in the window is
  present even at zero, so a sparse org gets honest zero bars rather than a shorter chart padded
  with fake data. When the whole 6-month window has no closed-won revenue, an `EmptyState` ("No
  closed-won deals yet") replaces the chart entirely instead of rendering an all-zero graph that
  could be mistaken for real data.
- **Trend percentages**: `momDelta()` (new) computes a real month-over-month % change and returns
  `null` — rendered as *no delta badge at all*, never a fabricated placeholder — whenever the
  prior period has nothing to compare against. Applied to: Dashboard's "Won this month" and
  "Conversion rate" tiles; Reports' "Closed-won revenue", "Win rate", "Average deal size", and
  "Avg. sales cycle" tiles. Dashboard's "Open pipeline value" and "Active deals" tiles now show
  **no delta at all** (not "0%", not a proxy) — they're point-in-time snapshots with no historical
  tracking to trend against, so a real comparison isn't possible yet; inventing one would have
  been exactly the kind of fabrication this task was about removing. When a real comparison comes
  back null for a metric that used to always show one, the footer says so in words (e.g. "not
  enough history for a trend yet") rather than silently going quiet.
- **"Avg. sales cycle"** (Reports): was a hardcoded `38` with a hardcoded `-6.2%`. Now computed
  for real as the average days from a deal's creation to its close date among Won deals — a
  rougher proxy than an idealized "first touch to signature" (this app doesn't track a distinct
  first-touch event), so the footer now honestly says "Deal creation to close" instead of
  overclaiming. Found and fixed one rough edge while verifying against real Neon data: a
  demo-fixture deal's `closeDate` predated its own `createdAt` (a backfilled test row, not a real
  business scenario), which dragged the average negative (`-3 days`, displayed). Floored each
  deal's contribution at 0 — a deal can't really close before it existed — rather than either
  showing a nonsensical negative number or quietly excluding that deal's real close from the count.
- **Sidebar "Closing in 30 days" / "Champions"**: were literal `count={5}` / `count={3}` props,
  never connected to any data. Now computed in `Sidebar.tsx` from the same store data every other
  screen uses — open deals due within 30 days (identical definition to Dashboard's own "Closing
  in 30 days" card, including already-overdue ones) and contacts with `lifecycle === 'Champion'`.
- **`$280K` "Won this month" target and the sidebar "Q3 quota" widget**: removed outright — no
  org-level target-setting feature exists, so there was no real number to show. **Recommendation**
  for whoever builds that feature: Settings → Pipeline already has an unwired "Quarterly team
  quota" input (`src/screens/Settings.tsx`) that currently displays a hardcoded default and saves
  nothing; wire *that* field to a new persisted value (e.g. `Organization.quarterlyQuota`) and the
  Dashboard target and sidebar quota widget can both come back for real, computed as
  `wonThisQuarterValue / quota`. Didn't build that now — it needs the settings field wired up
  first, and inventing a number in the meantime was exactly what this task was about avoiding.

### Everything else found while in this code, left alone and disclosed rather than silently fixed

Reports' "Closed-won revenue" and "Win rate" `footer` text (`all time`, `won vs. lost`) and the
lead-source/rep-attainment tables were already real (computed from `deals`/`leads`/`owners`) —
no change needed there.

### Verified against real Neon data, two orgs with different amounts of history

Playwright + Clerk sign-in tickets, same method as every prior verification this session.
- **Nexo Verified Org** (4 real Won deals, all closed in September): expected values
  hand-computed directly from Postgres (`wonThisMonthValue=$0`, `wonLastMonthValue=$129,500` since
  today is Oct 1 and nothing has closed this month yet, real `closingSoon=4`, real `champions=0`)
  matched the rendered Dashboard/Reports/sidebar exactly, including a real `-100.0%` trend badge
  on "Won this month" — a stark but genuine number (October just started), not suppressed, because
  the prior period *did* have real data to compare against.
- **A brand-new org with zero deals** (auto-created on sign-in via the on-demand path in
  `resolveAuth()`, so this also doubled as a real test of that path plus `ensureDefaultStages`):
  confirmed the honest-empty-state path on both Dashboard and Reports, no trend badge on "Won this
  month" plus the "not enough history yet" footer text, and `closingSoon`/`champions` both
  correctly rendering `0` rather than the old hardcoded `5`/`3`.

13 checks across both orgs, all passing. `npx tsc --noEmit` and the full 58-test suite
(`tests/integration/cross-tenant.test.ts` — untouched by this task, still green) both pass.

### Files touched

`src/lib/utils.ts` (new `isMonthsAgo`, `momDelta`, `monthlyWonRevenue`), `src/screens/Dashboard.tsx`,
`src/screens/Reports.tsx`, `src/components/layout/Sidebar.tsx`, `src/data/mock.ts` (deleted the
now-fully-unused `monthlyPerformance` fixture). Also added `Deal.createdAt` to the frontend type
(`src/data/types.ts`) and `mapDeal` (`lib/mappers.ts`) — it existed in Prisma but was never
mapped through, and the sales-cycle metric needed it.

## Per-org PipelineStage system, replacing the hardcoded DealStage enum (Sep 30 2026)

Follow-up to the "Customize stages" decision flagged in the section below: built the real thing
rather than the placeholder button. `DealStage` was a fixed Prisma enum
(`discovery|proposal|negotiation|contract|won|lost`); it's now a per-org `PipelineStage` table,
and `Deal.stage` is a foreign key (`Deal.stageId`) instead of an enum value. Stages can be
renamed, reordered, added, and deleted per organization from Settings → Pipeline or Pipeline's
own "Customize stages" button (same underlying `StageManager` component, so the two entry points
can't drift apart).

### Schema and migration

`prisma/migrations/20260930130000_pipeline_stages/migration.sql` — hand-written (not
`prisma migrate dev`-generated), because it has to backfill existing data, not just alter the
schema:
1. Create `pipeline_stages` (id, orgId, key, label, order, probability, isClosed, isWon).
2. Seed **every existing org** with the 6 stages the enum used to represent — same keys, labels,
   order, probabilities, and Won/Lost flags the app already had (Discovery=20%, Proposal=45%,
   Negotiation=65%, Contract Sent=85%, Won=100%/isWon, Lost=0%/isClosed) — not the slightly
   different "Qualified" variant floated when this was first discussed; the goal was a lossless
   migration of what's actually in the enum today.
3. Add `deals.stageId` (nullable), backfill every deal by matching its old enum value to its own
   org's newly-seeded row with the same `key`, then make it `NOT NULL` and add the FK.
4. Drop the old `stage` column, its index, and the `DealStage` enum type.

Runs as one transaction (Prisma's default for a plain migration.sql), so a failure at any step
rolls back the whole thing. Verified against the real Neon database immediately after applying:
3 orgs → 18 seeded stages exactly; all 12 existing deals' `stageId` correctly resolved to a stage
belonging to their own org (0 cross-org mismatches); per-key deal counts unchanged from the
pre-migration snapshot (won:5, discovery:4, negotiation:1, contract:1, lost:1).

New orgs created after this migration get their 6 default stages from `ensureDefaultStages`
(`lib/data/stages.ts`), called from both places an Organization row gets created:
`resolveAuth()`'s on-demand path (`lib/auth.ts`) and the Clerk webhook's `organization.created`
handler. It's idempotent (a no-op once the org already has stages), so calling it from both paths
can never double-seed.

### Full blast radius (24 files touched)

Schema/migration: `prisma/schema.prisma`, the migration above.
Data layer: `lib/data/deals.ts`, `lib/data/leads.ts` (convertLeadToDeal's deal-creation branch),
`lib/data/stages.ts` (new), `lib/mappers.ts`, `lib/data-loader.ts`.
Auth/webhook: `lib/auth.ts`, `app/api/webhooks/clerk/route.ts`.
Server actions: `lib/actions/crm.ts` (`moveDealAction`, `createDealAction`, `updateDealAction`,
`convertLeadAction`, plus new `createStageAction`/`renameStageAction`/`reorderStageAction`/
`deleteStageAction`).
Frontend types/state: `src/data/types.ts`, `src/components/ui/Badge.tsx`, `src/store/crm.tsx`.
Screens/components: `src/screens/Pipeline.tsx`, `src/screens/Settings.tsx`,
`src/screens/Dashboard.tsx`, `src/screens/Reports.tsx`, `src/screens/RecordDetail.tsx`,
`src/components/common/EditDealModal.tsx`, `src/components/common/NewDealModal.tsx`,
`src/components/common/StageManager.tsx` (new), `src/components/layout/CommandPalette.tsx`.
Test data: `src/data/mock.ts` (unused dead fixtures, updated only to keep the type check green).
Tests: `tests/integration/cross-tenant.test.ts`.

### The Won-transition close-date logic, reworked

`closeDateOnStageChange` in `lib/data/deals.ts` used to compare stage identity by enum value
(`nextStage === 'won' && previousStage !== 'won'`). It now takes two `isWon` booleans instead —
`(previousIsWon, nextIsWon) => nextIsWon && !previousIsWon ? new Date() : undefined` — so a
renamed or custom "Won"-equivalent stage still triggers it correctly; nothing compares against a
specific id, key, or label. `moveDealToStage` and `updateDeal` both fetch the deal's *current*
stage's `isWon` flag from the database inside the same transaction (the deal's own `stageId`, not
client input, so no tenant check needed there) before calling this. Verified against real Neon
data on both paths that used to diverge: dragging a card to a renamed Won-equivalent stage in the
Pipeline kanban, and picking that same stage from the deal card's "Move to stage" menu — both
correctly stamp `closeDate` to today.

### "Customize stages" UI

`StageManager` (new component): rename (click the label, edit inline), reorder (up/down arrows —
closed stages don't get arrows and stay pinned after every open stage), add (always inserted as
open, right before the first closed stage), and delete. Rendered both inside a modal from
Pipeline's "Customize stages" button and inline in Settings → Pipeline, replacing what used to be
a static, non-interactive list there.

Safe-delete (`deleteStage` in `lib/data/stages.ts`) blocks outright — chosen over the "confirm and
reassign deals" alternative, to avoid quietly moving someone's deals as a side effect of a stage
edit — in three cases: the stage is closed (Won/Lost are structural, not deletable), it's the last
remaining open stage (there must always be somewhere for an open deal to sit), or any deal still
occupies it. The blocking message names how many deals are in the way. Never silently orphans a
deal onto a deleted stage.

### Tenant-ownership check on every new stage operation

Treated as exactly the surface area the earlier tenant-isolation audit exists to protect against
future additions to:
- `lib/data/stages.ts`: `getStageById`/`renameStage`/`deleteStage` all `findFirst({id, orgId})`
  (or, for `reorderStage`, look the id up only within that org's own stage list — the same
  org-scoping, shaped differently because reordering needs the whole list anyway).
- `lib/actions/crm.ts`: every action that accepts a client-supplied `stageId` — `moveDealAction`,
  `createDealAction`, `updateDealAction`, `convertLeadAction`'s deal-creation branch — resolves it
  through `getStageById(orgId, stageId)` before ever using it, exactly the same shape as the
  existing `ownerId`/`contactId` checks. `renameStageAction`/`reorderStageAction`/
  `deleteStageAction` inherit their tenant check from the data-layer functions they call.

### Cross-tenant regression suite: extended, not just re-run

`tests/integration/cross-tenant.test.ts` — the permanent suite from the earlier audit — **passes
in full, 46/46**, after being updated for the new schema (deal fixtures now sit in a real
`PipelineStage` row instead of a literal enum string). Added 12 new tests specifically for this
surface: `getStageById` returns null cross-org; `listStages` never leaks another org's stages;
`renameStage`/`reorderStage`/`deleteStage` all throw for another org's stage id; and every action
that accepts a `stageId` — `moveDealAction` (including on the caller's *own* deal, to prove it's
the stage that's checked, not just the deal), `createDealAction`, `updateDealAction`,
`convertLeadAction`, `renameStageAction`, `reorderStageAction`, `deleteStageAction` — rejects a
`stageId` from another org. **58/58 total, all passing.**

### Verified against real Neon data

Playwright + a minted Clerk sign-in ticket, same method as every prior verification this session.
Confirmed: existing deals kept their correct stage after the migration (checked immediately post-
migration, see above); a new stage can be added, renamed, and reordered (each change landed in
Neon); deleting the occupied "Discovery" stage is blocked with an error naming the deal count,
while deleting the new unoccupied custom stage succeeds; renaming "Won" to "Closed Won" and then
moving a deal into it (via the deal card's "Move to stage" menu) stamps `closeDate` to today.
(Two of my own verification-script attempts hit selector bugs along the way — Playwright's
`hasText` stops matching once a label switches to an `<input>`, and a "Won" badge and a "Won"
button both matching `getByText` — both fixed in the throwaway script itself, not the app; the
underlying data confirmed the app was already behaving correctly by the time each was fixed.) The
verification org's stages were restored to their original labels/order afterward so no permanent
cosmetic residue was left in the shared dev org.

## Wired up dead controls: activity logging, export, reassign, profile save (Sep 30 2026)

Went through every control across the app that was rendered but did nothing on click, and wired
the real ones. Left "Customize stages" alone — see the decision note below.

### 1. Call / Email / Meeting → logs an activity

Reused the existing activity-logging path end to end: the store's `logActivity` (already wrapping
`persist()` + the tenant check in `logActivityAction`/`assertSubjectInOrg`) — nothing new on the
server. Wired:
- **Lead/contact detail** (`RecordDetail.tsx`): the header's Email/Schedule buttons, the profile
  panel's Email/Call buttons, and the note composer's Call/Email/Meeting ghost buttons (the
  composer already existed — these three were the only dead buttons in it; clicking one now logs
  that kind of activity, using the composer's text as the body if any was typed).
- **Deal** (no full detail page exists — deals live only in the Pipeline kanban): the deal card's
  "Log activity" menu item did nothing; replaced with three real items, "Log call" / "Log email" /
  "Log meeting", each calling the same `logActivity`.
- Left untouched (out of scope, still dead): the Leads/Contacts row-menu "Log activity", "Send
  email", "Add to sequence", "View company", and both "Delete lead"/"Delete contact" items — none
  of these were asked for, and delete has no server-side implementation at all yet.
- Verified against real Neon data (headless browser + Clerk sign-in ticket, same method as prior
  audits): all four surfaces (lead composer Call, header Schedule, header Email, deal card Log
  call) produced a real `Activity` row with the correct `kind` and subject.

### 2. Export → CSV, client-side

New `exportCsv(filename, rows)` in `src/lib/utils.ts` (Blob + object URL + a synthetic `<a
download>` click — no library, no server round trip). Wired to the currently filtered/visible rows
on:
- Leads (`Leads.tsx`) — name, title, company, email, phone, status, source, owner, score,
  estValue, lastTouchedAt.
- Contacts (`Contacts.tsx`) — name, title, company, email, phone, tags, lifecycle, owner,
  openDeals, accountValue, lastInteractionAt.
- Pipeline (`Pipeline.tsx`) — there is no separate deals list screen, so this is new UI: an Export
  button was added next to "Customize stages", exporting the currently-filtered deals (name,
  company, value, stage, probability, closeDate, owner, priority). Genuinely new, not just wiring.
- Left untouched: Reports' own Export button — different kind of export (aggregate report, not a
  filtered record list), not what this task asked for.
- Verified: clicking Export on Leads triggers a real browser download; the saved file has a header
  row plus one row per lead.

### 3. Reassign → bulk owner reassignment

Reused `updateLead` (the exact call `EditLeadModal` already makes, which round-trips through
`updateLeadAction` → `getOwnerById(orgId, ownerId)` for the tenant check) — called once per
selected lead with its existing fields and the new `ownerId`. New: a small `ReassignModal` (owner
picker) in `Leads.tsx`, wired to the bulk-select toolbar's Reassign button. Contacts has no
multi-select UI at all (no dead Reassign control to wire there), so it was left alone.
Verified: selecting two leads and reassigning moved both to the new owner in Neon.

### ~~4. Customize stages (Pipeline) — investigated, not built; needs a decision~~ — built Sep 30 2026

See "Per-org PipelineStage system" above — the `DealStage` enum was replaced with a real per-org
table and the UI was built. The investigation below is kept as the record of why it wasn't done
in the same pass as the other four items.

`DealStage` is a plain Prisma enum (`discovery | proposal | negotiation | contract | won | lost`),
not a per-org table — referenced directly across 11 files (`lib/data/deals.ts`,
`lib/actions/crm.ts`, `src/data/types.ts`, `src/store/crm.tsx`, `Pipeline.tsx`, `Settings.tsx`,
`EditDealModal.tsx`, `NewDealModal.tsx`, `Dashboard.tsx`, `Badge.tsx`). Making stages renameable
and reorderable per organization means introducing a real `PipelineStage` model (orgId, key,
label, order, probability, isClosed) and touching every one of those call sites — a schema/
architecture change, not a UI wiring fix. Per the task's own instruction to stop and report back
rather than guess at anything architectural, this was **not built**. Left "Customize stages" as a
dead button; recommended minimal approach (a per-org `PipelineStage` table, `Deal.stage` becoming
a foreign key instead of an enum) reported back for a decision before starting.

### 5. Settings profile Save

Genuinely new, small schema change: added `Owner.timezone` (nullable `String`, additive migration
`20260930120000_add_owner_timezone`, applied to the real Neon database) plus
`updateOwnerProfile(orgId, id, data)` in `lib/data/owners.ts` and `updateProfileAction` in
`lib/actions/crm.ts`. `id` is always `requireAuth()`'s own `ownerId` — never client-supplied — so
this can only ever write the caller's own row; no cross-tenant surface exists here by
construction. Wired the store (`updateProfile`, following the same optimistic-update/rollback/
toast `persist()` pattern as every other mutation) and the Settings screen.

Scoping decision made without stopping to ask (small enough not to warrant it, but flagged here):
Name and Time zone are now genuinely saved. Role and Email were left **read-only** with a caption
("Set in Team, under Settings" / "Managed by your account provider") instead of wired, because
both are Clerk-identity-owned — `Owner.role`/`email`/`name` are written by the Clerk webhook
(`organizationMembership.updated` → `handleMemberUpdated`) whenever an admin changes a member's
role, which would silently overwrite a locally-edited Role or Email on the next such event. Making
those two fields actually editable here would mean writing through to Clerk, which is a separate
piece of work; presenting a free-text Role input that doesn't call Clerk would have been exactly
the kind of placeholder this task was trying to eliminate. The Workspace card on the same page
(name, currency, fiscal year, quota) still has no Save button at all — left alone; it isn't a
control that does nothing on click, it's a control that doesn't exist yet.

Verified: editing Full name and Time zone and clicking Save changed both fields on the correct
signed-in Owner row in Neon.

### Test suite

`npm test` (the permanent cross-tenant suite from the previous audit) still passes, 46/46 — none
of the above touches cross-tenant surfaces except item 5, which is self-only by construction as
noted above.

## Status

> **Stale as of Oct 2 2026** — this section is from Sep 27 2026 and predates field editing, the
> Company entity, and contact-only convert, all of which are now built. See "Full honest
> state-of-the-codebase audit (Oct 2 2026)" at the top of this file for current state.

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

## Multi-tenant data-leak audit (Sep 30 2026)

A full, function-by-function audit of every function in `lib/data/*.ts`
(8 files) and `lib/actions/crm.ts` (the only file in the repo with
`'use server'`) against four criteria: (1) every read scoped by orgId via
`findFirst({id, orgId})`, never `findUnique({id})` alone; (2) every
create/update/delete verifies orgId ownership of the record being written
*and* of any related record it connects (owner/contact/deal/lead) before
writing; (3) no function is reachable without a valid, session-derived
orgId; (4) every server action calls `requireAuth()` and uses *its*
`orgId`, never a client-supplied value, for tenant scoping.

This was prompted by a confirmed pattern earlier in the build: at least
four prior fixes (`convertLeadAction`'s unchecked `ownerId`,
`logActivityAction`/`addTaskAction`'s unchecked subject ids — see
"Added: contact-only lead conversion" and earlier sections) found a
client-supplied related-entity id trusted without an org check. The brief
was to treat that as systemic and re-verify everything, not assume it was
fully fixed.

**Result: no new findings.** Every function below was read in full (not
grepped-and-skimmed) and verdicted clean. The four earlier issues had
already been fixed in prior tasks this session, and this audit's job was
to confirm no further instances existed — none did. Two `findUnique({id})`
calls exist outside `lib/data/leads|contacts|deals|tasks|activities.ts`:
`getOrgByClerkId`/`getOrgById` in `organizations.ts`, which is the org
*identity* lookup itself (different trust model, not tenant-scoped data),
and `getOwnerByEmail`/`getOwnerByClerkUserId` in `owners.ts`, which use
the compound unique key `orgId_email` / `orgId_clerkUserId` — orgId is
part of the key, so these are still org-scoped despite the `findUnique`
call shape.

### Audit table

| File | Function | Reads orgId-scoped? | Writes verify related-id ownership? | Verdict |
|---|---|---|---|---|
| `lib/data/organizations.ts` | `getOrgByClerkId` | N/A (org identity lookup) | — | Clean — different trust model by design |
| | `getOrgById` | N/A (org identity lookup) | — | Clean |
| | `upsertOrg` / `createOrg` / `updateOrg` / `deleteOrg` | N/A | N/A (org-identity writes, not client-invokable) | Clean |
| `lib/data/owners.ts` | `listOwners` | Yes (`where: {orgId}`) | — | Clean |
| | `getOwnerById` | Yes (`findFirst {id, orgId}`) | — | Clean |
| | `getOwnerByEmail` | Yes (compound key incl. orgId) | — | Clean |
| | `getOwnerByClerkUserId` | Yes (compound key incl. orgId) | — | Clean |
| | `createOwner` | — | orgId injected server-side | Clean |
| | `upsertOwnerFromClerk` | Yes (compound key incl. orgId) | orgId injected server-side | Clean |
| `lib/data/leads.ts` | `listLeads` | Yes | — | Clean |
| | `getLeadById` | Yes (`findFirst {id, orgId}`) | — | Clean |
| | `createLead` | — | orgId injected; owner ownership checked by caller (`createLeadAction`) | Clean |
| | `updateLeadStatus` | Yes (`findFirst` check inside tx) | N/A (no related id) | Clean |
| | `updateLead` | Yes (`findFirst` check inside tx) | `ownerId` re-checked by caller (`updateLeadAction`) before this is called | Clean |
| | `convertLeadToDeal` | Yes (`findFirst` on lead inside tx) | `ownerId` re-checked by caller (`convertLeadAction`); `contactId`/`dealId` are client-generated ids for the *new* rows being created, not connections to existing records, so no ownership check applies to them | Clean |
| `lib/data/contacts.ts` | `listContacts` | Yes | — | Clean |
| | `getContactById` | Yes (`findFirst {id, orgId}`) | — | Clean |
| | `getContactByEmail` | Yes | — | Clean |
| | `createContact` | — | orgId injected; owner ownership checked by caller | Clean |
| | `updateContact` | Yes (`findFirst` check inside tx) | `ownerId` re-checked by caller (`updateContactAction`) | Clean |
| | `addContactTag` | Yes (`findFirst` check inside tx) | N/A | Clean |
| `lib/data/deals.ts` | `listDeals` | Yes | — | Clean |
| | `getPipelineTotals` | Yes (`groupBy {where: {orgId}}`) | — | Clean |
| | `getDealById` | Yes (`findFirst {id, orgId}`) | — | Clean |
| | `createDeal` | — | orgId injected; owner/contact ownership checked by caller | Clean |
| | `closeDateOnStageChange` | Pure function, no DB access | N/A | Clean |
| | `moveDealToStage` | Yes (`findFirst` check inside tx) | N/A (no related id) | Clean |
| | `updateDeal` | Yes (`findFirst` check inside tx) | `ownerId`/`contactId` re-checked by caller (`updateDealAction`) | Clean |
| `lib/data/tasks.ts` | `listTasks` | Yes | — | Clean |
| | `getTaskById` | Yes (`findFirst {id, orgId}`) | — | Clean |
| | `createTask` | — | orgId injected; owner/subject ownership checked by caller (`addTaskAction`) | Clean |
| | `toggleTaskDone` | Yes (`findFirst` check inside tx) | N/A | Clean |
| `lib/data/activities.ts` | `listActivities` | Yes | — | Clean |
| | `logActivity` | orgId injected server-side; related updates (`lead.updateMany`/`contact.updateMany`) filtered by `{id, orgId}` | subject (lead/contact/deal) ownership checked by caller (`logActivityAction` via `assertSubjectInOrg`) | Clean |
| `lib/actions/crm.ts` | `assertSubjectInOrg` (helper) | Yes — looks up the subject via the corresponding org-scoped `getXById` | — | Clean |
| | `assertClientId` (helper) | N/A (UUID format validation only) | — | Clean |
| | `moveDealAction` | `requireAuth()` → `orgId` passed through | Deal ownership checked inside `dbMoveDealToStage` | Clean |
| | `createLeadAction` | `requireAuth()` | `ownerId` checked via `getOwnerById(orgId, ...)` before connect | Clean |
| | `createContactAction` | `requireAuth()` | `ownerId` checked via `getOwnerById` before connect | Clean |
| | `updateContactAction` | `requireAuth()` | `ownerId` checked via `getOwnerById`; duplicate-email check also org-scoped | Clean |
| | `createDealAction` | `requireAuth()` | `ownerId` and optional `contactId` both checked via `getOwnerById`/`getContactById` before connect | Clean |
| | `updateDealAction` | `requireAuth()` | `ownerId` and optional `contactId` both checked before use | Clean |
| | `updateLeadAction` | `requireAuth()` | `ownerId` checked via `getOwnerById` before use | Clean |
| | `setLeadStatusAction` | `requireAuth()` | Lead ownership checked inside `dbUpdateLeadStatus` | Clean |
| | `convertLeadAction` | `requireAuth()` | `ownerId` checked via `getOwnerById`; lead ownership checked inside `dbConvertLeadToDeal`; `contactId`/`dealId` are client-generated new-row ids (format-checked via `assertClientId`), not connections to existing records | Clean |
| | `toggleTaskAction` | `requireAuth()` | Task ownership checked inside `dbToggleTaskDone` | Clean |
| | `addTaskAction` | `requireAuth()` | Assignee `ownerId` checked via `getOwnerById` when it differs from the caller; `subject` checked via `assertSubjectInOrg` | Clean |
| | `logActivityAction` | `requireAuth()` | `subject` checked via `assertSubjectInOrg`; actor is always the caller's own `ownerId` from `requireAuth()` | Clean |
| | `addNoteAction` | Delegates to `logActivityAction` | Same as above | Clean |

Also reviewed, outside the named scope but touching tenant data:
`app/api/webhooks/clerk/route.ts` writes `Organization`/`Owner` rows
using a different, correct trust model (Clerk-signed webhook payload,
keyed by `clerkOrgId`, not a client-supplied `orgId`) — already fixed
for unrelated bugs earlier this session (see "Clerk webhook: registered,
fixed and verified end to end"); no data-leak issue found there either.
`lib/data-loader.ts` (`loadCrmData`) and `app/(app)/layout.tsx` were also
checked — `orgId` there comes from `resolveAuth()`, never the client.

### Permanent regression suite added

`tests/integration/cross-tenant.test.ts` (new, Vitest — `npm test`)
creates two real `Organization`s with real `Owner`/`Lead`/`Contact`/
`Deal`/`Task` rows in the real database, then attempts cross-tenant
access through every `lib/data/*.ts` function and every server action in
`lib/actions/crm.ts`: reading (`getXById`/`listX` must never return the
other org's rows), editing (`updateX`/`moveDealToStage`/
`toggleTaskDone`/`addContactTag` must throw), reassigning (creating or
updating a record with an `ownerId`/`contactId` from the other org must
throw with "Owner/Contact not found"), and the session-boundary itself
(no Clerk session, a Clerk org with no matching `Organization` row, a
Clerk user with no matching `Owner` row — all must throw). 46 assertions,
all passing. Clerk's `auth()` is mocked so the suite can run outside an
HTTP request, but `requireAuth()` itself runs unmodified against the real
database — only the Clerk session boundary is stubbed; every tenant
boundary under test is real application code. Fixture orgs are deleted in
`afterAll`; a post-run DB check confirmed zero leftover rows.

**This suite is a permanent part of the repo, not a one-off check** — it
stays as the standing regression guard for this exact vulnerability
class. `server-only` is aliased to a no-op stub for the test environment
only (`tests/stubs/server-only.ts`, wired in `vitest.config.mts`) so the
real `lib/data/*.ts` modules can be imported directly in Node.

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

> **Stale as of Oct 2 2026** — several entries below (the `mock.ts` chart data, "no field editing",
> "pending invitations aren't listed", Settings Save not persisting) were fixed in later tasks and
> never removed from this list. See "Full honest state-of-the-codebase audit (Oct 2 2026)" at the
> top of this file for what's actually still true today.

### Resolved (Oct 23 2026)

Both previously-unconfirmed items from the Oct 23 2026 UI-honesty task are now resolved — see
"Feature audit (8 named features) + test-count reconciliation, resolved" above for the full
detail. Summary: all four named `GET /api/crm-refetch` cases are covered by name (one test, for a
demoted admin, had to be added — it didn't exist before); the previously-reported totals of 164,
153, and 159 were never reconciled because they don't match the actual codebase at any point
checked — the real, reproducible total is **157** (156 pre-existing + 1 added), confirmed by
running the suite at two separate commits in an isolated worktree and diffing test names, not by
re-reading a past report.

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

### ~~No tests~~ — permanent cross-tenant regression suite added Sep 30 2026

No unit/component test framework is configured yet (still true for UI
code). But `tests/integration/cross-tenant.test.ts` (Vitest) is now a
**permanent** part of the repo — see "Multi-tenant data-leak audit" below.
It exercises real Postgres data across two real Organizations and asserts
every `lib/data/*.ts` function and every `lib/actions/crm.ts` server
action rejects cross-tenant access. Run with `npm test`.

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
