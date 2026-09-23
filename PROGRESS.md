# NexoCRM — Progress tracker

> Living context file. Updated at the end of every task.

## Status

**Phase: Backend scaffolding.** The full UI runs on a client-side mock store.
The Prisma schema and server-side data-access layer exist but are not yet
consumed by any page — nothing calls `lib/data/*` yet.

## Done

### UI (complete, not to be modified without explicit request)

- **8 screens** in `src/screens/`: Dashboard, Leads, Contacts, Pipeline,
  RecordDetail (lead + contact detail with tabs), Tasks, Reports, Settings.
- **Shared component library** in `src/components/`: `ui/` (Button, Badge,
  Card, Avatar, Table, Field, Menu, Modal, Display), `layout/` (Sidebar,
  PageShell, CommandPalette, AppLayout), `common/` (ActivityStream,
  MetricTile, TaskRow, LeadFunnel).
- **Mock data store** in `src/store/crm.tsx` — `CrmProvider` + `useCrm()`
  hook providing leads, contacts, deals, tasks, activities, owners, plus
  mutation functions (`moveDeal`, `setLeadStatus`, `convertLead`,
  `toggleTask`, `addTask`, `addNote`, `logActivity`). The entire UI renders
  from this store.
- **Mock dataset** in `src/data/mock.ts` + `src/data/timeline.ts` — 22
  leads, 24 contacts, 18 deals, tasks, activities, 6 owners with
  deterministic seeded timeline generation.
- **Command palette** (Ctrl+K) searching across nav, leads, contacts, deals.
- **Drag-and-drop** kanban on the Pipeline board (native HTML5 drag events).

### Next.js migration (complete)

- Migrated from Vite + react-router-dom SPA to **Next.js 15 App Router**.
- `app/` directory contains thin route wrappers only — each `page.tsx`
  imports and renders a screen from `src/screens/`.
- `src/lib/router-compat.tsx` bridges react-router-dom's API (`Link` with
  `to` prop, `NavLink` with `isActive` render props, `useNavigate`,
  `useSearchParams` with setter, `useParams`) on top of `next/link` and
  `next/navigation`. All 11 files that used `react-router-dom` now import
  from this shim — zero remaining `react-router-dom` imports.
- All 27 `.tsx` files under `src/` carry `'use client'` (the app is 100%
  client-rendered while it runs on the mock store).
- Tailwind v4 via `@tailwindcss/postcss` (was `@tailwindcss/vite`).
- CSS entry at `app/globals.css` (was `src/index.css`).
- Production build passes, all 10 routes prerender/render successfully.

### Prisma + PostgreSQL schema (complete, not yet consumed)

- `prisma/schema.prisma` models 6 entities: Owner, Lead, Contact, Deal,
  Task, Activity — mirroring `src/data/types.ts` field-for-field.
- Enums match the exact string unions used on the frontend (e.g.
  `LeadStatus.new` = `'new'`).
- **Multi-tenancy:** every model has `orgId String` with `@@index([orgId])`
  plus composite indexes on hot query paths (e.g. `@@index([orgId, status])`
  on Lead, `@@index([orgId, done, dueDate])` on Task).
- `Owner.email` uniqueness is per-org: `@@unique([orgId, email])`.
- Lead-to-Contact is one-to-one via `Contact.originLeadId` (unique FK).
  Lead-to-Deal is one-to-one via `Deal.leadId` (unique FK). Contact-to-Deal
  is one-to-many.

### Server-side data-access layer (complete, not yet consumed)

- `lib/prisma.ts` — HMR-safe PrismaClient singleton.
- `lib/data/{owners,leads,contacts,deals,tasks,activities}.ts` — 22
  exported functions covering list, getById, create, and
  domain-specific writes (updateLeadStatus, convertLeadToDeal,
  addContactTag, moveDealToStage, toggleTaskDone, logActivity, etc.).
- **Every function** takes `orgId: string` as its first required parameter.
  All by-id reads use `findFirst({ where: { id, orgId } })`, never
  `findUnique({ where: { id } })`. Writes verify tenant match inside a
  Prisma transaction before mutating. TypeScript enforces that no call site
  can omit `orgId`.
- `convertLeadToDeal` accepts `{ ownerId, deal?: {...} }` — Contact is
  always created; Deal only when `input.deal` is provided. The mock-store
  `convertLead` mirrors this signature and behavior.

### Config / env

- `.env.example` with placeholders for DATABASE_URL, Clerk keys, Stripe
  keys, app URL.
- `.gitignore` covering `node_modules`, `.next`, `.env*`, `*.tsbuildinfo`.
- `.cursor/rules/nexocrm.mdc` (alwaysApply) documenting multi-tenancy
  invariant, project structure, domain model, and UI-hands-off policy.
  **Not yet committed** — still untracked.

## Known gaps / explicitly deferred

### UI ↔ database not wired

Nothing in `app/` or `src/` imports from `lib/data/*`. The entire UI still
reads from `src/store/crm.tsx` (in-memory mock data). Wiring screens to
real Postgres data requires:

1. Server Components or Server Actions in `app/` route files that call
   `lib/data/*` and pass results as props to the client screens, OR
2. A fetch-based API layer (`app/api/`) that the client screens call.

Neither exists yet.

### No database running / no migrations applied

`prisma/schema.prisma` is validated and the client is generated, but
`prisma migrate dev` has never been run — there is no actual PostgreSQL
database. The schema exists only as a design artifact right now.

### Frontend types diverge from Prisma types

`src/data/types.ts` (used by the UI) was written before Prisma was added.
It's close to the schema but not identical:

- Frontend `Owner` has `initials: string`; the Prisma model does not.
- Frontend types use `string` for dates; Prisma uses `DateTime`.
- Frontend types don't include `orgId`.
- Frontend `Contact.openDeals` is a denormalized `number`; the Prisma model
  uses `_count: { deals }` at query time instead.
- Frontend `Task.relatedTo` is `{ type, id, label }`; the Prisma model
  splits this into `relatedToType`, `relatedToLabel`, plus nullable FK
  fields (`leadId`, `contactId`, `dealId`).

These will need a mapping/adapter layer when the UI is wired to the
database, or the frontend types will need to be replaced with Prisma's
generated types.

### Auth not wired (Clerk)

`@clerk/nextjs` is **not installed**. `.env.example` has placeholder keys
but no middleware, no `<ClerkProvider>`, no `auth()` calls. `orgId` in
`lib/data/*` is a plain string parameter — nothing enforces it comes from
a Clerk session yet.

### Billing not wired (Stripe)

`stripe` SDK is **not installed**. `.env.example` has placeholder keys but
no webhook handler, no checkout flow, no subscription model in the schema.

### No API routes

`app/api/` does not exist. There are no REST or tRPC endpoints.

### No tests

No test framework configured. No unit, integration, or E2E tests.

### `convertLead` UI only creates a deal

The API and mock store now support contact-only conversion (omit
`input.deal`), but the UI's "Convert to deal" modal in `RecordDetail.tsx`
always passes a `deal` block. There is no "Convert to contact only" UI path
yet — the optional-deal capability exists only at the function level.

### `.cursor/rules/nexocrm.mdc` not committed

The Cursor project rule file exists locally but was excluded from the last
commit (it was created in a separate task). Needs to be committed.

### `src/pages/` rename to `src/screens/`

The rename happened because Next.js treats `src/pages/` as its legacy Pages
Router directory. The `.cursor/rules/nexocrm.mdc` file documents the
current name (`src/screens/`), but the file's own heading still says
`Project structure` without calling out the rename history — fine for now,
but something to be aware of if anyone goes looking for "pages."

## Next up

No specific task queued — waiting for direction on what to build next.
Likely candidates:

- Wire Clerk auth (`@clerk/nextjs` middleware, `<ClerkProvider>`, derive
  `orgId` from session, protect routes).
- Create an API or Server Action layer connecting `app/` routes to
  `lib/data/*`.
- Run `prisma migrate dev` against a real Postgres instance and seed it.
- Add a "Convert to contact only" UI path in RecordDetail.

## Decisions log

| When | Decision | Why |
|------|----------|-----|
| Migration | Renamed `src/pages/` → `src/screens/` | Next.js auto-detects `src/pages/` as the legacy Pages Router, causing it to look for `app/` under `src/app/` instead of the project root. Renaming was the only way to unblock the build without restructuring the route files. |
| Migration | Created `src/lib/router-compat.tsx` shim | All existing screens used react-router-dom's `Link` (with `to` prop), `NavLink` (with `isActive` render prop), `useNavigate`, `useSearchParams` (with setter), and `useParams`. Building a compatibility layer let us change one import line per file instead of rewriting every `<Link to=...>` and every `setSearchParams(...)` call across 11 files. |
| Migration | `app/` pages are thin wrappers, not the actual screens | The "don't touch the UI" constraint means screen logic stays in `src/screens/`. Each `app/*/page.tsx` just imports and renders the corresponding screen component, sometimes wrapped in `<Suspense>` for Next's static-prerender requirements on `useSearchParams`. |
| Schema | `orgId` is a bare `String`, not a FK to an `Organization` model | Clerk will own the organization concept. Adding a local `Organization` table would duplicate what Clerk manages and create sync headaches. `orgId` is just the Clerk org id stored as a string. |
| Schema | `Owner.email` uses `@@unique([orgId, email])` not `@unique` | Global email uniqueness would prevent two tenants from independently having users with the same email address — a real scenario in B2B SaaS. |
| Schema | By-id lookups use `findFirst({ where: { id, orgId } })` not `findUnique({ where: { id } })` | Prisma's `findUnique` requires the `where` to match a declared unique key. Since `id` is the PK and adding a compound `@@unique([orgId, id])` is redundant, `findFirst` with both fields is the idiomatic Prisma pattern for tenant-scoped lookups. It pushes the filter into the query (vs. a post-fetch check) so there's no window where a guessed id returns another tenant's row. |
| Data layer | `convertLeadToDeal` input uses `{ ownerId, deal?: {...} }` not flat top-level fields | The original implementation always created both a Contact and a Deal together. The intended domain model says a Deal is optional — converting a lead should always produce a Contact, but a Deal only when there's a real opportunity. Wrapping deal fields in an optional sub-object makes the intent explicit in the type system: callers must consciously decide whether to open a deal. |
| Data layer | Write helpers (update, toggle, move) use find-then-update in a transaction | A raw `update({ where: { id } })` would succeed even if the record belongs to a different tenant — Prisma doesn't let us add `orgId` to an `update`'s unique-key `where`. Wrapping in a transaction with a `findFirst({ where: { id, orgId } })` guard ensures the tenant match is checked atomically before the mutation runs. |
