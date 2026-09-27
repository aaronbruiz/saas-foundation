import { createFileRoute } from '@tanstack/react-router'
import { checkDatabase } from '../../server/health'

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: async () => {
        const db = await checkDatabase().catch(() => false)
        return Response.json({ ok: db, db: db ? 'up' : 'down' }, { status: db ? 200 : 503 })
      },
    },
  },
})
