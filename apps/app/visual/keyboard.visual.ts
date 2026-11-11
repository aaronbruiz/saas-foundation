import type { Page } from '@playwright/test'
import { expect, test } from '../e2e/fixtures'
import { sessionFile } from '../e2e/session'
import { hydrated, setTheme, tabWalk, team, themes } from './pages'

// Keyboard pass on the pilot page (ADR-0046, docs/testing.md), in every browser and both themes:
// the tab order reaches the page's controls in reading order, each one shows a visible focus
// indicator, the transfer picker answers arrow keys and Escape without losing focus, and the
// rename toast doesn't take focus. Runs in every `pnpm test:visual` mode; it takes no screenshots.
// The settings page's transfer dialog keeps Tab inside it, and Cancel and Escape close it, return
// focus to the page's button and send nothing. No page uses a menu yet.

const settingsControls = [
  'Organization name',
  'Save name',
  'New owner',
  'Transfer ownership',
  'Leave organization',
  'Organization name to confirm',
  'Delete organization',
]

for (const theme of themes)
  test.describe(`keyboard ${theme}`, () => {
    test.use({ storageState: sessionFile, viewport: { width: 1280, height: 900 } })

    async function openSettings(page: Page) {
      await setTheme(page, theme)
      await page.goto(`/t/${team().slug}/settings`)
      await expect(page.getByRole('button', { name: 'Save name' })).toBeEnabled(hydrated)
    }

    test('settings: tab order follows the page and every stop shows focus', async ({
      page,
      allowWebKitSelect,
    }) => {
      await openSettings(page)
      await allowWebKitSelect(page)
      const names = await tabWalk(page)
      // The page's own controls, in reading order (the nav and footer links around them vary by
      // browser: WebKit skips links on Tab by default).
      expect(names.filter((n) => settingsControls.includes(n))).toEqual(settingsControls)
    })

    test('settings: the transfer dialog keeps focus inside, and Cancel and Escape send nothing', async ({
      page,
      allowWebKitSelect,
    }) => {
      await openSettings(page)
      await allowWebKitSelect(page)
      const transfer = page.getByRole('button', { name: 'Transfer ownership' })
      const dialog = page.getByRole('alertdialog')
      for (const close of ['Escape', 'Cancel'] as const) {
        await transfer.click()
        await expect(dialog).toBeVisible()
        // More presses than the dialog has buttons: Tab wraps around inside it.
        for (let i = 0; i < 4; i++) {
          await page.keyboard.press('Tab')
          expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)
        }
        if (close === 'Escape') await page.keyboard.press('Escape')
        else await dialog.getByRole('button', { name: 'Cancel' }).click()
        await expect(dialog).toHaveCount(0)
        await expect(transfer).toBeFocused()
      }
      // Nothing was sent: both candidates are still members.
      await page.reload()
      await expect(page.getByLabel('New owner').getByRole('option')).toHaveText([
        /\(member\)$/,
        /\(member\)$/,
      ])
    })

    test('settings: the transfer picker answers arrow keys and Escape, and keeps focus', async ({
      page,
      browserName,
      allowWebKitSelect,
    }) => {
      // Playwright's WebKit drives a native popup the page can't see: ArrowDown leaves the value
      // and Space opens the list unobservably. Covered in Chromium and Firefox; Safari by hand.
      test.skip(browserName === 'webkit', 'native select popup, not drivable in Playwright WebKit')
      await openSettings(page)
      await allowWebKitSelect(page)
      const picker = page.getByLabel('New owner')
      await picker.focus()
      const values = await picker.evaluate((s) =>
        [...(s as unknown as HTMLSelectElement).options].map((o) => o.value),
      )
      expect(values).toHaveLength(2)
      const isOpen = () =>
        picker.evaluate((s) => {
          try {
            return s.matches(':open')
          } catch {
            return false
          }
        })
      // A closed native select changes its value on ArrowDown; a customizable one
      // (`appearance: base-select`) may open its picker instead, where Enter picks the option.
      await page.keyboard.press('ArrowDown')
      if (await isOpen()) {
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('Enter')
      }
      await expect(picker).toHaveValue(values[1]!)
      await expect(picker).toBeFocused()
      await page.keyboard.press('ArrowUp')
      if (await isOpen()) {
        await page.keyboard.press('ArrowUp')
        await page.keyboard.press('Enter')
      }
      await expect(picker).toHaveValue(values[0]!)
      // Escape closes an open picker and leaves focus on the select. Firefox opens the OS list,
      // which the page can't see; its arrow keys are checked above.
      if (browserName === 'chromium') {
        await picker.click()
        await expect.poll(isOpen).toBe(true)
        await page.keyboard.press('Escape')
        expect(await isOpen()).toBe(false)
        await expect(picker).toBeFocused()
        await expect(picker).toHaveValue(values[0]!)
      }
    })

    test('settings: the rename toast appears without taking focus', async ({
      page,
      allowWebKitSelect,
    }) => {
      await openSettings(page)
      await allowWebKitSelect(page)
      const name = page.getByLabel('Organization name', { exact: true })
      await name.focus()
      // The same name again: the data, and the masked baseline, stay the same.
      await page.keyboard.press('Enter')
      await expect(page.getByRole('region', { name: /Notifications/ })).toContainText('Name saved.')
      const inToast = await page.evaluate(
        () => !!document.activeElement?.closest('[data-sonner-toaster]'),
      )
      expect(inToast).toBe(false)
      await expect(name).toBeFocused()
    })
  })
