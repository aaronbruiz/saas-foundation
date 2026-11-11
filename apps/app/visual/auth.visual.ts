import type { Page } from '@playwright/test'
import { expect, test } from '../e2e/fixtures'
import { sessionFile } from '../e2e/session'
import { setTheme, tabWalk, themes, views, type Theme } from './pages'

// The sign-in, sign-up, password reset, invitation and new-organization pages (UI migration PR 1,
// ADR-0046) at both widths and in both themes, and a keyboard pass on each form: the tab order
// reaches its controls in reading order and every stop shows a visible focus indicator. The sign-in
// page's screenshots are in pilot.visual.ts. Text that changes every run (the signed-in email) and
// the Turnstile widget are masked.

// Turnstile's widget renders in a closed shadow root (its iframe can't be selected); its host is the
// element holding the widget's hidden response input.
const turnstile = (page: Page) => [page.locator('div:has(> input[name="cf-turnstile-response"])')]

type AuthPage = {
  name: string
  path: string
  /** Enabled once the page has hydrated (and Turnstile's test key has answered, where it runs). */
  ready: string
  signedIn?: boolean
  /** The form's own controls, in reading order (links around them vary by browser: WebKit skips
   * links on Tab by default). */
  controls: string[]
  mask?: (page: Page) => ReturnType<Page['locator']>[]
}

const pages: AuthPage[] = [
  {
    name: 'login',
    path: '/login',
    ready: 'Sign in',
    controls: ['Email', 'Password', 'Sign in'],
    mask: turnstile,
  },
  {
    name: 'signup',
    path: '/signup',
    ready: 'Create account',
    controls: ['Name', 'Email', 'Password', 'Create account'],
    mask: turnstile,
  },
  {
    name: 'forgot-password',
    path: '/forgot-password',
    ready: 'Send reset link',
    controls: ['Email', 'Send reset link'],
    mask: turnstile,
  },
  {
    name: 'reset-password',
    path: '/reset-password?token=visual',
    ready: 'Change password',
    controls: ['New password', 'Change password'],
  },
  {
    name: 'invitation',
    path: '/invite/visual',
    ready: 'Accept invitation',
    signedIn: true,
    controls: ['Accept invitation'],
    mask: (page) => [page.getByText(/^Signed in as /)],
  },
  {
    name: 'new-organization',
    path: '/orgs/new',
    ready: 'Create organization',
    signedIn: true,
    controls: ['Organization name', 'URL slug', 'Create organization'],
  },
]

async function open(page: Page, p: AuthPage, theme: Theme) {
  await setTheme(page, theme)
  await page.goto(p.path)
  await expect(page.getByRole('button', { name: p.ready })).toBeEnabled({ timeout: 30_000 })
}

for (const p of pages) {
  test.describe(p.name, () => {
    if (p.signedIn) test.use({ storageState: sessionFile })

    // The sign-in page's screenshots are pilot.visual.ts's.
    if (p.name !== 'login')
      for (const view of views)
        for (const theme of themes)
          test.describe(`${view.name} ${theme}`, () => {
            test.use({ viewport: { width: view.width, height: view.height } })

            test('page', async ({ page, snap }) => {
              await open(page, p, theme)
              await snap(`${p.name}-${view.name}-${theme}.png`, {
                fullPage: true,
                mask: p.mask?.(page),
              })
            })
          })

    for (const theme of themes)
      test(`keyboard ${theme}: tab order follows the form and every stop shows focus`, async ({
        page,
        allowWebKitSelect,
      }) => {
        await page.setViewportSize({ width: 1280, height: 900 })
        await open(page, p, theme)
        await allowWebKitSelect(page)
        const names = await tabWalk(page)
        expect(names.filter((n) => p.controls.includes(n))).toEqual(p.controls)
      })
  })
}

// An error message (role="alert") on a page: submitting the reset form after its token has been
// dropped. The page keeps the token in state, so a fresh visit without one is the expired case.
for (const view of views)
  for (const theme of themes)
    test.describe(`reset-password error ${view.name} ${theme}`, () => {
      test.use({ viewport: { width: view.width, height: view.height } })

      test('page', async ({ page, snap }) => {
        await setTheme(page, theme)
        await page.goto('/reset-password')
        const submit = page.getByRole('button', { name: 'Change password' })
        await expect(submit).toBeEnabled()
        await page.getByLabel('New password').fill('correct-horse-battery-staple')
        await submit.click()
        await expect(page.getByRole('alert')).toHaveText(
          'This reset link is invalid or has expired.',
        )
        await snap(`reset-password-error-${view.name}-${theme}.png`, { fullPage: true })
      })
    })
