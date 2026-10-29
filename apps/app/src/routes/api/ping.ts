import { createFileRoute } from '@tanstack/react-router'
import { pingResponse } from '../../server/ping'

export const Route = createFileRoute('/api/ping')({
  server: {
    handlers: {
      GET: () => pingResponse(),
    },
  },
})
