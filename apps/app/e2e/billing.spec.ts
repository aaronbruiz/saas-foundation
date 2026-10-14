import { expect, test } from '@playwright/test'

// ADR-0018, ADR-0022: the billing webhook route is wired and fails closed where billing isn't
// configured (local dev and every preview).
test('billing webhook refuses deliveries without a configured secret', async ({ request }) => {
  const res = await request.post('/api/billing/webhooks/polar', {
    headers: { 'webhook-id': 'msg_x', 'webhook-timestamp': '1', 'webhook-signature': 'v1,AAAA' },
    data: { type: 'subscription.updated', timestamp: '2026-01-01T00:00:00Z', data: {} },
  })
  expect(res.status()).toBe(503)
})
