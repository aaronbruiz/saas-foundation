import { createFileRoute } from '@tanstack/react-router'
import { healthResponse } from '../../server/health'

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: ({ request }) => healthResponse(request.headers.get('cf-ray') ?? undefined),
    },
  },
})
