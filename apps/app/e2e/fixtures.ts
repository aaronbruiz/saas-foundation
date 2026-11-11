import { test as base, expect, type BrowserContext } from '@playwright/test'

export { expect }

type Refusal = { url: string; directive: string; blocked: string; source: string }

// Fails any test whose pages hit a Content-Security-Policy refusal (ADR-0045): the browser reports
// it, and nothing else would fail. Covers the `page` fixture's context and every context a test
// opens with `browser.newContext()`. Specs import `test` from here, not from @playwright/test.
async function watch(context: BrowserContext, refusals: Refusal[]) {
  await context.exposeBinding('__cspRefusal', ({ page }, v: Omit<Refusal, 'url'>) => {
    refusals.push({ url: page.url(), ...v })
  })
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
      refusals.push({
        url: m.page()?.url() ?? '',
        directive: 'console',
        blocked: m.text(),
        source: '',
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

export const test = base.extend<{ cspRefusals: Refusal[] }>({
  cspRefusals: [
    async ({ context, browser }, use) => {
      const refusals: Refusal[] = []
      const watched = [context]
      await watch(context, refusals)
      const newContext = browser.newContext
      browser.newContext = async (...args) => {
        const c = await newContext.apply(browser, args)
        watched.push(c)
        await watch(c, refusals)
        return c
      }
      try {
        await use(refusals)
      } finally {
        browser.newContext = newContext
      }
      await settle(watched)
      expect(refusals, 'CSP refusals in the browser (ADR-0045)').toEqual([])
    },
    { auto: true },
  ],
})
