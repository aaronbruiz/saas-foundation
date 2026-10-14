import { createFileRoute } from '@tanstack/react-router'
import { authFor } from '../../../server/auth'
import { withDb } from '../../../server/db'

// Better Auth handler (ADR-0005). The one route allowed to reach packages/auth (via server/).
const handle = ({ request }: { request: Request }) => withDb((db) => authFor(db).handler(request))

export const Route = createFileRoute('/api/auth/$')({
  server: { handlers: { GET: handle, POST: handle } },
})
