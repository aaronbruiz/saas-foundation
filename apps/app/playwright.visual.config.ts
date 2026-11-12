import { defineConfig, devices } from '@playwright/test'

// Visual tests (ADR-0046, docs/testing.md): the pilot pages at 320 and 1280 px, light and dark, in
// Chromium, Firefox and WebKit, with the strict CSP check, the WebKit <select> canary and the
// keyboard pass. Run with `pnpm test:visual [--baseline | --compare]` (through
// scripts/test-lock.sh visual): it starts the pinned Playwright Docker image as a browser server,
// so fonts and rendering match on any machine. Screenshots live in the git-ignored
// `visual/.baseline/` (written by --baseline, compared by --compare). Not run in CI.
const wsEndpoint = process.env.PW_WS
if (!wsEndpoint)
  throw new Error('Run visual tests with `pnpm test:visual`: browsers come from the pinned image.')

const baseURL = 'http://localhost:3000'
const connectOptions = { wsEndpoint }

export default defineConfig<{ visual: boolean }>({
  testDir: './visual',
  testMatch: /\.visual\.ts$/,
  globalSetup: './e2e/global-setup.ts',
  timeout: 120_000,
  // Two workers, not Playwright's default (half the CPUs): on 8 CPUs, 2 workers took 12.5 min at a
  // mean 1-minute load of 7.3 (peak 10.3), the default 9.8 min at 11.9 (peak 16.9), and that load
  // made other test runs on the machine time out (UI polish A3, 2026-11-11). `--workers=N` overrides.
  workers: 2,
  reporter: 'list',
  snapshotPathTemplate: '{testDir}/.baseline/{projectName}/{arg}{ext}',
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' } },
  use: { baseURL, trace: 'retain-on-failure', connectOptions, visual: true },
  projects: [
    // The shared signed-in user (e2e/session.ts), as in the e2e suite.
    { name: 'setup', testDir: './e2e', testMatch: /auth\.setup\.ts$/ },
    // An organization with two more members (the transfer picker) and a project (visual/team.setup.ts).
    { name: 'team', testMatch: /team\.setup\.ts$/, dependencies: ['setup'] },
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, dependencies: ['team'] },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, dependencies: ['team'] },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, dependencies: ['team'] },
  ],
  webServer: {
    command: 'vite dev --port 3000 --strictPort',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
})
