// THROWAWAY (never merged): ADR-0040 preview checks through this Worker's DB binding (Hyperdrive on
// a PR preview). Answers only on a workers.dev host, so a production build would 404 it anyway.
import { env } from 'cloudflare:workers'
import { hyperdriveProbe } from '@saas-foundation/db'

declare const __BUILD_INFO__: { version: string; commit: string; build: string }

export async function probeResponse(url: string): Promise<Response> {
  if (!new URL(url).hostname.endsWith('.workers.dev'))
    return new Response('Not Found', { status: 404 })
  const result = await hyperdriveProbe(env.DB.connectionString)
  return Response.json(
    { ...result, build: __BUILD_INFO__ },
    { headers: { 'cache-control': 'no-store' } },
  )
}
