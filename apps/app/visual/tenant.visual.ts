import type { Page } from '@playwright/test'
import { expect, test } from '../e2e/fixtures'
import { sessionFile } from '../e2e/session'
import { setTheme, tabWalk, team, themes, views, type Theme } from './pages'

// The tenant pages: projects list and detail, members, invite, billing, and the shell's
// organization switcher (UI migration PR 2, ADR-0046) at both widths and in both themes, as the
// owner of visual/team.setup.ts's organization; and a keyboard pass on each page: every stop shows
// a visible focus indicator, and a form's tab order reaches its controls in reading order. Text that
// changes every run (the organization's name, the owner's email) is masked.

type TenantPage = {
  name: string
  path: (t: { slug: string; projectId: string }) => string
  /** Enabled once the page has hydrated. */
  ready: (page: Page) => ReturnType<Page['locator']>
  /** A form's own controls, in reading order (the nav and links around them vary by browser:
   * WebKit skips links on Tab by default). None: only the focus indicators are checked. */
  controls?: string[]
}

const pages: TenantPage[] = [
  {
    name: 'projects',
    path: (t) => `/t/${t.slug}/projects`,
    ready: (page) => page.getByRole('button', { name: 'Create project' }),
    controls: ['Project name', 'Description', 'Create project'],
  },
  {
    name: 'project',
    path: (t) => `/t/${t.slug}/projects/${t.projectId}`,
    ready: (page) => page.getByRole('button', { name: 'Save' }),
    controls: ['Project name', 'Description', 'Save', 'Delete project'],
  },
  {
    name: 'members',
    path: (t) => `/t/${t.slug}/members`,
    ready: (page) => page.getByRole('button', { name: 'Remove visual-candidate@e2e.test' }),
  },
  {
    name: 'invite',
    path: (t) => `/t/${t.slug}/invite`,
    ready: (page) => page.getByRole('button', { name: 'Create invitation' }),
    controls: ['Invitee email', 'Create invitation'],
  },
  {
    name: 'billing',
    path: (t) => `/t/${t.slug}/billing`,
    ready: (page) => page.getByRole('button', { name: /^Upgrade to / }).first(),
  },
]

const mask = (page: Page) => {
  const banner = page.getByRole('banner')
  return [
    banner.getByRole('heading', { level: 1 }),
    banner.getByRole('link', { name: /^Org vis-/ }),
    page.getByText(/^sam-\w+@e2e\.test$/),
  ]
}

async function open(page: Page, p: TenantPage, theme: Theme) {
  await setTheme(page, theme)
  await page.goto(p.path(team()))
  await expect(p.ready(page)).toBeEnabled()
}

test.use({ storageState: sessionFile })

for (const view of views)
  for (const theme of themes)
    test.describe(`${view.name} ${theme}`, () => {
      test.use({ viewport: { width: view.width, height: view.height } })

      for (const p of pages)
        test(p.name, async ({ page, snap }) => {
          await open(page, p, theme)
          await snap(`${p.name}-${view.name}-${theme}.png`, { fullPage: true, mask: mask(page) })
        })

      test('organization switcher open', async ({ page, snap }) => {
        await open(page, pages[0]!, theme)
        await page.getByRole('banner').locator('summary').click()
        await expect(page.getByRole('link', { name: 'New organization' })).toBeVisible()
        await snap(`org-switcher-${view.name}-${theme}.png`, { fullPage: true, mask: mask(page) })
      })
    })

for (const theme of themes)
  test.describe(`keyboard ${theme}`, () => {
    test.use({ viewport: { width: 1280, height: 900 } })

    for (const p of pages)
      test(`${p.name}: every stop shows focus${p.controls ? ' and the tab order follows the form' : ''}`, async ({
        page,
        allowWebKitSelect,
      }) => {
        await open(page, p, theme)
        await allowWebKitSelect(page)
        const names = await tabWalk(page)
        if (p.controls) expect(names.filter((n) => p.controls!.includes(n))).toEqual(p.controls)
      })
  })
