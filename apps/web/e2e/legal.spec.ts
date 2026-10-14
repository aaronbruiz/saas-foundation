import { expect, test } from '@playwright/test'

// Legal pages are public: reachable signed out from the footer on every page, and from sign-up.
test('footer links reach each legal page', async ({ page }) => {
  for (const [link, heading] of [
    ['Privacy', 'Privacy Policy'],
    ['Terms', 'Terms of Service'],
    ['Subprocessors', 'Subprocessors'],
  ]) {
    await page.goto('/login')
    await page.getByRole('navigation', { name: 'Legal' }).getByRole('link', { name: link }).click()
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
  }
  await expect(page.getByRole('cell', { name: 'Neon', exact: true })).toBeVisible()
})

test('the privacy policy and the terms are in effect, without placeholders', async ({ page }) => {
  for (const path of ['/privacy', '/terms']) {
    await page.goto(path)
    await expect(page.getByText(/Effective \d{4}-\d{2}-\d{2}/)).toBeVisible()
    await expect(page.getByRole('note')).toHaveCount(0)
    await expect(page.getByText('Placeholder')).toHaveCount(0)
  }
})

test('sign-up links to the terms and the privacy policy', async ({ page }) => {
  await page.goto('/signup')
  const form = page.locator('form')
  await form.getByRole('link', { name: 'Terms' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Terms of Service' })).toBeVisible()
  await page.goto('/signup')
  await form.getByRole('link', { name: 'Privacy Policy' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeVisible()
})
