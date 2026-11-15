import type { Locator, Page } from '@playwright/test'
import { expectAccessible } from './accessibility'
import { expect, test } from './fixtures'
import { createOrg } from './helpers'
import { sessionFile } from './session'
import { productTitle } from '../src/lib/title'

// The sign-up, sign-in, invitation, account and organization settings pages (runbook "Before
// admitting pilot users": Accessibility): axe and reflow on each page and state, each page's title,
// field errors described on their field, and tasks completed with the keyboard only. Sign-up and
// sign-in by keyboard are in auth.setup.ts and the invitee's page in slice.spec.ts: the login rate
// limit leaves no sign-in for this file (ADR-0005, docs/testing.md).

const title = (page: string) => `${page} · ${productTitle}`
const hydrated = { timeout: 15_000 }

/** Presses Tab until `target` has focus; fails if it isn't reached within `max` presses. */
async function tabTo(page: Page, target: Locator, max = 30) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return
    await page.keyboard.press('Tab')
  }
  await expect(target, `not reached by Tab in ${max} presses`).toBeFocused()
}

test('the signed-out pages have their titles, pass axe and reflow, with an error shown', async ({
  page,
}) => {
  for (const [path, name, ready] of [
    ['/login', 'Sign in', 'Sign in'],
    ['/signup', 'Create account', 'Create account'],
    ['/forgot-password', 'Reset your password', 'Send reset link'],
    ['/reset-password?token=e2e', 'Choose a new password', 'Change password'],
  ] as const) {
    await page.goto(path)
    await expect(page.getByRole('button', { name: ready })).toBeEnabled({ timeout: 30_000 })
    await expect(page).toHaveTitle(title(name))
    await expectAccessible(page, path)
  }
  // A reset without its token: the form-level alert.
  await page.goto('/reset-password')
  await page.getByLabel('New password').fill('correct-horse-battery-staple')
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByRole('alert')).toHaveText('This reset link is invalid or has expired.')
  await expectAccessible(page, 'reset-password error')
})

test.describe('signed in', () => {
  test.use({ storageState: sessionFile })

  test('the invite and members pages pass axe and reflow, and the email error describes its field', async ({
    page,
  }) => {
    await page.goto('/orgs/new')
    await expect(page).toHaveTitle(title('New organization'))
    await expectAccessible(page, 'new organization')
    const slug = await createOrg(page, 'a11y')
    await expect(page).toHaveTitle(title('Projects'))
    await expectAccessible(page, 'projects')

    await page.goto(`/t/${slug}/invite`)
    const email = page.getByLabel('Invitee email')
    const submit = page.getByRole('button', { name: 'Create invitation' })
    await expect(submit).toBeEnabled(hydrated)
    await expect(page).toHaveTitle(title('Invite a member'))
    await expectAccessible(page, 'invite')
    // `a@b` passes the browser's email check and fails the server's: a field error.
    await email.fill('a@b')
    await submit.click()
    await expect(email).toHaveAttribute('aria-invalid', 'true')
    await expect(email).toHaveAccessibleDescription('invalid input')
    await expectAccessible(page, 'invite email error')
    const invitee = `a11y-${crypto.randomUUID()}@test.local`
    await email.fill(invitee)
    await submit.click()
    await expect(page.getByTestId('invite-link')).toBeVisible()
    await expect(email).toHaveAccessibleDescription('')
    await expectAccessible(page, 'invitation created')
    await submit.click()
    await expect(page.getByRole('alert')).toHaveText('User is already invited to this organization')
    await expectAccessible(page, 'duplicate invitation')

    await page.goto(`/t/${slug}/members`)
    await expect(
      page.getByRole('button', { name: `Revoke invitation for ${invitee}` }),
    ).toBeEnabled(hydrated)
    await expect(page).toHaveTitle(title('Members'))
    await expectAccessible(page, 'members with a pending invitation')
  })

  test('the settings page passes axe and reflow, and the name error describes its field', async ({
    page,
  }) => {
    await page.goto('/orgs/new')
    const slug = await createOrg(page, 'a11s')
    await page.goto(`/t/${slug}/settings`)
    const save = page.getByRole('button', { name: 'Save name' })
    await expect(save).toBeEnabled(hydrated)
    await expect(page).toHaveTitle(title('Settings'))
    await expectAccessible(page, 'settings')
    // Spaces only pass the browser's `required` and fail the server's check: a field error.
    const name = page.getByLabel('Organization name')
    await name.fill('   ')
    await save.click()
    await expect(name).toHaveAttribute('aria-invalid', 'true')
    await expect(name).toHaveAccessibleDescription('invalid input')
    await expectAccessible(page, 'settings name error')

    await page.getByRole('button', { name: 'Delete organization' }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await expectAccessible(page, 'organization deletion dialog')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
  })

  test('the account page passes axe and reflow, and the name error describes its field', async ({
    page,
  }) => {
    let sent = 0
    await page.route('**/api/auth/delete-account', (route) => (sent++, route.abort()))
    await page.goto('/account')
    const save = page.getByRole('button', { name: 'Save name' })
    await expect(save).toBeEnabled(hydrated)
    await expect(page).toHaveTitle(title('Account'))
    await expectAccessible(page, 'account')
    const name = page.getByLabel('Name', { exact: true })
    await name.fill('   ')
    await save.click()
    await expect(name).toHaveAccessibleDescription('Enter a name.')
    await expectAccessible(page, 'account name error')

    await page.getByRole('button', { name: 'Delete account' }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await expectAccessible(page, 'account deletion dialog')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    expect(sent).toBe(0)
  })

  test('an invitation is created and revoked, and names are saved, with the keyboard only', async ({
    page,
  }) => {
    await page.goto('/orgs/new')
    const slug = await createOrg(page, 'kbd')

    // Invite: type the address into the focused field and press Enter.
    await page.goto(`/t/${slug}/invite`)
    await expect(page.getByRole('button', { name: 'Create invitation' })).toBeEnabled(hydrated)
    const invitee = `kbd-${crypto.randomUUID()}@test.local`
    await tabTo(page, page.getByLabel('Invitee email'))
    await page.keyboard.type(invitee)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('invite-link')).toBeVisible()

    // Revoke: Tab to the row's button and press Enter; focus lands on the list's heading.
    await page.goto(`/t/${slug}/members`)
    const revoke = page.getByRole('button', { name: `Revoke invitation for ${invitee}` })
    await expect(revoke).toBeEnabled(hydrated)
    await tabTo(page, revoke)
    await page.keyboard.press('Enter')
    await expect(page.getByText('No pending invitations.')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Pending invitations' })).toBeFocused()

    // Rename the organization: select the field's text, type, press Enter.
    await page.goto(`/t/${slug}/settings`)
    await expect(page.getByRole('button', { name: 'Save name' })).toBeEnabled(hydrated)
    await tabTo(page, page.getByLabel('Organization name'))
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type(`Kbd ${slug}`)
    await page.keyboard.press('Enter')
    await expect(page.getByText('Name saved.')).toBeVisible()
    await expect(page.getByRole('banner').getByRole('heading', { level: 1 })).toHaveText(
      `Kbd ${slug}`,
    )

    // The account's name: the same, with Tab and Enter (the shared user keeps the name Sam).
    await page.goto('/account')
    await expect(page.getByRole('button', { name: 'Save name' })).toBeEnabled(hydrated)
    await tabTo(page, page.getByLabel('Name', { exact: true }))
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('Sam')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('status')).toHaveText('Name saved.')
  })
})
