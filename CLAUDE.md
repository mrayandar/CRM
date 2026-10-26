# NexoCRM — working notes for Claude

See `PROGRESS.md` for the full project history and decisions log.

## Testing policy

The integration suite runs against a real Neon Postgres database (no local/mocked DB), and the
latency to it (~250ms per query round trip from this machine, confirmed by direct measurement) is
the dominant cost — not Postgres query time itself. That makes the full suite too slow to run after
every small change (~800s / 445 tests as of this policy's writing), so:

- **`vitest related` hangs in this repo** (confirmed: even a single-file `vitest related --run
  <one file>` hangs, while a plain `vitest run <explicit test files>` with the same effective
  scope completes normally) — never invoke it, including via `npm run test:related -- <source
  files>` the old way. `test:related` is now a plain alias for `vitest run`: pass it actual test
  file paths, not source files.

- **At the end of a task**: run `npm run typecheck`, then run the specific test files that cover
  the files you actually changed:
  ```
  npm run test:related -- <test file paths>
  ```
  e.g. `npm run test:related -- tests/integration/leads.test.ts tests/integration/own-mode.test.ts`.
  Since there's no automated dependency-graph discovery anymore, figure out which test files are
  relevant yourself (grep the test directory for the changed module's import path, or reason from
  what the change touches) — get the changed-*source*-files list from `git diff --name-only` /
  `git status --porcelain` first, then map that to test files by hand.

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
