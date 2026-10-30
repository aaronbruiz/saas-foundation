import { expect, test } from '@playwright/test'
import { createOrg, PASSWORD, rand } from './helpers'
import { sessionFile } from './session'

// The shared session (session.ts): a run has no real sign-in to spare (ADR-0005), and a successful
// password change would end this session for every test sharing it. So the page's own wrong-password
// path runs for real, and its success path against a stubbed endpoint; test/account.test.ts proves
// the endpoint's behaviour.
test.use({ storageState: sessionFile })

test('the organization menu switches between the signed-in user’s organizations', async ({
  page,
}) => {
  await page.goto('/orgs/new')
  const first = await createOrg(page, 'sw')
  const menu = page.getByText(`Org ${first}`, { exact: true })

  await menu.click()
  await page.getByRole('link', { name: 'New organization' }).click()
  await page.getByRole('link', { name: 'Cancel' }).click()
  await expect(page).toHaveURL(/\/t\/[^/]+\/projects$/)

  await page.goto('/orgs/new')
  const second = await createOrg(page, 'sw')
  await expect(page.getByRole('heading', { name: `Org ${second}` })).toBeVisible()

  await page.getByText(`Org ${second}`, { exact: true }).click()
  await page.getByRole('link', { name: `Org ${first}` }).click()
  await expect(page).toHaveURL(new RegExp(`/t/${first}/projects$`))
  await expect(page.getByRole('heading', { name: `Org ${first}` })).toBeVisible()
})

test('a signed-in user changes their name on the account page', async ({ page }) => {
  await page.goto('/orgs/new')
  const slug = await createOrg(page, 'acc')
  await page.getByRole('link', { name: 'Account' }).click()
  await expect(page).toHaveURL(/\/account$/)
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible()

  const name = `Sam ${rand()}`
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(page.getByRole('status')).toHaveText('Name saved.')
  await page.reload()
  await expect(page.getByLabel('Name')).toHaveValue(name)

  await page.getByRole('link', { name: `Org ${slug}` }).click()
  await page.getByRole('link', { name: 'Members' }).click()
  await expect(page.getByText(name)).toBeVisible()
})

test('the password form reports a wrong current password and keeps fields out of the URL', async ({
  page,
}) => {
  const visited: string[] = []
  page.on('framenavigated', (f) => visited.push(f.url()))
  await page.goto('/account')
  await page.getByLabel('Current password').fill(`wrong-${PASSWORD}`)
  await page.getByLabel('New password').fill(`new-${PASSWORD}`)
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByRole('alert')).toHaveText('Invalid password')
  expect(visited.filter((u) => u.includes(PASSWORD))).toEqual([])
})

test('the password form asks to sign out other sessions and says it did', async ({ page }) => {
  let body: unknown
  await page.route('**/api/auth/change-password', async (route) => {
    body = route.request().postDataJSON()
    await route.fulfill({ json: { token: 'stub', user: {} } })
  })
  await page.goto('/account')
  await page.getByLabel('Current password').fill(PASSWORD)
  await page.getByLabel('New password').fill(`new-${PASSWORD}`)
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByRole('status')).toHaveText(
    'Password changed. Other sessions were signed out.',
  )
  expect(body).toEqual({
    currentPassword: PASSWORD,
    newPassword: `new-${PASSWORD}`,
    revokeOtherSessions: true,
  })
  await expect(page.getByLabel('Current password')).toHaveValue('')
})

test('signed out, the account page sends you to sign in and back', async ({ browser }) => {
  // Explicitly empty: browser.newContext() would inherit this file's shared session.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const page = await context.newPage()
  await page.goto('/account')
  await expect(page).toHaveURL(/\/login\?redirect=/)
  expect(new URL(page.url()).searchParams.get('redirect')).toBe('/account')
  await context.close()
})
