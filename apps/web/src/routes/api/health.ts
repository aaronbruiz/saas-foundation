import { createFileRoute } from '@tanstack/react-router'
import { checkDatabase } from '../../server/health'
import { logError } from '../../server/log'

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const db = await checkDatabase().catch((e: unknown) => {
          logError('health.db_down', e, { rayId: request.headers.get('cf-ray') ?? undefined })
          return false
        })
        return Response.json({ ok: db, db: db ? 'up' : 'down' }, { status: db ? 200 : 503 })
      },
    },
  },
})
