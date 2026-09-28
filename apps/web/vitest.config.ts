import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { defineConfig } from 'vitest/config'

// Resolve pg-cloudflare the way pg does (pg → pg-cloudflare), without hardcoding pnpm's layout.
const fromDb = createRequire(createRequire(import.meta.url).resolve('@saas-foundation/db'))
const fromPg = createRequire(fromDb.resolve('pg'))
const pgCloudflareWorkerdBuild = join(
  dirname(fromPg.resolve('pg-cloudflare/package.json')),
  'dist/index.js',
)

// Expected warning on every run: "[vpw:warn] Failed to statically analyze the exports of the main
// Worker entry-point @tanstack/react-start/server-entry". That module only exists inside TanStack's
// Vite plugin; our tests import modules directly and don't call the Worker entry.
// Tests run inside workerd with the Worker's real bindings (ADR-0006).
// The DB binding is pointed at the separate `app_test` database so tests never touch dev data.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        hyperdrives: { DB: 'postgres://app:app@localhost:5432/app_test' },
        bindings: {
          // Test-only values; real secrets come from Cloudflare (prod) or .dev.vars (local dev).
          BETTER_AUTH_SECRET: 'test-only-secret-not-used-anywhere-else-0123456789',
          BETTER_AUTH_URL: 'http://localhost:5173',
        },
      },
    }),
  ],
  test: {
    // Workers tests only; e2e/ is Playwright's.
    include: ['test/**/*.test.ts'],
    // Node-side: apply migrations to app_test before any workerd test runs.
    globalSetup: ['./test/global-setup.ts'],
  },
  resolve: {
    // Test runner only: pg's CommonJS `require()` of pg-protocol resolves to its ESM build under the
    // runner's conditions, which CJS can't load. Point it at the package's own CJS build.
    // Not needed for `pnpm dev`/build (verified: /api/health works in the workerd dev server).
    alias: [
      { find: /^pg-protocol$/, replacement: 'pg-protocol/dist/index.js' },
      // Same for pg-cloudflare: `require` resolves to its empty non-workerd stub; use the workerd build.
      {
        find: /^pg-cloudflare$/,
        replacement: pgCloudflareWorkerdBuild,
      },
    ],
  },
})
