// THROWAWAY (never merged): the ADR-0040 latency probe against local Postgres, before the preview.
import { env } from 'cloudflare:workers'
import { createDb, latencyProbe } from '@saas-foundation/db'
import { rawDb } from '@saas-foundation/db/internal'
import { expect, it } from 'vitest'
import { probeResponse } from '../src/server/probe'

it('the latency probe returns a path and a matched sample per iteration', async () => {
  const result = await latencyProbe(env.DB.connectionString, 5)
  for (const samples of Object.values(result.paths)) {
    expect(samples.path).toHaveLength(5)
    expect(samples.matched).toHaveLength(5)
    expect(samples.path.every((ms) => ms >= 0)).toBe(true)
  }
  expect(result.info.selectOneMs).toHaveLength(5)
})

it('the probe route answers 404 outside a workers.dev host or without the operator key', async () => {
  const get = (url: string, key?: string) =>
    probeResponse(new Request(url, { headers: key ? { 'x-probe-key': key } : {} }))
  expect((await get('https://app.aaronlabr.dev/api/probe')).status).toBe(404)
  expect((await get('http://localhost:3000/api/probe')).status).toBe(404)
  expect((await get('https://pr-1-saas-foundation.x.workers.dev/api/probe')).status).toBe(404)
  expect((await get('https://pr-1-saas-foundation.x.workers.dev/api/probe', 'wrong')).status).toBe(
    404,
  )
})

it('the probe deletes its organization, membership and projects afterwards', async () => {
  const { db, close } = await createDb(env.DB.connectionString)
  const count = async () =>
    (
      await (
        rawDb(db) as unknown as {
          $client: { query: (q: string) => Promise<{ rows: Record<string, string>[] }> }
        }
      ).$client.query(
        "select (select count(*) from organization where id like 'probe-%') as o, (select count(*) from member where organization_id like 'probe-%') as m, (select count(*) from project where organization_id like 'probe-%') as p",
      )
    ).rows[0]
  try {
    const before = await count()
    await latencyProbe(env.DB.connectionString, 2)
    expect(await count()).toEqual(before)
  } finally {
    await close()
  }
})
