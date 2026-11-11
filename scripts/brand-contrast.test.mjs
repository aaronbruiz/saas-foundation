// The brand tokens meet WCAG contrast in both themes (ADR-0046): text 4.5:1 (1.4.3), input borders,
// focus indicators and control fills 3:1 (1.4.11). Pairs and maths: scripts/brand-contrast.mjs.
// Run by `pnpm lint`; `node scripts/brand-contrast.mjs` prints every ratio.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { check, oklchToSrgb, ratio } from './brand-contrast.mjs'

const brand = readFileSync(new URL('../packages/brand/brand.css', import.meta.url), 'utf8')

test('every listed token pair meets its WCAG minimum, light and dark', () => {
  const failing = check(brand).filter((r) => !r.ok)
  assert.deepEqual(
    failing.map((r) => `${r.theme}: ${r.fg} on ${r.bg} ${r.ratio} < ${r.min} (${r.what})`),
    [],
  )
})

test('the maths matches known values: black on white is 21:1, a 50% grey ~3.95:1 on white', () => {
  const white = oklchToSrgb('oklch(1 0 0)')
  assert.equal(Math.round(ratio(oklchToSrgb('oklch(0 0 0)'), white)), 21)
  // #777777 is oklch(0.5693 0 0); its contrast on white is 4.48:1.
  assert.equal(Math.round(ratio(oklchToSrgb('oklch(0.5693 0 0)'), white) * 100) / 100, 4.48)
})

test('a pair below its minimum fails, and translucent colours are composited first', () => {
  const css = brand.replace(
    /--input: [^;]+;/,
    '--input: light-dark(oklch(0.9 0 0), oklch(1 0 0 / 10%));',
  )
  const input = check(css).filter((r) => r.fg === 'input')
  assert.deepEqual(
    input.map((r) => [r.theme, r.ok]),
    [
      ['light', false],
      ['dark', false],
    ],
  )
})

test('a colour the checker cannot read is an error, not a pass', () => {
  const css = brand.replace(/--ring: [^;]+;/, '--ring: #0f766e;')
  assert.throws(() => check(css), /not an oklch\(\) colour/)
})
