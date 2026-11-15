import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect } from './fixtures'

// Automated accessibility checks for the e2e suite (docs/design-system/foundations/accessibility.md).
// They catch repeatable problems only: a page that passes them can still be hard to use with a
// screen reader, which these don't run.

// axe's WCAG 2.0, 2.1 and 2.2 A and AA rules, and its best practices (landmarks, heading order).
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']

/** axe finds no violation on the page as it is now, in both themes. `state` names it in a failure. */
export async function expectNoAxeViolations(page: Page, state: string) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    // Switching the theme starts the controls' colour transitions, and a dialog opens with an
    // animation: axe measures what's on screen, so mid-transition colours read as low contrast
    // (seen: 3.62:1 on the solid destructive button, whose settled pair passes). Measure the end
    // state, which is what the brand contrast test checks too.
    await page.evaluate(() => document.getAnimations().forEach((a) => a.finish()))
    const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze()
    const found = violations.map((v) => ({
      rule: v.id,
      help: v.help,
      targets: v.nodes.map((n) => `${n.target.join(' ')}: ${n.failureSummary ?? ''}`),
    }))
    expect.soft(found, `axe violations: ${state}, ${colorScheme} theme`).toEqual([])
  }
  await page.emulateMedia({ colorScheme: null })
}

/** Neither page width nor text size makes the page scroll sideways: 320 × 256 CSS px (WCAG 1.4.10,
 * a 1280 px window at 400%) and 200% text in a 640 px window (1.4.4). Restores the viewport. */
export async function expectReflow(page: Page, state: string) {
  const original = page.viewportSize()
  const sideways = () =>
    page.evaluate(() => {
      const root = document.documentElement
      return root.scrollWidth > root.clientWidth
    })
  await page.setViewportSize({ width: 320, height: 256 })
  expect.soft(await sideways(), `scrolls sideways at 320 px: ${state}`).toBe(false)
  await page.setViewportSize({ width: 640, height: 512 })
  // Through the CSSOM, which the CSP allows (it refuses `style` attributes in markup only).
  await page.evaluate(() => (document.documentElement.style.fontSize = '200%'))
  expect.soft(await sideways(), `scrolls sideways at 200% text: ${state}`).toBe(false)
  await page.evaluate(() => (document.documentElement.style.fontSize = ''))
  if (original) await page.setViewportSize(original)
}

/** Both checks above. */
export async function expectAccessible(page: Page, state: string) {
  await expectNoAxeViolations(page, state)
  await expectReflow(page, state)
}
