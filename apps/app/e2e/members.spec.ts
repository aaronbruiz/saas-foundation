import { expect, test } from '@playwright/test'
import { createAccount, createOrg, rand, verifyAndSignIn } from './helpers'
import { sessionFile } from './session'

test.use({ storageState: sessionFile })

test('an owner sees the members and revokes a pending invitation', async ({ page }) => {
  await page.goto('/orgs/new')
  await createOrg(page, 'm')
  const invitee = `i-${crypto.randomUUID()}@test.local`
  await page.getByRole('link', { name: 'Invite' }).click()
  await page.getByLabel('Invitee email').fill(invitee)
  await page.getByRole('button', { name: 'Create invitation' }).click()
  await expect(page.getByTestId('invite-link')).toBeVisible()

  await page.getByRole('link', { name: 'Members' }).click()
  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible()
  await expect(page.getByText('owner', { exact: true })).toBeVisible()
  const revoke = page.getByRole('button', { name: `Revoke invitation for ${invitee}` })
  await expect(revoke).toBeEnabled()
  await revoke.click()
  await expect(page.getByText('No pending invitations.')).toBeVisible()
  await expect(page.getByText(invitee)).toHaveCount(0)
})

test('an owner changes a role; an admin demotes and removes themselves', async ({
  page,
  browser,
}) => {
  await page.goto('/orgs/new')
  const slug = await createOrg(page, 'mm')
  const email = `mm-${rand()}@e2e.test`
  await page.getByRole('link', { name: 'Invite' }).click()
  await page.getByLabel('Invitee email').fill(email)
  await page.getByRole('button', { name: 'Create invitation' }).click()
  const link = await page.getByTestId('invite-link').getAttribute('href')
  const invitePath = new URL(link!).pathname

  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const other = await context.newPage()
  await other.goto(invitePath)
  await other.getByRole('link', { name: 'Sign up' }).click()
  await createAccount(other, 'Mia', email)
  await verifyAndSignIn(other, email)
  await expect(other).toHaveURL(new RegExp(`${invitePath}$`))
  await other.getByRole('button', { name: 'Accept invitation' }).click()
  await expect(other).toHaveURL(new RegExp(`/t/${slug}/projects$`))

  // An owner row has no actions; a member's has, for the owner only.
  await page.getByRole('link', { name: 'Members' }).click()
  await expect(page.getByRole('button', { name: `Make ${email} admin` })).toBeEnabled()
  await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(1)
  await other.getByRole('link', { name: 'Members' }).click()
  await expect(other.getByRole('heading', { name: 'Members' })).toBeVisible()
  await expect(other.getByRole('button', { name: /^Remove / })).toHaveCount(0)

  await page.getByRole('button', { name: `Make ${email} admin` }).click()
  await expect(page.getByRole('button', { name: `Make ${email} member` })).toBeVisible()

  // The admin demotes themselves and loses the actions.
  await other.reload()
  await other.getByRole('button', { name: `Make ${email} member` }).click()
  await expect(other.getByRole('button', { name: /^Remove / })).toHaveCount(0)

  // Promoted again, the admin removes themselves and lands outside the tenant.
  await page.reload()
  await page.getByRole('button', { name: `Make ${email} admin` }).click()
  await expect(page.getByRole('button', { name: `Make ${email} member` })).toBeVisible()
  await other.reload()
  await other.getByRole('button', { name: `Remove ${email}` }).click()
  await expect(other).toHaveURL(/\/orgs\/new$/)
  await other.goto(`/t/${slug}/members`)
  await expect(other.getByRole('heading', { name: 'Members' })).toHaveCount(0)

  await page.reload()
  await expect(page.getByText(email)).toHaveCount(0)
  await context.close()
})
