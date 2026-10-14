import { describe, expect, it } from 'vitest'
import { safeRedirect, verifiedLoginUrl } from '../src/lib/safe-redirect'

describe('safeRedirect (open-redirect guard)', () => {
  it.each(['/', '/t/acme/projects', '/invite/abc?x=1#top'])('keeps same-site path %s', (p) => {
    expect(safeRedirect(p)).toBe(p)
  })
  it.each([
    '//evil.example',
    '/\\evil.example',
    '/\\/evil.example',
    'https://evil.example',
    'javascript:alert(1)',
    'evil.example',
    '',
    undefined,
    42,
  ])('rejects %s', (p) => {
    expect(safeRedirect(p)).toBe('/')
  })
})

describe('verifiedLoginUrl (verification link landing, ADR-0016)', () => {
  it('encodes a same-site target into the query', () => {
    const url = new URL(verifiedLoginUrl('/invite/abc?x=1&y=2#top'), 'http://app.test')
    expect(url.pathname).toBe('/login')
    expect(url.searchParams.get('verified')).toBe('1')
    expect(url.searchParams.get('redirect')).toBe('/invite/abc?x=1&y=2#top')
    expect(url.hash).toBe('')
  })
  it.each(['//evil.example', 'https://evil.example', '/\\evil.example', undefined])(
    'drops an off-site target %s',
    (p) => {
      expect(new URL(verifiedLoginUrl(p), 'http://app.test').searchParams.get('redirect')).toBe('/')
    },
  )
})
