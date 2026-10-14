import { createAuthClient } from 'better-auth/react'
import { organizationClient } from 'better-auth/client/plugins'

// Browser client: talks to /api/auth/* on the same origin, which sets the session cookie.
export const authClient = createAuthClient({ plugins: [organizationClient()] })
