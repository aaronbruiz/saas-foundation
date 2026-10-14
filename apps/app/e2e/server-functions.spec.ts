import { expect, test } from '@playwright/test'

// ADR-0031 follow-up: anyone can request a made-up server-function id; it's a 404 like any unknown
// path, not a 500 that raises an alert.
test('an unknown server-function id gets 404', async ({ request, baseURL }) => {
  const res = await request.post('/_serverFn/does-not-exist', {
    headers: { origin: new URL(baseURL!).origin, 'x-tsr-serverFn': 'true' },
    data: {},
  })
  expect(res.status()).toBe(404)
})
