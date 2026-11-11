import {
  test as base,
  expect,
  type BrowserContext,
  type Page,
  type PageAssertionsToHaveScreenshotOptions,
} from '@playwright/test'

import { appendFileSync } from 'node:fs'

export { expect }

type Refusal = {
  url: string
  directive: string
  blocked: string
  source: string
  /** Reported while `snap` took a screenshot (visual tests only). */
  duringScreenshot: boolean
}
type CspState = {
  refusals: Refusal[]
  screenshot: boolean
  /** URLs a visual test showed with a <select> on them (`allowWebKitSelect`). */
  selectPages: Set<string>
}

// Fails any test whose pages hit a Content-Security-Policy refusal (ADR-0045): the browser reports
// it, and nothing else would fail. Covers the `page` fixture's context and every context a test
// opens with `browser.newContext()`. Specs import `test` from here, not from @playwright/test.
async function watch(context: BrowserContext, state: CspState) {
  await context.exposeBinding(
    '__cspRefusal',
    ({ page }, v: Omit<Refusal, 'url' | 'duringScreenshot'>) => {
      state.refusals.push({ url: page.url(), ...v, duringScreenshot: state.screenshot })
    },
  )
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      const report = (window as unknown as { __cspRefusal: (v: object) => void }).__cspRefusal
      void report({
        directive: e.effectiveDirective,
        blocked: e.blockedURI,
        source: `${e.sourceFile}:${e.lineNumber}`,
      })
    })
  })
  context.on('console', (m) => {
    if (/Content.Security.Policy|Refused to (apply|load|execute|frame|connect)/i.test(m.text()))
      state.refusals.push({
        url: m.page()?.url() ?? '',
        directive: 'console',
        blocked: m.text(),
        source: '',
        duringScreenshot: state.screenshot,
      })
  })
}

// Waits until every page has handed over the refusals it already reported, then closes it, so none
// can arrive after the check: a binding call queued before this round trip is delivered before it.
async function settle(contexts: BrowserContext[]) {
  const pages = contexts.flatMap((c) => c.pages())
  await Promise.all(
    pages.map((p) => p.evaluate(() => new Promise((r) => setTimeout(r, 0))).catch(() => {})),
  )
  await Promise.all(pages.map((p) => p.close().catch(() => {})))
}

// Two exclusions, both in WebKit visual tests only (owner-approved; docs/testing.md). Chromium,
// Firefox and the e2e suite allow no refusal at all.
// 1. Playwright's screenshotter injects <style>body {}</style> in WebKit (playwright-core
//    screenshotter.ts, syncAnimations) on each screenshot attempt: exactly one console message and
//    one `style-src-elem` report from its line 5 (`:5`, no file), while `snap` takes a screenshot.
//    The report's target is the document, so the element can't be identified; only an exact pair is
//    removed, and anything unpaired or different still fails. A page's own refused <style> reports
//    its script's file and line, and Chromium and Firefox refuse it with no exclusion at all.
const REFUSED_STYLESHEET =
  "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy."
const isScreenshotterReport = (r: Refusal) =>
  r.duringScreenshot &&
  r.directive === 'style-src-elem' &&
  r.blocked === 'inline' &&
  r.source === ':5'
const isScreenshotterConsole = (r: Refusal) =>
  r.duringScreenshot && r.directive === 'console' && r.blocked === REFUSED_STYLESHEET

function withoutScreenshotterStyle(refusals: Refusal[]) {
  const left = [...refusals]
  for (;;) {
    const report = left.findIndex(isScreenshotterReport)
    const message = left.findIndex(isScreenshotterConsole)
    if (report < 0 || message < 0) return left
    left.splice(Math.max(report, message), 1)
    left.splice(Math.min(report, message), 1)
  }
}

// 2. WebKit refuses its own stylesheet for a native <select> under `style-src 'self'`
//    (visual/webkit-select.canary.visual.ts reproduces it on a bare page and fails once WebKit
//    stops; then delete this). Exactly these refusals, at most once per page that has a <select>.
//    A page's own inline style is refused with the same `style-src-attr` report, so only one of
//    each is allowed per page: a second one (the page's) still fails, and Chromium and Firefox
//    refuse it on their own.
export const WEBKIT_SELECT_REFUSALS: Omit<Refusal, 'url' | 'duringScreenshot'>[] = [
  {
    directive: 'console',
    blocked: REFUSED_STYLESHEET,
    source: '',
  },
  { directive: 'style-src-attr', blocked: 'inline', source: ':1' },
]

function withoutWebKitSelect(refusals: Refusal[], selectPages: Set<string>) {
  const left = [...refusals]
  for (const url of selectPages)
    for (const expected of WEBKIT_SELECT_REFUSALS) {
      const i = left.findIndex(
        (r) =>
          r.url === url &&
          r.directive === expected.directive &&
          r.blocked === expected.blocked &&
          r.source === expected.source,
      )
      if (i >= 0) left.splice(i, 1)
    }
  return left
}

const roundTrip = (page: Page) =>
  page.evaluate(() => new Promise((r) => setTimeout(r, 0))).catch(() => {})

export const test = base.extend<{
  cspState: CspState
  cspRefusals: Refusal[]
  /** Set by playwright.visual.config.ts; enables the two WebKit exclusions above. */
  visual: boolean
  /** Visual tests: compare the page with its committed screenshot (ADR-0046). */
  snap: (name: string, options?: PageAssertionsToHaveScreenshotOptions) => Promise<void>
  /** Visual tests: record that the current page has a <select> (exclusion 2). */
  allowWebKitSelect: (page: Page) => Promise<void>
}>({
  visual: [false, { option: true }],
  // Playwright requires the destructured fixtures argument, even when empty.
  // eslint-disable-next-line no-empty-pattern
  cspState: async ({}, use) => use({ refusals: [], screenshot: false, selectPages: new Set() }),
  cspRefusals: [
    async ({ context, browser, browserName, visual, cspState }, use) => {
      const watched = [context]
      await watch(context, cspState)
      const newContext = browser.newContext
      browser.newContext = async (...args) => {
        const c = await newContext.apply(browser, args)
        watched.push(c)
        await watch(c, cspState)
        return c
      }
      try {
        await use(cspState.refusals)
      } finally {
        browser.newContext = newContext
      }
      await settle(watched)
      const refusals =
        visual && browserName === 'webkit'
          ? withoutWebKitSelect(withoutScreenshotterStyle(cspState.refusals), cspState.selectPages)
          : cspState.refusals
      expect(refusals, 'CSP refusals in the browser (ADR-0045)').toEqual([])
    },
    { auto: true },
  ],
  allowWebKitSelect: async ({ cspState }, use) => {
    await use(async (page) => {
      if ((await page.locator('select').count()) > 0) cspState.selectPages.add(page.url())
    })
  },
  snap: async ({ page, cspState, allowWebKitSelect }, use, testInfo) => {
    // `pnpm test:visual` mode (scripts/test-visual.mjs): `check` takes no screenshot, `baseline`
    // saves one, `compare` compares it with the baseline and records the outcome for the summary.
    const mode = process.env.VISUAL_MODE ?? 'check'
    await use(async (name, options) => {
      await allowWebKitSelect(page)
      if (mode === 'check') return
      await roundTrip(page)
      cspState.screenshot = true
      const errors = testInfo.errors.length
      try {
        await expect.soft(page).toHaveScreenshot(name, options)
      } finally {
        await roundTrip(page)
        cspState.screenshot = false
      }
      const error = testInfo.errors
        .slice(errors)
        .map((e) => e.message ?? '')
        .join('\n')
      const outcome = !error ? 'same' : /doesn't exist|missing/i.test(error) ? 'missing' : 'changed'
      if (process.env.VISUAL_RESULTS)
        appendFileSync(
          process.env.VISUAL_RESULTS,
          `${JSON.stringify({ name: `${testInfo.project.name}/${name}`, outcome })}\n`,
        )
    })
  },
})
