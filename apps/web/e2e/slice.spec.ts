import { expect, test, type Browser, type Page } from '@playwright/test'

// Vertical Slice 001 end to end (spec §8/§11): sign-up → organization → project → invite →
// accept, and cross-tenant isolation through real URLs (404 page, never data).
const rand = () => Math.random().toString(36).slice(2, 8)
const PASSWORD = 'correct-horse-battery-staple'
const notFound = (page: Page) =>
  expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible()

const visited: string[] = []

async function signUp(browser: Browser, name: string, path = '/signup') {
  const page = await (await browser.newContext()).newPage()
  page.on('framenavigated', (f) => visited.push(f.url()))
  const email = `${name.toLowerCase()}-${rand()}@e2e.test`
  await page.goto(path)
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  return { page, email }
}

async function createOrg(page: Page, prefix: string) {
  const slug = `${prefix}-${rand()}`
  await expect(page).toHaveURL(/\/orgs\/new$/)
  await page.getByLabel('Organization name').fill(`Org ${slug}`)
  await page.getByLabel('URL slug').fill(slug)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(new RegExp(`/t/${slug}/projects$`))
  return slug
}

// Regression: a pre-hydration native submit once put the password into the URL.
test.afterEach(async ({ context }) => {
  for (const page of context.pages()) expect(page.url()).not.toContain(PASSWORD)
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

  const carol = await (await browser.newContext()).newPage()
  await carol.goto(invitePath)
  await expect(carol).toHaveURL(/\/login\?redirect=/)
  await carol.getByRole('link', { name: 'Sign up' }).click()
  await carol.getByLabel('Name').fill('Carol')
  await carol.getByLabel('Email').fill(carolEmail)
  await carol.getByLabel('Password').fill(PASSWORD)
  await carol.getByRole('button', { name: 'Create account' }).click()
  await expect(carol).toHaveURL(new RegExp(`${invitePath}$`))
  await carol.getByRole('button', { name: 'Accept invitation' }).click()
  await expect(carol).toHaveURL(new RegExp(`/t/${orgA}/projects$`))
  await expect(carol.getByRole('link', { name: 'Alpha' })).toBeVisible()
  await expect(carol.getByRole('link', { name: 'Invite' })).toHaveCount(0) // member role

  // Bob: his own org B; none of A is reachable, by tenant URL or by project id.
  const { page: bob } = await signUp(browser, 'Bob')
  const orgB = await createOrg(bob, 'b')
  await bob.goto(`/t/${orgA}/projects`)
  await notFound(bob)
  await bob.goto(`/t/${orgA}/projects/${alphaId}`)
  await notFound(bob)
  await bob.goto(`/t/${orgB}/projects/${alphaId}`)
  await notFound(bob)
  await bob.goto(`/t/${orgB}/projects`)
  await expect(bob.getByText('No projects yet.')).toBeVisible()

  // No page ever navigated to a URL containing the password.
  expect(visited.filter((u) => u.includes(PASSWORD))).toEqual([])

  // Signed out → login.
  const anon = await (await browser.newContext()).newPage()
  await anon.goto(`/t/${orgA}/projects`)
  await expect(anon).toHaveURL(/\/login/)
})
