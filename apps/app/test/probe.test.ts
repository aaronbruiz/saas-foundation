// THROWAWAY (never merged): the release gates' probe against local Postgres, before it runs on a preview.
import { env } from 'cloudflare:workers'
import { deletionProbe } from '@saas-foundation/db'
import { expect, it } from 'vitest'
import { probeResponse } from '../src/server/probe'

it(
  'the release gates probe passes every check through the real connection layer',
  { timeout: 60_000 },
  async () => {
    const result = await deletionProbe(env.DB.connectionString)
    expect(result.ok, JSON.stringify(result.checks, null, 1)).toBe(true)
    expect(Object.keys(result.checks).sort()).toEqual([
      'gate_orders_writes',
      'in_flight_session_doesnt_survive',
      'isolation_read_committed',
      'owner_race_keeps_an_owner',
      'trigger_refuses_each_table',
    ])
  },
)

it('the probe answers 404 without its key', async () => {
  const res = await probeResponse(new Request('https://x.workers.dev/api/probe'))
  expect(res.status).toBe(404)
})
