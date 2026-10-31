import { createFileRoute } from '@tanstack/react-router'
import { probeResponse } from '../../server/probe'

// THROWAWAY (never merged): ADR-0043's and ADR-0044's release gates.
export const Route = createFileRoute('/api/probe')({
  server: {
    handlers: {
      GET: ({ request }) => probeResponse(request),
    },
  },
})
