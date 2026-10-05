import { defineConfig, devices } from '@playwright/test'

// BASE_URL set (preview.yml) → test the deployed preview. Unset → start the dev server locally
// (needs `pnpm db:up`, migrations and apps/web/.dev.vars).
const baseURL = process.env.BASE_URL ?? 'http://localhost:3000'

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.BASE_URL
    ? undefined
    : {
        // Invoke Vite directly so Playwright owns the dev-server process group.
        // Keep flags aligned with package.json#scripts.dev.
        command: 'vite dev --port 3000 --strictPort',
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120_000,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      },
})
