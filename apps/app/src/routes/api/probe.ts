import { createFileRoute } from '@tanstack/react-router'
import { probeResponse } from '../../server/probe'

// THROWAWAY (never merged): ADR-0040 preview checks.
export const Route = createFileRoute('/api/probe')({
  server: {
    handlers: {
      GET: ({ request }) => probeResponse(request),
    },
  },
})
