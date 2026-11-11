import type { Page } from '@playwright/test'
import { expect, test } from '../e2e/fixtures'
import { sessionFile } from '../e2e/session'
import { setTheme, tabWalk, themes, views, type Theme } from './pages'

// The account page and the legal pages (UI migration PR 3a, ADR-0046) at both widths and in both
// themes, and a keyboard pass on each: every stop shows a visible focus indicator, and the account
// page's tab order reaches its controls in reading order. Text that changes every run (the
// signed-in email, the organizations' names) is masked.

type AccountPage = {
  name: string
  path: string
  signedIn?: boolean
  /** Shown once the page has hydrated (enabled) or rendered. */
  ready: (page: Page) => ReturnType<Page['locator']>
  /** The page's own controls, in reading order (links around them vary by browser: WebKit skips
   * links on Tab by default). None: only the focus indicators are checked. */
  controls?: string[]
}

const pages: AccountPage[] = [
  {
    name: 'account',
    path: '/account',
    signedIn: true,
    ready: (page) => page.getByRole('button', { name: 'Save name' }),
    controls: [
      'Name',
      'Save name',
      'Current password',
      'New password',
      'Change password',
      'Password to delete your account',
      'Delete account',
    ],
  },
  { name: 'privacy', path: '/privacy', ready: (page) => page.getByRole('heading', { level: 1 }) },
  { name: 'terms', path: '/terms', ready: (page) => page.getByRole('heading', { level: 1 }) },
  {
    name: 'subprocessors',
    path: '/subprocessors',
    ready: (page) => page.getByRole('heading', { level: 1 }),
  },
]

const mask = (page: Page) => [
  page.getByText(/^Signed in as /),
  page.getByRole('link', { name: /^Org vis-/ }),
]

async function open(page: Page, p: AccountPage, theme: Theme) {
  await page.goto(p.path)
  const ready = p.ready(page)
  await expect(ready).toBeVisible()
  if (p.controls) await expect(ready).toBeEnabled()
  await setTheme(page, theme)
}

for (const p of pages)
  test.describe(p.name, () => {
    if (p.signedIn) test.use({ storageState: sessionFile })

    for (const view of views)
      for (const theme of themes)
        test.describe(`${view.name} ${theme}`, () => {
          test.use({ viewport: { width: view.width, height: view.height } })

          test('page', async ({ page, snap }) => {
            await open(page, p, theme)
            await snap(`${p.name}-${view.name}-${theme}.png`, { fullPage: true, mask: mask(page) })
          })
        })

    for (const theme of themes)
      test(`keyboard ${theme}: every stop shows focus${p.controls ? ' and the tab order follows the page' : ''}`, async ({
        page,
        allowWebKitSelect,
      }) => {
        await page.setViewportSize({ width: 1280, height: 900 })
        await open(page, p, theme)
        await allowWebKitSelect(page)
        const names = await tabWalk(page)
        if (p.controls) expect(names.filter((n) => p.controls!.includes(n))).toEqual(p.controls)
      })
  })
