import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { handleStripeWebhook } from '../../../../modules/billing/webhook'

// ADR-0018. Worker secret STRIPE_WEBHOOK_SECRET; unset (previews, local dev) → 503.
const vars = env as unknown as { STRIPE_WEBHOOK_SECRET?: string }

export const Route = createFileRoute('/api/billing/webhooks/stripe')({
  server: {
    handlers: {
      POST: ({ request }) => handleStripeWebhook(request, vars.STRIPE_WEBHOOK_SECRET),
    },
  },
})
