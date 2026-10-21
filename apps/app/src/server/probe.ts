// THROWAWAY (never merged): ADR-0040 preview checks through this Worker's DB binding (Hyperdrive on
// a PR preview). Answers only on a workers.dev host and only to the operator: the `x-probe-key`
// header's SHA-256 must equal PROBE_KEY_SHA256 (the key itself is never committed). Anyone else gets 404.
import { env } from 'cloudflare:workers'
import { hyperdriveProbe } from '@saas-foundation/db'

const PROBE_KEY_SHA256 = 'cbd97da9d17a86753f2fbfdfff13a67097a5300e2512c315241c9ceb113e52a6'

const sha256 = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

declare const __BUILD_INFO__: { version: string; commit: string; build: string }

export async function probeResponse(request: Request): Promise<Response> {
  const key = request.headers.get('x-probe-key')
  if (
    !new URL(request.url).hostname.endsWith('.workers.dev') ||
    !key ||
    (await sha256(key)) !== PROBE_KEY_SHA256
  )
    return new Response('Not Found', { status: 404 })
  const result = await hyperdriveProbe(env.DB.connectionString)
  return Response.json(
    { ...result, build: __BUILD_INFO__ },
    { headers: { 'cache-control': 'no-store' } },
  )
}
