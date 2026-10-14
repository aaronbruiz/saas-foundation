import { expect, test } from '@playwright/test'

// ADR-0031 follow-up: anyone can request a made-up server-function id; it's a 404 like any unknown
// path, not a 500 that raises an alert. Ids named like Object.prototype members included.
for (const id of ['does-not-exist', 'constructor', '__proto__']) {
  test(`an unknown server-function id gets 404 (${id})`, async ({ request, baseURL }) => {
    const res = await request.post(`/_serverFn/${id}`, {
      headers: { origin: new URL(baseURL!).origin, 'x-tsr-serverFn': 'true' },
      data: {},
    })
    expect(res.status()).toBe(404)
  })
}

// TanStack's CSRF check still applies with our own request middleware.
test('a cross-origin server-function request is refused with 403', async ({ request }) => {
  const res = await request.post('/_serverFn/does-not-exist', {
    headers: { origin: 'https://evil.example', 'x-tsr-serverFn': 'true' },
    data: {},
  })
  expect(res.status()).toBe(403)
})
