// THROWAWAY (never merged): the ADR-0040 probe against local Postgres, before it runs on a preview.
import { env } from 'cloudflare:workers'
import { hyperdriveProbe } from '@saas-foundation/db'
import { expect, it } from 'vitest'
import { probeResponse } from '../src/server/probe'

it('the ADR-0040 probe passes every check through the real connection layer', async () => {
  const result = await hyperdriveProbe(env.DB.connectionString)
  expect(result.checks, JSON.stringify(result.checks)).toBeDefined()
  expect(Object.keys(result.checks).sort()).toEqual([
    'a_context_after_commit',
    'a_context_after_rollback',
    'a_context_inside',
    'a_context_inside_rolled_back_call',
    'b_failed_write_leaves_nothing',
    'c_status_after_commit',
    'c_status_after_rollback',
    'c_status_inside',
    'e_alternating_one_client',
    'e_alternating_separate_clients',
    'info_backend_pids',
  ])
  expect(result.ok, JSON.stringify(result.checks)).toBe(true)
})

it('the probe route answers 404 outside a workers.dev host', async () => {
  expect((await probeResponse('https://app.aaronlabr.dev/api/probe')).status).toBe(404)
  expect((await probeResponse('http://localhost:3000/api/probe')).status).toBe(404)
})
