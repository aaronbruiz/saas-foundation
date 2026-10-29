import { expect, type Page } from '@playwright/test'
import { verificationLink, verifiesEmail } from './mailbox'

// Helpers shared by the e2e specs and the session setup (auth.setup.ts).
export const rand = () => Math.random().toString(36).slice(2, 8)
export const PASSWORD = 'correct-horse-battery-staple'

/** Fills the sign-up form on the current page. */
export async function createAccount(page: Page, name: string, email: string) {
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
}

/**
 * ADR-0016: after sign-up there's no session until the address is verified. Follows the emailed
 * link, then signs in; the page continues to the sign-up page's `redirect`. Without verification
 * (previews) sign-up signs in directly.
 */
export async function verifyAndSignIn(page: Page, email: string) {
  if (!verifiesEmail) return
  const target = new URL(page.url()).searchParams.get('redirect')
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await page.goto(await verificationLink(email, target))
  await expect(page.getByText('Email verified. Sign in to continue.')).toBeVisible()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

export async function createOrg(page: Page, prefix: string) {
  const slug = `${prefix}-${rand()}`
  await expect(page).toHaveURL(/\/orgs\/new$/)
  await page.getByLabel('Organization name').fill(`Org ${slug}`)
  // The browser checks the slug before submitting (it ignores a `pattern` that isn't a valid
  // `v`-flag regex, so a broken one would let this through).
  const slugField = page.getByLabel('URL slug')
  const mismatch = () => slugField.evaluate((el: HTMLInputElement) => el.validity.patternMismatch)
  await slugField.fill('Bad_slug-')
  expect(await mismatch()).toBe(true)
  await slugField.fill(slug)
  expect(await mismatch()).toBe(false)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(new RegExp(`/t/${slug}/projects$`))
  return slug
}
