import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { verificationLink, verifiesEmail } from './mailbox'
import { createAccount, createOrg, PASSWORD, rand, verifyAndSignIn } from './helpers'
import { sessionFile } from './session'

// Vertical Slice 001 end to end (spec §8/§11): sign-up → organization → project → invite →
// accept, and cross-tenant isolation through real URLs (404 page, never data).
const notFound = (page: Page) =>
  expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible()

// Every context/page the test opens is tracked, so the password-in-URL regression covers all of
// them (a pre-hydration native submit once put the password into the URL).
const contexts: BrowserContext[] = []
const visited: string[] = []
// Turnstile logs when a widget's element disappears without `turnstile.remove()` (or is removed
// twice); any such message means the widget lifecycle is broken.
const turnstileLogs: string[] = []

async function newPage(browser: Browser, storageState?: string): Promise<Page> {
  const context = await browser.newContext({ storageState })
  contexts.push(context)
  const page = await context.newPage()
  page.on('framenavigated', (f) => visited.push(f.url()))
  page.on('console', (m) => {
    if (m.text().includes('[Cloudflare Turnstile]'))
      turnstileLogs.push(`${m.type()} on ${page.url()}: ${m.text()}`)
  })
  return page
}

async function signUp(browser: Browser, name: string, path = '/signup') {
  const page = await newPage(browser)
  const email = `${name.toLowerCase()}-${rand()}@e2e.test`
  await page.goto(path)
  await createAccount(page, name, email)
  await verifyAndSignIn(page, email)
  return { page, email }
}

test.afterEach(async () => {
  // Soft, so the cleanup below still runs and an earlier test failure is reported alongside it.
  expect.soft(turnstileLogs.splice(0), 'Turnstile console messages').toEqual([])
  // A test that skipped itself before opening a page (previews skip email verification) has
  // nothing to check.
  if (contexts.length > 0) expect(visited.length).toBeGreaterThan(0)
  expect(visited.filter((u) => u.includes(PASSWORD))).toEqual([])
  await Promise.all(contexts.splice(0).map((c) => c.close()))
  visited.length = 0
})

test('an unverified account cannot sign in until it follows the emailed link', async ({
  browser,
}) => {
  test.skip(!verifiesEmail, 'previews run without email verification')
  const page = await newPage(browser)
  const email = `dana-${rand()}@e2e.test`
  await page.goto('/signup')
  await createAccount(page, 'Dana', email)
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await page.getByRole('link', { name: 'Sign in' }).click()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toHaveText(
    'Verify your email address first. We sent you a new link.',
  )
  await page.goto('/orgs/new')
  await expect(page).toHaveURL(/\/login/) // still no session
  // A tampered link is refused and explained.
  await page.goto((await verificationLink(email, null)).replace('token=', 'token=x'))
  await expect(page.getByText('That verification link is invalid or has expired.')).toBeVisible()
  await page.goto(await verificationLink(email, null))
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/orgs\/new$/)
})

test('a password reset request shows the same confirmation for any address', async ({
  browser,
}) => {
  const page = await newPage(browser)
  await page.goto('/forgot-password')
  await page.getByLabel('Email').fill(`nobody-${rand()}@e2e.test`)
  await page.getByRole('button', { name: 'Send reset link' }).click()
  await expect(page.getByRole('status')).toHaveText(
    "If an account exists for that address, we've sent a link to reset the password.",
  )
  // Leave the page so the guard also covers the hook unmounting.
  await page.getByRole('link', { name: 'Back to sign in' }).click()
  await expect(page).toHaveURL(/\/login/)
})

test('sign-up, organization, projects, invitation and tenant isolation', async ({ browser }) => {
  // Alice: account → org A → project Alpha.
  const { page: alice } = await signUp(browser, 'Alice')
  const orgA = await createOrg(alice, 'a')
  await alice.getByLabel('Project name').fill('Alpha')
  await alice.getByRole('button', { name: 'Create project' }).click()
  await alice.getByRole('link', { name: 'Alpha' }).click()
  await expect(alice).toHaveURL(new RegExp(`/t/${orgA}/projects/[0-9a-f-]{36}$`))
  const alphaId = alice.url().split('/').pop()!
  // The URL changes before the detail page renders; wait for it (the list page also has a
  // "Description" field, so filling too early would type into the page being replaced).
  await expect(alice.getByRole('button', { name: 'Save' })).toBeVisible()
  await expect(alice.getByRole('heading', { name: 'Alpha' })).toBeVisible()

  // Edit within the tenant.
  await alice.getByLabel('Description').fill('first project')
  await alice.getByRole('button', { name: 'Save' }).click()
  await expect(alice.getByLabel('Description')).toHaveValue('first project')

  // Invite Carol; she signs up from the link and accepts.
  await alice.getByRole('link', { name: 'Invite' }).click()
  const carolEmail = `carol-${rand()}@e2e.test`
  await alice.getByLabel('Invitee email').fill(carolEmail)
  await alice.getByRole('button', { name: 'Create invitation' }).click()
  const link = await alice.getByTestId('invite-link').getAttribute('href')
  expect(link).toBeTruthy()
  const invitePath = new URL(link!).pathname

  const carol = await newPage(browser)
  await carol.goto(invitePath)
  await expect(carol).toHaveURL(/\/login\?redirect=/)
  await carol.getByRole('link', { name: 'Sign up' }).click()
  await createAccount(carol, 'Carol', carolEmail)
  await verifyAndSignIn(carol, carolEmail)
  await expect(carol).toHaveURL(new RegExp(`${invitePath}$`))
  await carol.getByRole('button', { name: 'Accept invitation' }).click()
  await expect(carol).toHaveURL(new RegExp(`/t/${orgA}/projects$`))
  await expect(carol.getByRole('link', { name: 'Alpha' })).toBeVisible()
  await expect(carol.getByRole('link', { name: 'Invite' })).toHaveCount(0) // member role
  await carol.getByRole('link', { name: 'Alpha' }).click()
  await expect(carol.getByRole('button', { name: 'Save' })).toBeVisible()
  await expect(carol.getByRole('button', { name: 'Delete project' })).toHaveCount(0) // member role
  await expect(carol.getByRole('link', { name: 'Billing' })).toHaveCount(0) // member role
  // Opening the owner-only page anyway: the error page, with a way back (no framework default).
  await carol.goto(`/t/${orgA}/billing`)
  await expect(carol.getByRole('heading', { name: 'Something went wrong' })).toBeVisible()
  await expect(carol.getByRole('link', { name: 'Go home' })).toBeVisible()
  await expect(carol.getByTestId('plan-name')).toHaveCount(0)

  // Billing (ADR-0020): the owner sees the default plan and its usage. No provider is configured
  // locally or in previews, so starting a checkout fails closed with a clear message.
  await alice.getByRole('link', { name: 'Billing' }).click()
  await expect(alice.getByTestId('plan-name')).toHaveText('Free')
  await expect(alice.getByText('Projects: 1 of 3')).toBeVisible()
  await expect(alice.getByText('Members: 2 of 3')).toBeVisible()
  await alice.getByRole('button', { name: /^Upgrade to Pro \(monthly\)/ }).click()
  await expect(alice.getByRole('alert')).toHaveText('Billing is not configured')

  // Bob, the shared signed-in user (session.ts): his own org B; none of A is reachable, by tenant
  // URL or by project id.
  const bob = await newPage(browser, sessionFile)
  await bob.goto('/orgs/new')
  const orgB = await createOrg(bob, 'b')
  expect((await bob.goto(`/t/${orgA}`))?.status()).toBe(404)
  await notFound(bob)
  expect((await bob.goto(`/t/${orgA}/billing`))?.status()).toBe(404)
  await notFound(bob)
  await expect(bob.getByTestId('plan-name')).toHaveCount(0)
  expect((await bob.goto(`/t/${orgA}/invite`))?.status()).toBe(404)
  await notFound(bob)
  await expect(bob.getByLabel('Invitee email')).toHaveCount(0)
  await bob.goto(`/t/${orgA}/projects`)
  await notFound(bob)
  await bob.goto(`/t/${orgA}/projects/${alphaId}`)
  await notFound(bob)
  await bob.goto(`/t/${orgB}/projects/${alphaId}`)
  await notFound(bob)
  await bob.goto(`/t/${orgB}/projects`)
  await expect(bob.getByText('No projects yet.')).toBeVisible()

  // Signed out → login.
  const anon = await newPage(browser)
  await anon.goto(`/t/${orgA}/projects`)
  await expect(anon).toHaveURL(/\/login/)
})
