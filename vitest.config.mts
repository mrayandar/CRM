import { defineConfig } from 'vitest/config'
import path from 'node:path'

const root = import.meta.dirname

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Raised from 30s after the CSV-import work exposed a real cost: Lead/Contact's two GIN
    // trigram indexes (name/email search) make every insert measurably slower than a plain
    // btree-indexed table (~2-4s per lead, measured directly against production — see
    // app/api/import/commit/route.ts's doc comment). The write cost itself is a separate, bigger
    // finding this bump doesn't fix or need to.
    testTimeout: 60000,
    hookTimeout: 60000,
    // Vitest's default (one forked worker process per test file, all started at once) opened 20
    // simultaneous connections to the same real Neon database the moment this suite grew past 20
    // files — Neon's pooler couldn't hand that many out at once and several files failed with
    // "Can't reach database server" from their very first query, not a timeout. These integration
    // tests share one real external resource with a real connection limit, so they run one file
    // at a time instead — slower, but the actual constraint this suite runs against, not an
    // assumption that doesn't hold once there are enough test files.
    fileParallelism: false,
    setupFiles: ['./tests/setup.ts'],
  },
  resolve: {
    alias: {
      'server-only': path.resolve(root, 'tests/stubs/server-only.ts'),
      '@lib': path.resolve(root, 'lib'),
      '@': path.resolve(root, 'src'),
    },
  },
})
