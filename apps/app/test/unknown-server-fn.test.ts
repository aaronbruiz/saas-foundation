import { describe, expect, it } from 'vitest'
import { HttpError } from '../src/server/errors'
import { isUnknownServerFnError, isUnknownServerFnPath } from '../src/server/unknown-server-fn'

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

describe('isUnknownServerFnPath', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'recognises an id named like an Object.prototype member (%s)',
    (id) => {
      expect(isUnknownServerFnPath(`/_serverFn/${id}`)).toBe(true)
    },
  )

  it.each([
    '/_serverFn/',
    '/_serverFn/abc123',
    '/_serverFn/abc123/x',
    '/_serverFn/%5F%5Fproto%5F%5F',
  ])('leaves %s to the resolver', (pathname) => {
    expect(isUnknownServerFnPath(pathname)).toBe(false)
  })
})
