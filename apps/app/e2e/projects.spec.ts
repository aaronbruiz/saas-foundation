import { expect, test } from './fixtures'
import { createOrg } from './helpers'
import { sessionFile } from './session'

test.use({ storageState: sessionFile })

test('renaming a project shows the new name in the project list', async ({ page }) => {
  await page.goto('/orgs/new')
  const slug = await createOrg(page, 'r')
  await page.getByLabel('Project name').fill('Before')
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('link', { name: 'Before' }).click()
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible()
  await page.getByLabel('Project name').fill('After')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { name: 'After' })).toBeVisible()
  await page.goto(`/t/${slug}/projects`)
  await expect(page.getByRole('link', { name: 'After' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Before' })).toHaveCount(0)
})

test('creating a project: Enter twice and a click while it runs create one project', async ({
  page,
}) => {
  await page.goto('/orgs/new')
  await createOrg(page, 'dup')
  let sent = 0
  let answer: () => void = () => {}
  await page.route('**/_serverFn/**', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    sent++
    await new Promise<void>((resolve) => (answer = resolve))
    await route.fallback()
  })
  const name = page.getByLabel('Project name')
  await expect(page.getByRole('button', { name: 'Create project' })).toBeEnabled()
  await name.fill('Once')
  await name.press('Enter')
  await name.press('Enter')
  const busy = page.getByRole('button', { name: 'Creating…' })
  await expect(busy).toBeDisabled()
  await busy.click({ force: true })
  answer()
  await expect(page.getByRole('link', { name: 'Once' })).toHaveCount(1)
  await expect(name).toHaveValue('')
  expect(sent).toBe(1)
})

test("creating a project: a lost answer doesn't invite a retry, and the list shows what was created", async ({
  page,
}) => {
  await page.goto('/orgs/new')
  await createOrg(page, 'lost')
  // The server creates the project; its answer never reaches the page.
  await page.route('**/_serverFn/**', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    await route.fetch()
    await route.abort()
  })
  await expect(page.getByRole('button', { name: 'Create project' })).toBeEnabled()
  await page.getByLabel('Project name').fill('Maybe')
  await page.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('alert')).toHaveText(
    "We couldn't confirm the project was created. Check the list before trying again.",
  )
  await expect(page.getByRole('link', { name: 'Maybe' })).toBeVisible()
  // What was typed stays.
  await expect(page.getByLabel('Project name')).toHaveValue('Maybe')
})

test('deleting a project is confirmed in a dialog; Cancel and Escape send nothing', async ({
  page,
}) => {
  await page.goto('/orgs/new')
  const slug = await createOrg(page, 'del')
  await page.getByLabel('Project name').fill('Doomed')
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('link', { name: 'Doomed' }).click()
  const button = page.getByRole('button', { name: 'Delete project' })
  await expect(button).toBeEnabled()
  const dialog = page.getByRole('alertdialog', { name: 'Delete Doomed?' })

  let sent = 0
  page.on('request', (r) => {
    if (r.url().includes('/_serverFn/') && r.method() === 'POST') sent++
  })
  for (const close of ['Cancel', 'Escape'] as const) {
    await button.click()
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText("You can't undo this from the app.")
    // The least destructive choice has focus first.
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
    if (close === 'Escape') await page.keyboard.press('Escape')
    else await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(button).toBeFocused()
  }
  expect(sent).toBe(0)

  await button.click()
  await dialog.getByRole('button', { name: 'Delete project' }).click()
  await expect(page).toHaveURL(new RegExp(`/t/${slug}/projects$`))
  await expect(page.getByRole('link', { name: 'Doomed' })).toHaveCount(0)
  expect(sent).toBe(1)
})

test("deleting a project: while it runs the dialog stays open, and a lost answer isn't called a failure", async ({
  page,
}) => {
  await page.goto('/orgs/new')
  await createOrg(page, 'unk')
  await page.getByLabel('Project name').fill('Unsure')
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('link', { name: 'Unsure' }).click()
  let answer: () => void = () => {}
  await page.route('**/_serverFn/**', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    await new Promise<void>((resolve) => (answer = resolve))
    await route.abort()
  })
  await expect(page.getByRole('button', { name: 'Delete project' })).toBeEnabled()
  await page.getByRole('button', { name: 'Delete project' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete Unsure?' })
  await dialog.getByRole('button', { name: 'Delete project' }).click()
  await expect(dialog.getByRole('button', { name: 'Deleting…' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  answer()
  await expect(dialog.getByRole('alert')).toHaveText(
    "We couldn't confirm Unsure was deleted. Reload the page to check, and try again if it's still there.",
  )
})

test('saving a project: a second Enter while it runs sends nothing', async ({ page }) => {
  await page.goto('/orgs/new')
  await createOrg(page, 'save')
  await page.getByLabel('Project name').fill('Draft')
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('link', { name: 'Draft' }).click()
  let sent = 0
  let answer: () => void = () => {}
  await page.route('**/_serverFn/**', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    sent++
    await new Promise<void>((resolve) => (answer = resolve))
    await route.fallback()
  })
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()
  const name = page.getByLabel('Project name')
  await name.fill('Final')
  await name.press('Enter')
  await name.press('Enter')
  await expect(page.getByRole('button', { name: 'Saving…' })).toBeDisabled()
  answer()
  await expect(page.getByRole('heading', { name: 'Final' })).toBeVisible()
  expect(sent).toBe(1)
})
