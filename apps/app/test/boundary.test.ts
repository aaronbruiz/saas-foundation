import { afterEach, describe, expect, it, vi } from 'vitest'
import { APIError } from 'better-auth/api'
import { HttpError } from '../src/server/errors'
import { forClient } from '../src/server/log'

// What a server function's caller receives when its service throws: serve() (server/boundary.ts)
// throws forClient(...)'s result. Only the error's message crosses to the browser (R01,
// 2026-10-29), so the message is the client contract. boundary.ts itself needs TanStack's server
// entry, which the workerd test pool doesn't provide.
afterEach(() => vi.restoreAllMocks())

const failure = async (e: unknown) => forClient('server_fn.unhandled', e)

describe('server-function errors as the client sees them', () => {
  it('an unexpected error reaches the client as a generic message, not its own', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const caught = await failure(new Error('duplicate key value violates unique constraint "x"'))
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('Something went wrong. Please try again.')
  })

  it('an unexpected error is still logged once, with its own redacted message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await failure(new Error('connection to bob@example.com failed'))
    expect(log).toHaveBeenCalledTimes(1)
    const line = JSON.parse(String(log.mock.calls[0]![0]))
    expect(line).toMatchObject({ level: 'error', event: 'server_fn.unhandled' })
    expect(line.error.message).toContain('connection to')
    expect(line.error.message).not.toContain('bob@example.com')
  })

  it('an expected application error keeps its message and status, unlogged', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const caught = await failure(new HttpError(403, 'Your plan allows 3 projects.'))
    expect(caught).toBeInstanceOf(HttpError)
    expect(caught).toMatchObject({ status: 403, message: 'Your plan allows 3 projects.' })
    expect(log).not.toHaveBeenCalled()
  })

  it('a Better Auth client error keeps its message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const caught = await failure(new APIError('BAD_REQUEST', { message: 'Invitation not found' }))
    expect((caught as Error).message).toBe('Invitation not found')
  })
})
