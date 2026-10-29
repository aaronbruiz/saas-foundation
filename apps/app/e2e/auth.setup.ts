import { expect, test as setup } from '@playwright/test'
import { createAccount, PASSWORD, rand, verifyAndSignIn } from './helpers'
import { sessionFile } from './session'

// One real sign-up (and, with email verification, one sign-in) per run, through the pages, for
// every test that only needs someone signed in (session.ts). It has no organization yet.
setup('a shared user signs up and keeps the session', async ({ page }) => {
  const visited: string[] = []
  page.on('framenavigated', (f) => visited.push(f.url()))
  const email = `sam-${rand()}@e2e.test`
  await page.goto('/signup')
  await createAccount(page, 'Sam', email)
  await verifyAndSignIn(page, email)
  await expect(page).toHaveURL(/\/orgs\/new$/)
  expect(visited.filter((u) => u.includes(PASSWORD))).toEqual([])
  await page.context().storageState({ path: sessionFile })
})
