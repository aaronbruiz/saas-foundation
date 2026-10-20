import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { handlePolarWebhook } from '../../../../modules/billing/webhook'

// ADR-0022. Worker secret POLAR_WEBHOOK_SECRET; unset (previews, local dev) → 503.
export const Route = createFileRoute('/api/billing/webhooks/polar')({
  server: {
    handlers: {
      POST: ({ request }) => handlePolarWebhook(request, env.POLAR_WEBHOOK_SECRET),
    },
  },
})
