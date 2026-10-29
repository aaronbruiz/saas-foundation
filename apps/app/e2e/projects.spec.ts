import { expect, test } from '@playwright/test'
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
