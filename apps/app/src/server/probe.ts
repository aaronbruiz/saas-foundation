// THROWAWAY (never merged): ADR-0043's and ADR-0044's release gates through this Worker's DB binding
// (Hyperdrive on a PR preview). Answers only on a workers.dev host and only to the operator: the
// `x-probe-key` header's SHA-256 must equal PROBE_KEY_SHA256 (the key itself is never committed).
// Anyone else gets 404.
import { env } from 'cloudflare:workers'
import { deletionProbe } from '@saas-foundation/db'
import { authFor } from './auth'
import { withDb } from './db'

const PROBE_KEY_SHA256 = 'cbd97da9d17a86753f2fbfdfff13a67097a5300e2512c315241c9ceb113e52a6'
const CAPTCHA_DUMMY = 'XXXX.DUMMY.TOKEN.XXXX'

const sha256 = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

declare const __BUILD_INFO__: { version: string; commit: string; build: string }

/** A real sign-up, sign-in and deletion through the handler, so the log event can be searched for. */
async function deleteThroughHandler() {
  const email = `probe-${crypto.randomUUID()}@probe.test`
  const password = `probe-${crypto.randomUUID()}`
  const ip = `10.${Array.from(crypto.getRandomValues(new Uint8Array(3))).join('.')}`
  const post = (path: string, body: unknown, cookie?: string) =>
    withDb((db) =>
      authFor(db).handler(
        new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: env.BETTER_AUTH_URL,
            'cf-connecting-ip': ip,
            'x-captcha-response': CAPTCHA_DUMMY,
            ...(cookie && { cookie }),
          },
          body: JSON.stringify(body),
        }),
      ),
    )
  const signUp = await post('/sign-up/email', { email, password, name: 'probe' })
  const signIn = await post('/sign-in/email', { email, password })
  const cookie = signIn.headers.get('set-cookie')?.split(';')[0]
  const { user } = (await signIn.json()) as { user: { id: string } }
  const wrong = await post('/delete-account', { password: `x${password}` }, cookie)
  const deleted = await post('/delete-account', { password }, cookie)
  const again = await post('/sign-in/email', { email, password })
  return {
    ok:
      signUp.ok &&
      signIn.ok &&
      wrong.status === 401 &&
      deleted.status === 200 &&
      again.status === 401,
    statuses: {
      signUp: signUp.status,
      signIn: signIn.status,
      wrong: wrong.status,
      deleted: deleted.status,
      again: again.status,
    },
    search_workers_logs_for: { event: 'account.deleted', subject_sha256: await sha256(user.id) },
  }
}

export async function probeResponse(request: Request): Promise<Response> {
  const key = request.headers.get('x-probe-key')
  if (
    !new URL(request.url).hostname.endsWith('.workers.dev') ||
    !key ||
    (await sha256(key)) !== PROBE_KEY_SHA256
  )
    return new Response('Not Found', { status: 404 })
  const result = await deletionProbe(env.DB.connectionString)
  const deletion = await deleteThroughHandler().catch((e: unknown) => ({
    ok: false,
    threw: String(e).slice(0, 300),
  }))
  return Response.json(
    { ...result, ok: result.ok && deletion.ok, deletion, build: __BUILD_INFO__ },
    { headers: { 'cache-control': 'no-store' } },
  )
}
