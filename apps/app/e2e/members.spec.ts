import { expect, test } from './fixtures'
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
  // The nav marks the current page, and only that one.
  const nav = page.getByRole('navigation').first()
  await expect(nav.getByRole('link', { name: 'Members' })).toHaveAttribute('aria-current', 'page')
  await expect(nav.getByRole('link', { name: 'Projects' })).not.toHaveAttribute('aria-current')
  await expect(page.getByText('owner', { exact: true })).toBeVisible()
  const revoke = page.getByRole('button', { name: `Revoke invitation for ${invitee}` })
  await expect(revoke).toBeEnabled()
  await revoke.click()
  await expect(page.getByText('No pending invitations.')).toBeVisible()
  await expect(page.getByText(invitee)).toHaveCount(0)
})

test('the invite form marks the email only when the server rejects the email', async ({ page }) => {
  await page.goto('/orgs/new')
  await createOrg(page, 'iv')
  await page.getByRole('link', { name: 'Invite' }).click()
  const email = page.getByLabel('Invitee email')
  const submit = page.getByRole('button', { name: 'Create invitation' })

  // `a@b` passes the browser's email check and fails the server's: a field error.
  await email.fill('a@b')
  await submit.click()
  await expect(page.getByRole('alert')).toHaveText('invalid input')
  await expect(email).toHaveAttribute('aria-invalid', 'true')

  const invitee = `i-${crypto.randomUUID()}@test.local`
  await email.fill(invitee)
  await submit.click()
  await expect(page.getByTestId('invite-link')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(email).not.toHaveAttribute('aria-invalid')

  // The same address again: Better Auth refuses it as already invited, which isn't about the
  // email's form: a form-level alert, the field left unmarked.
  await submit.click()
  await expect(page.getByRole('alert')).toHaveText('User is already invited to this organization')
  await expect(email).not.toHaveAttribute('aria-invalid')
})
