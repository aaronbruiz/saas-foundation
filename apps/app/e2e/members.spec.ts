import { expect, test } from '@playwright/test'
import { createOrg } from './helpers'
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
