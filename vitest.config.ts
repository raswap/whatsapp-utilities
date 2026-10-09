import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Resolve workspace packages to their sources so cross-package tests count toward coverage of
// src (the package exports point at dist). Most specific entry first: aliases match in order.
const src = (pkg: string, file = 'index.ts') =>
  fileURLToPath(new URL(`./packages/${pkg}/src/${file}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@wamcp/core/testing': src('core', 'testing/index.ts'),
      '@wamcp/core': src('core'),
      '@wamcp/connector-web': src('connector-web'),
      '@wamcp/mcp': src('mcp'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    fileParallelism: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/testing/**', '**/index.ts'],
      reporter: ['text', 'json-summary', 'json'],
      reportsDirectory: './coverage',
      thresholds: { branches: 80, lines: 90 },
    },
  },
})
