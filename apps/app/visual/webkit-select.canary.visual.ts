import { WEBKIT_SELECT_REFUSALS, expect, test } from '../e2e/fixtures'

// Canary for the WebKit <select> exclusion (e2e/fixtures.ts, docs/testing.md): a bare page with
// the app's `style-src 'self'` and one native <select>, served by the test itself. WebKit refuses
// its own stylesheet for it; Chromium and Firefox refuse nothing. When WebKit stops refusing, this
// fails: delete WEBKIT_SELECT_REFUSALS and this test.
const url = 'http://localhost:3000/__visual-canary/select'

test('a bare native select under the CSP: WebKit refuses exactly the known stylesheet, others nothing', async ({
  page,
  browserName,
  cspState,
  allowWebKitSelect,
}) => {
  await page.route(url, (route) =>
    route.fulfill({
      contentType: 'text/html',
      headers: { 'content-security-policy': "default-src 'self'; style-src 'self'" },
      body: '<!doctype html><title>canary</title><label for="s">Pick</label><select id="s"><option>a</option><option>b</option></select>',
    }),
  )
  await page.goto(url)
  await expect(page.getByLabel('Pick')).toBeVisible()
  await page.evaluate(() => new Promise((r) => setTimeout(r, 500)))
  await allowWebKitSelect(page)
  const seen = cspState.refusals.map(({ directive, blocked, source }) => ({
    directive,
    blocked,
    source,
  }))
  expect(seen).toEqual(browserName === 'webkit' ? WEBKIT_SELECT_REFUSALS : [])
})
