import { describe, expect, it } from 'vitest'
import { HttpError } from '../src/server/errors'
import { isUnknownServerFnError } from '../src/server/unknown-server-fn'

// ADR-0031 follow-up: an unknown server-function id is a 404, not an alerting 500.
describe('isUnknownServerFnError', () => {
  it.each([
    'Server function info not found for alert-test', // production build
    'Invalid server function ID: alert-test', // dev server
    'Server function not accessible from client: abc123', // exists, but not client-callable
  ])('recognises the resolver error "%s"', (message) => {
    expect(isUnknownServerFnError(new Error(message))).toBe(true)
  })

  it.each([
    new Error('db exploded'),
    new Error('Invalid server action param for serverFnId'),
    new HttpError(404, 'not found'),
    'Server function info not found for x',
    undefined,
  ])('leaves any other error to propagate (%s)', (e) => {
    expect(isUnknownServerFnError(e)).toBe(false)
  })
})
