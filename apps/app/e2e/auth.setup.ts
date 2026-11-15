import type { Locator, Page } from '@playwright/test'
import { expect, test as setup } from './fixtures'
import { PASSWORD, rand } from './helpers'
import { verificationLink, verifiesEmail } from './mailbox'
import { sessionFile } from './session'

// One real sign-up (and, with email verification, one sign-in) per run, through the pages, for
// every test that only needs someone signed in (session.ts). It has no organization yet. Both forms
// are completed with the keyboard only (Tab, typing, Enter): the accessibility check of sign-up and
// sign-in, at no cost to the login rate limit (ADR-0005).

/** Presses Tab until `field` has focus, then types `text` into it. */
async function tabAndType(page: Page, field: Locator, text: string) {
  for (let i = 0; i < 10 && !(await field.evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press('Tab')
  await expect(field).toBeFocused()
  await page.keyboard.type(text)
}

setup(
  'a shared user signs up and signs in with the keyboard only, and keeps the session',
  async ({ page }) => {
    const visited: string[] = []
    page.on('framenavigated', (f) => visited.push(f.url()))
    const email = `sam-${rand()}@e2e.test`
    await page.goto('/signup')
    // Enter submits once the button is enabled (hydrated, and Turnstile's test key has answered).
    await expect(page.getByRole('button', { name: 'Create account' })).toBeEnabled({
      timeout: 30_000,
    })
    await tabAndType(page, page.getByLabel('Name'), 'Sam')
    await tabAndType(page, page.getByLabel('Email'), email)
    await tabAndType(page, page.getByLabel('Password'), PASSWORD)
    await page.keyboard.press('Enter')
    if (verifiesEmail) {
      // ADR-0016: no session until the address is verified; the emailed link, then sign-in.
      const target = new URL(page.url()).searchParams.get('redirect')
      await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
      await page.goto(await verificationLink(email, target))
      await expect(page.getByText('Email verified. Sign in to continue.')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled({ timeout: 30_000 })
      await tabAndType(page, page.getByLabel('Email'), email)
      await tabAndType(page, page.getByLabel('Password'), PASSWORD)
      await page.keyboard.press('Enter')
    }
    await expect(page).toHaveURL(/\/orgs\/new$/)
    // With no organization yet there's nowhere to go back to.
    await expect(page.getByRole('link', { name: 'Cancel' })).toHaveCount(0)
    expect(visited.filter((u) => u.includes(PASSWORD))).toEqual([])
    await page.context().storageState({ path: sessionFile })
  },
)
