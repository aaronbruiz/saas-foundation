import type { Browser, Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { expect, test as setup } from '../e2e/fixtures'
import { PASSWORD, createAccount, createOrg, verifyAndSignIn } from '../e2e/helpers'
import { sessionFile } from '../e2e/session'
import { teamFile } from './team'

// Visual tests need an organization with two more members, so the settings page shows the
// transfer picker with a choice (the keyboard pass moves between its options). The candidates are
// fixed accounts, so the picker's text (and the baseline) is the same on every run: each signs up
// the first time and signs in afterwards.
const candidates = ['visual-candidate@e2e.test', 'visual-candidate-2@e2e.test']

async function join(browser: Browser, owner: Page, slug: string, candidate: string) {
  await owner.goto(`/t/${slug}/invite`)
  await owner.getByLabel('Invitee email').fill(candidate)
  await owner.getByRole('button', { name: 'Create invitation' }).click()
  const invitePath = new URL((await owner.getByTestId('invite-link').getAttribute('href')) ?? '')
    .pathname

  const page = await (await browser.newContext()).newPage()
  await page.goto(invitePath)
  await expect(page).toHaveURL(/\/login\?redirect=/)
  await page.getByLabel('Email').fill(candidate)
  await page.getByLabel('Password').fill(PASSWORD)
  const signIn = page.getByRole('button', { name: 'Sign in' })
  await expect(signIn).toBeEnabled({ timeout: 30_000 })
  await signIn.click()
  const accept = page.getByRole('button', { name: 'Accept invitation' })
  await expect(accept.or(page.getByRole('alert'))).toBeVisible()
  if (!(await accept.isVisible())) {
    // First run: no such account yet.
    await page.getByRole('link', { name: 'Sign up' }).click()
    await createAccount(page, 'Visual Candidate', candidate)
    await verifyAndSignIn(page, candidate)
  }
  await accept.click()
  await expect(page).toHaveURL(new RegExp(`/t/${slug}/projects$`))
}

setup('an organization with two more members', async ({ browser }) => {
  const owner = await (await browser.newContext({ storageState: sessionFile })).newPage()
  await owner.goto('/orgs/new')
  const slug = await createOrg(owner, 'vis')
  for (const candidate of candidates) await join(browser, owner, slug, candidate)
  writeFileSync(teamFile, JSON.stringify({ slug }))
})
