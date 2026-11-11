import type { Page } from '@playwright/test'
import { expect, test } from '../e2e/fixtures'
import { readFileSync } from 'node:fs'
import { sessionFile } from '../e2e/session'
import { teamFile } from './team'

// The pilot pages on the UI foundation (ADR-0046) at both widths and in both themes. Dark is the
// `.dark` class, which nothing in the app sets yet; the tests set it once the page has hydrated.
// Names that change every run (the organization) are masked.
const views = [
  { name: 'narrow', width: 320, height: 800 },
  { name: 'wide', width: 1280, height: 900 },
] as const
const themes = ['light', 'dark'] as const

// After the page has hydrated: a class set before load doesn't survive React's hydration of <html>.
async function setTheme(page: Page, theme: (typeof themes)[number]) {
  if (theme === 'dark') await page.evaluate(() => document.documentElement.classList.add('dark'))
}

for (const view of views)
  for (const theme of themes) {
    test.describe(`${view.name} ${theme}`, () => {
      test.use({ viewport: { width: view.width, height: view.height } })

      test('sign-in page', async ({ page, snap }) => {
        await page.goto('/login')
        // Enabled once hydrated and Turnstile's test key has answered (slower from the image).
        await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled({ timeout: 30_000 })
        await setTheme(page, theme)
        await snap(`login-${view.name}-${theme}.png`, {
          fullPage: true,
          mask: [page.locator('iframe[src*="challenges.cloudflare.com"]')],
        })
      })

      test.describe('signed in', () => {
        test.use({ storageState: sessionFile })

        test('organization settings', async ({ page, snap, browserName }) => {
          const { slug } = JSON.parse(readFileSync(teamFile, 'utf8')) as { slug: string }
          await page.goto(`/t/${slug}/settings`)
          await expect(page.getByRole('button', { name: 'Save name' })).toBeEnabled()
          await setTheme(page, theme)
          const mask = [
            page.getByRole('banner').getByRole('heading', { level: 1 }),
            page.getByLabel('Organization name', { exact: true }),
            page.locator('strong'),
          ]
          await snap(`settings-${view.name}-${theme}.png`, { fullPage: true, mask })
          // The transfer picker open: a customizable select (base-select) renders in the page in
          // Chromium and WebKit; Firefox opens the OS list, outside any screenshot.
          if (browserName !== 'firefox') {
            await page.getByLabel('New owner').click()
            await snap(`settings-picker-${view.name}-${theme}.png`, { fullPage: true, mask })
            await page.keyboard.press('Escape')
          }
        })
      })
    })
  }
