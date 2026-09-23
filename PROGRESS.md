# NexoCRM — Progress tracker

> Living context file. Updated at the end of every task.

## Status

**Phase: Auth + real data.** Clerk authentication and multi-tenancy are
integrated. The UI reads from the database via `lib/data/*` (through the
CrmProvider's server-loaded initial data). Mutations call server actions
that persist to PostgreSQL. Mock data is no longer the primary data source
(though the mock dataset files still exist for reference).

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
- `middleware.ts` — protects all routes except `/sign-in`, `/sign-up`, and
  `/api/webhooks`. Unauthenticated users redirect to sign-in.
- Sign-in at `/sign-in`, sign-up at `/sign-up` using Clerk's prebuilt
  components.
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
| `src/screens/RecordDetail.tsx` | `useCrm()` for activities, tasks, deals, contacts, leads, owners **+** `generatedTimeline` imported from `src/data/timeline.ts` | ⚠️ Partially mock — the activity timeline shown in the detail view blends real activities from the DB with deterministically seeded fake events from `generatedTimeline()`. A new database tenant will see fake history for every record. |

**Summary:** 13 of 16 data-consuming files are fully wired to real Prisma
data. 3 files still pull from hardcoded mock arrays for specific sub-features:
- `monthlyPerformance` (2 screens) — historical chart data, no DB equivalent yet
- `generatedTimeline` (1 screen) — fake per-record activity history

These were not in scope for the Clerk integration task and are documented
here for the next pass. No other files import from `src/data/mock.ts` or
`src/data/timeline.ts`.

## Known gaps / explicitly deferred

### No database running / no migrations applied

`prisma/schema.prisma` is validated and the client is generated, but
`prisma migrate dev` has never been run — there is no actual PostgreSQL
database. The schema exists only as a design artifact right now. To test
end-to-end, you need to spin up a Postgres instance, set DATABASE_URL,
and run `prisma migrate dev`.

### Clerk keys not configured

`@clerk/nextjs` is installed and all code is wired, but no real Clerk
keys are in `.env`. The app will redirect to sign-in but Clerk won't
render without valid keys. You need to create a Clerk application at
dashboard.clerk.com and configure the keys.

### Webhook endpoint not registered

The webhook handler exists at `/api/webhooks/clerk` but it's not registered
in Clerk's dashboard yet. Until it is, organization and member sync relies
entirely on the on-demand fallback in `resolveAuth()`.

### Frontend types diverge from Prisma types

`src/data/types.ts` (used by the UI) was written before Prisma was added.
It's close to the schema but not identical. `lib/mappers.ts` bridges the
gap for now. The mock data files (`src/data/mock.ts`, `src/data/timeline.ts`)
still exist and are still imported by some screens (Dashboard uses
`monthlyPerformance`, RecordDetail uses `generatedTimeline`). These should
eventually be replaced with real data from the database.

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

### Mock data still referenced by three screens

See the verified mock data audit table above for the full file-by-file
breakdown. Summary: `Dashboard` and `Reports` import `monthlyPerformance`
from `src/data/mock.ts` for bar charts; `RecordDetail` imports
`generatedTimeline` from `src/data/timeline.ts` for seeded fake history.
All other files are fully wired to real Prisma data.

### Settings profile/workspace forms don't persist

The Profile and Workspace sections in Settings render with default values
but Save doesn't do anything yet.

### Saved views in sidebar are hardcoded

The sidebar's "Saved views" (Untouched leads, Closing in 30 days,
Champions) have hardcoded counts and are not real saved queries.

## Next up

No specific task queued — waiting for direction. Likely candidates:

- Spin up a Postgres instance, run `prisma migrate dev`, seed initial data.
- Configure real Clerk keys and test end-to-end auth flow.
- Register the Clerk webhook endpoint and test org/member sync.
- Wire Stripe billing (install SDK, create checkout flow, webhook handler).
- Replace remaining mock data references (`monthlyPerformance`,
  `generatedTimeline`) with real DB queries.
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
| Data layer | `convertLeadToDeal` input uses `{ ownerId, deal?: {...} }` | Contact always created; Deal only when `input.deal` is provided. |
| Data layer | Write helpers use find-then-update in a transaction | Ensures the tenant match is checked atomically before the mutation runs. |
