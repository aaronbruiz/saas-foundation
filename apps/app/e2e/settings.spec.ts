import { expect, test } from './fixtures'
import { createOrg, rand } from './helpers'
import { sessionFile } from './session'

test.use({ storageState: sessionFile })

test('an owner renames, cannot leave as the only owner, and deletes with the typed name', async ({
  page,
}) => {
  await page.goto('/orgs/new')
  const slug = await createOrg(page, 'st')
  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page).toHaveURL(new RegExp(`/t/${slug}/settings$`))
  await expect(page.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible()
  const danger = page.getByRole('region', { name: 'Danger zone' })
  await expect(danger.getByRole('heading', { name: 'Leave' })).toBeVisible()
  await expect(danger.getByRole('heading', { name: 'Delete organization' })).toBeVisible()

  // A blank name (after trimming) is invalid input: it marks the field.
  const nameField = page.getByLabel('Organization name', { exact: true })
  await nameField.fill('   ')
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(page.getByRole('alert')).toHaveText('invalid input')
  await expect(nameField).toHaveAttribute('aria-invalid', 'true')

  const name = `Renamed ${rand()}`
  await page.getByLabel('Organization name', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Save name' }).click()
  // The confirmation is a toast now (ADR-0046 pilot); same text, in the notifications region.
  await expect(
    page.getByRole('region', { name: /Notifications/ }).getByText('Name saved.'),
  ).toBeVisible()
  await expect(page.getByRole('heading', { name })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/t/${slug}/settings$`))

  await page.getByRole('button', { name: 'Leave organization' }).click()
  await expect(page.getByRole('alert')).toHaveText(
    "You're the only owner. Transfer ownership or delete the organization first.",
  )

  // Deletion opens a dialog and sends nothing; focus starts on its title, before the field.
  const deleteButton = danger.getByRole('button', { name: 'Delete organization' })
  const dialog = page.getByRole('alertdialog', { name: `Delete ${name}?` })
  await deleteButton.click()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading', { name: `Delete ${name}?` })).toBeFocused()
  await expect(dialog).toContainText(`Everyone loses access to ${name} at once, you included.`)
  const confirm = dialog.getByLabel(`Type ${name} to confirm`)
  const submit = dialog.getByRole('button', { name: 'Delete organization' })

  // A mismatched name (here: another case) keeps the final button disabled; Enter sends nothing.
  await confirm.fill(name.toUpperCase())
  await expect(submit).toBeDisabled()
  await confirm.press('Enter')
  await expect(dialog).toBeVisible()

  // Escape closes it, returns focus to the page's button, and a reopened dialog starts empty.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(deleteButton).toBeFocused()
  await deleteButton.click()
  await expect(confirm).toHaveValue('')
  await expect(submit).toBeDisabled()

  // The exact name enables it; deleting leaves the page, replacing its history entry.
  await confirm.fill(name)
  await expect(submit).toBeEnabled()
  await submit.click()
  await expect(page).not.toHaveURL(new RegExp(`/t/${slug}/`))
  await expect(
    page.getByRole('region', { name: /Notifications/ }).getByText(`${name} was deleted.`),
  ).toBeVisible()
  await page.goto(`/t/${slug}/settings`)
  await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible()
})

test('deleting an organization: the pending dialog stays open, a refusal keeps it open, and an unanswered request says the outcome is unknown', async ({
  page,
}) => {
  await page.goto('/orgs/new')
  const slug = await createOrg(page, 'sd')
  const name = `Org ${slug}`
  await page.goto(`/t/${slug}/settings`)
  await expect(page.getByRole('button', { name: 'Save name' })).toBeEnabled()
  const dialog = page.getByRole('alertdialog')
  const confirm = dialog.getByLabel(`Type ${name} to confirm`)
  const submit = dialog.getByRole('button', { name: /^(Delete organization|Deleting…)$/ })
  await page.getByRole('button', { name: 'Delete organization' }).click()
  await confirm.fill(name)

  // The request reaches the server with another name, as if the organization was renamed
  // meanwhile: the server's real 400 marks the field, and the dialog keeps the typed value.
  await page.route('**/_serverFn/**', (route) =>
    route.request().method() === 'POST'
      ? route.continue({ postData: route.request().postData()!.replace(name, `${name}x`) })
      : route.fallback(),
  )
  await submit.click()
  await expect(dialog.getByText("That doesn't match the organization's name")).toBeVisible()
  await expect(confirm).toHaveAttribute('aria-invalid', 'true')
  await expect(confirm).toHaveValue(name)
  await page.unrouteAll()

  // Held, then never answered: the dialog can't be closed meanwhile, and a second submit sends
  // nothing; the outcome is then reported as unknown, not as a refusal.
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  let posts = 0
  await page.route('**/_serverFn/**', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    posts++
    await held
    await route.abort('connectionreset')
  })
  await submit.click()
  await expect(submit).toHaveText('Deleting…')
  await expect(submit).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  await expect(confirm).toHaveAttribute('readonly', '')
  await confirm.press('Enter')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  release()
  await expect(dialog.getByRole('alert')).toHaveText(
    `We couldn't confirm ${name} was deleted. Reload the page to check, and try again if it's still there.`,
  )
  expect(posts).toBe(1)
  await expect(submit).toBeEnabled()
  await page.unrouteAll()

  // Nothing was deleted: the page still answers.
  await page.goto(`/t/${slug}/settings`)
  await expect(page.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible()
})
