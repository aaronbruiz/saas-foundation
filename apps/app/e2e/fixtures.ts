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

export const test = base.extend<{ cspRefusals: Refusal[] }>({
  cspRefusals: [
    async ({ context, browser }, use) => {
      const refusals: Refusal[] = []
      await watch(context, refusals)
      const newContext = browser.newContext.bind(browser)
      browser.newContext = async (...args) => {
        const c = await newContext(...args)
        await watch(c, refusals)
        return c
      }
      await use(refusals)
      browser.newContext = newContext
      expect(refusals, 'CSP refusals in the browser (ADR-0045)').toEqual([])
    },
    { auto: true },
  ],
})
