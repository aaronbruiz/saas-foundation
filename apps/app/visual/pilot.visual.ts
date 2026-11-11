import { expect, test } from '../e2e/fixtures'
import { sessionFile } from '../e2e/session'
import { setTheme, team, themes, views } from './pages'

// The pilot pages on the UI foundation (ADR-0046) at both widths and in both themes (the system
// theme, emulated before the page loads). Names that change every run (the organization) are
// masked.

for (const view of views)
  for (const theme of themes) {
    test.describe(`${view.name} ${theme}`, () => {
      test.use({ viewport: { width: view.width, height: view.height } })

      test('sign-in page', async ({ page, snap }) => {
        await setTheme(page, theme)
        await page.goto('/login')
        // Enabled once hydrated and Turnstile's test key has answered (slower from the image).
        await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled({ timeout: 30_000 })
        await snap(`login-${view.name}-${theme}.png`, {
          fullPage: true,
          // Turnstile's widget renders in a closed shadow root: mask its host, which holds the
          // widget's hidden response input (an iframe selector matches nothing).
          mask: [page.locator('div:has(> input[name="cf-turnstile-response"])')],
        })
      })

      test.describe('signed in', () => {
        test.use({ storageState: sessionFile })

        test('organization settings', async ({ page, snap, browserName }) => {
          await setTheme(page, theme)
          await page.goto(`/t/${team().slug}/settings`)
          await expect(page.getByRole('button', { name: 'Save name' })).toBeEnabled()
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
