import { expect, test } from '@playwright/test'

// ADR-0018: the billing webhook route is wired and fails closed where no secret is configured
// (local dev and every preview).
test('billing webhook refuses deliveries without a configured secret', async ({ request }) => {
  const res = await request.post('/api/billing/webhooks/stripe', {
    headers: { 'stripe-signature': 't=1,v1=00' },
    data: { id: 'evt_x', type: 'customer.subscription.updated' },
  })
  expect(res.status()).toBe(503)
})
