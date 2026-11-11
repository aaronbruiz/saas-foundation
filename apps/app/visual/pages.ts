import type { Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { expect } from '../e2e/fixtures'
import { teamFile } from './team'

// Shared by the visual tests (ADR-0046): the widths and themes each page is taken at, the dark
// theme switch, the shared organization, and the keyboard tab walk.

export const views = [
  { name: 'narrow', width: 320, height: 800 },
  { name: 'wide', width: 1280, height: 900 },
] as const
export const themes = ['light', 'dark'] as const
export type Theme = (typeof themes)[number]

/** The app follows the system theme (`prefers-color-scheme`): emulate the visitor's setting.
 * Call it before the page loads, as a visitor's system would have it. */
export async function setTheme(page: Page, theme: Theme) {
  await page.emulateMedia({ colorScheme: theme })
}

/** The organization visual/team.setup.ts made: its slug and the id of its one project. */
export const team = () =>
  JSON.parse(readFileSync(teamFile, 'utf8')) as { slug: string; projectId: string }

type Focused = { key: string; name: string; tag: string; focusStyle: string; frame: boolean }

// The focused element, with the styles that draw a focus indicator. Transitions are finished first
// (`getAnimations().finish()`), so a ring fading in reads as its end state.
const focused = (page: Page) =>
  page.evaluate((): Focused | null => {
    const el = document.activeElement as HTMLElement | null
    if (!el || el === document.body) return null
    const style = (e: HTMLElement) => {
      for (const a of e.getAnimations()) a.finish()
      const s = getComputedStyle(e)
      // An outline counts only when it's drawn (a style and a width); its width alone can differ.
      const outline =
        s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0
          ? `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`
          : 'none'
      return [outline, s.boxShadow, s.borderColor].join('|')
    }
    if (!el.dataset.kbd) el.dataset.kbd = String(document.querySelectorAll('[data-kbd]').length)
    const label =
      el.getAttribute('aria-label') ??
      (el as HTMLInputElement).labels?.[0]?.textContent ??
      el.textContent ??
      ''
    return {
      key: el.dataset.kbd,
      name: label.trim().replace(/\s+/g, ' ').slice(0, 60),
      tag: el.tagName.toLowerCase(),
      focusStyle: style(el),
      // A frame, or a host that isn't focusable itself: focus is inside its (closed) shadow root,
      // as in Turnstile's widget. Its indicator is the third party's.
      frame: el.tagName === 'IFRAME' || (el.tabIndex < 0 && !el.hasAttribute('tabindex')),
    }
  })

// The same element's indicator styles once it has lost focus (blurred if it still has it).
const unfocusedStyle = (page: Page, key: string) =>
  page.evaluate((k) => {
    const e = document.querySelector<HTMLElement>(`[data-kbd="${k}"]`)!
    // Firefox keeps the last stop as the active element when Tab leaves the page for the browser.
    if (document.activeElement === e) e.blur()
    for (const a of e.getAnimations()) a.finish()
    const s = getComputedStyle(e)
    // An outline counts only when it's drawn (a style and a width); its width alone can differ.
    const outline =
      s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0
        ? `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`
        : 'none'
    return [outline, s.boxShadow, s.borderColor].join('|')
  }, key)

/** Tabs from the top of the page to its end; every stop must look different while focused.
 * Returns the stops' names in order. */
export async function tabWalk(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const stops: Focused[] = []
  // Stops whose indicator is checked once focus is back in the page: while focus is inside a
  // frame or closed shadow root (Turnstile), Firefox keeps the stop before it matching `:focus`.
  const unchecked: Focused[] = []
  const check = async () => {
    for (const stop of unchecked.splice(0))
      expect
        .soft(
          await unfocusedStyle(page, stop.key),
          `"${stop.name}" (${stop.tag}) shows no focus indicator`,
        )
        .not.toBe(stop.focusStyle)
  }
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab')
    const now = await focused(page)
    const previous = stops.at(-1)
    // The previous stop has lost focus now, the last one included (focus left the page or wrapped).
    if (previous && !previous.frame) unchecked.push(previous)
    if (!now?.frame) await check()
    // Tab moves inside a frame or shadow root while the page still sees its host focused.
    if (now?.frame && previous?.key === now.key) continue
    if (!now || stops.some((s) => s.key === now.key)) {
      await check()
      return stops.map((s) => s.name)
    }
    stops.push(now)
  }
  throw new Error('the tab walk did not reach the end of the page in 60 stops')
}
