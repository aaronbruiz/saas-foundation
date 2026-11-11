import { defineConfig, devices } from '@playwright/test'

// Visual tests (ADR-0046): the pilot pages at 320 and 1280 px, light and dark, in Chromium, Firefox
// and WebKit, against committed baselines. Run with `pnpm test:visual` (through
// scripts/test-lock.sh visual): it starts the pinned Playwright Docker image as a browser server,
// so fonts and rendering match the baselines on any machine. Not run in CI (Actions minutes).
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
  reporter: 'list',
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' } },
  use: { baseURL, trace: 'retain-on-failure', connectOptions, visual: true },
  projects: [
    // The shared signed-in user (e2e/session.ts), as in the e2e suite.
    { name: 'setup', testDir: './e2e', testMatch: /auth\.setup\.ts$/ },
    // An organization with a second member, for the transfer picker (visual/team.setup.ts).
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
