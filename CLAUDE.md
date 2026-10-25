# NexoCRM — working notes for Claude

See `PROGRESS.md` for the full project history and decisions log.

## Testing policy

The integration suite runs against a real Neon Postgres database (no local/mocked DB), and the
latency to it (~250ms per query round trip from this machine, confirmed by direct measurement) is
the dominant cost — not Postgres query time itself. That makes the full suite too slow to run after
every small change (~800s / 445 tests as of this policy's writing), so:

- **At the end of a task**: run `npm run typecheck`, then run only the tests related to the files
  you actually changed:
  ```
  npm run test:related -- <changed files>
  ```
  e.g. `npm run test:related -- lib/data/leads.ts lib/actions/crm.ts`. This uses Vitest's own
  module-graph analysis (`vitest related`) to find every test file that imports (even
  transitively) the changed files, and runs only those. Get the changed-files list from
  `git diff --name-only` / `git status --porcelain` — don't guess it by hand.

- **Run the full suite** (`npm test`) only when:
  1. the user says **"stage complete"**, or
  2. right before pushing a change that touches `lib/auth`, `lib/scope`, `lib/actions`,
     `lib/data`, `middleware.ts`, or `prisma/schema.prisma` — any of these can affect
     cross-tenant/role/scope enforcement in ways `vitest related`'s import graph won't always
     trace (e.g. a Prisma schema change doesn't get "imported" by the tests that depend on its
     shape the same way a TS import does).

- **Never skip these before a push that touches the areas in (2) above**, even if
  `test:related` didn't surface them — run them explicitly:
  - `tests/integration/cross-tenant.test.ts` (cross-tenant isolation)
  - `tests/integration/own-mode.test.ts` (OWN-mode/scope enforcement)
  - `tests/integration/action-route-matrix.test.ts` (action/route exhaustiveness)
  - `tests/unit/scope.test.ts` and `tests/types/scope-required.test.ts`

  i.e.: `npx vitest run tests/integration/cross-tenant.test.ts tests/integration/own-mode.test.ts tests/integration/action-route-matrix.test.ts tests/unit/scope.test.ts tests/types/scope-required.test.ts`

- Don't change a test's assertions to make it faster. If a test is slow because of what it's
  legitimately verifying (e.g. a real multi-step reassignment flow), that cost is real — the fix is
  running it less often, not weakening it.
