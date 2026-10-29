import { fileURLToPath } from 'node:url'

// The shared signed-in user's browser state, written once per run by auth.setup.ts. Tests that
// aren't about signing in start from it instead of signing in again: the login rate limit (5 a
// minute from one IP, ADR-0005) caps a run's real sign-ins, so they're kept for the auth tests.
export const sessionFile = fileURLToPath(new URL('./.auth/session.json', import.meta.url))
