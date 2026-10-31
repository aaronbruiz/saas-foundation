import { expect, test } from '@playwright/test'
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

  const name = `Renamed ${rand()}`
  await page.getByLabel('Organization name', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(page.getByRole('status')).toHaveText('Name saved.')
  await expect(page.getByRole('heading', { name })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/t/${slug}/settings$`))

  await page.getByRole('button', { name: 'Leave organization' }).click()
  await expect(page.getByRole('alert')).toHaveText(
    "You're the only owner. Transfer ownership or delete the organization first.",
  )

  const confirm = page.getByLabel('Organization name to confirm')
  await confirm.fill('not the name')
  await page.getByRole('button', { name: 'Delete organization' }).click()
  await expect(page.getByRole('alert').last()).toHaveText(
    "That doesn't match the organization's name",
  )
  await expect(page).toHaveURL(new RegExp(`/t/${slug}/settings$`))

  await confirm.fill(name)
  await page.getByRole('button', { name: 'Delete organization' }).click()
  await expect(page).not.toHaveURL(new RegExp(`/t/${slug}/`))
  await page.goto(`/t/${slug}/settings`)
  await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible()
})
