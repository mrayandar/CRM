import { defineConfig } from 'vitest/config'
import path from 'node:path'

const root = import.meta.dirname

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
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
