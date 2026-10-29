import { expect, test } from '@playwright/test'

// The uptime monitor's URL (ADR-0031 note): served by the Worker, without the database.
test('the ping route answers 200 with the running build', async ({ request }) => {
  const res = await request.get('/api/ping')
  expect(res.status()).toBe(200)
  expect(await res.json()).toMatchObject({ ok: true })
})
