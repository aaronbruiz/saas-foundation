import { writeFileSync } from 'node:fs'
import { expect, test as setup } from '../e2e/fixtures'
import { PASSWORD, createAccount, createOrg, verifyAndSignIn } from '../e2e/helpers'
import { sessionFile } from '../e2e/session'
import { teamFile } from './team'

// Visual tests need an organization with a second member, so the settings page shows the
// transfer picker. The candidate is a fixed account, so the picker's text (and the baseline) is the
// same on every run: it signs up the first time and signs in afterwards.
const candidate = 'visual-candidate@e2e.test'

setup('an organization with a second member', async ({ browser }) => {
  const owner = await (await browser.newContext({ storageState: sessionFile })).newPage()
  await owner.goto('/orgs/new')
  const slug = await createOrg(owner, 'vis')
  await owner.getByRole('link', { name: 'Invite' }).click()
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
  writeFileSync(teamFile, JSON.stringify({ slug }))
})
