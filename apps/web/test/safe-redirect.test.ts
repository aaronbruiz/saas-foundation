import { describe, expect, it } from 'vitest'
import { safeRedirect } from '../src/lib/safe-redirect'

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
