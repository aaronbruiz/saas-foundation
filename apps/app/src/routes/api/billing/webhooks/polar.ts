import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { handlePolarWebhook } from '../../../../modules/billing/webhook'

// ADR-0022. Worker secret POLAR_WEBHOOK_SECRET; unset (previews, local dev) → 503.
const vars = env as unknown as { POLAR_WEBHOOK_SECRET?: string }

export const Route = createFileRoute('/api/billing/webhooks/polar')({
  server: {
    handlers: {
      POST: ({ request }) => handlePolarWebhook(request, vars.POLAR_WEBHOOK_SECRET),
    },
  },
})
