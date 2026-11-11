// WCAG contrast of the brand tokens (packages/brand/brand.css), light and dark (ADR-0046).
// Reads the `:root` and `.dark` custom properties (oklch only), converts them to sRGB, composites
// translucent colours over their background the way browsers do (in gamma-encoded sRGB), and
// checks each pair below. Usage: node scripts/brand-contrast.mjs [css file]; the test imports it.
import { readFileSync } from 'node:fs'

// [foreground, background, minimum ratio, what it is, theme (both when absent)]. A token may carry an alpha
// (`destructive/10`), composited over the pair's background, or over `background` when it is the
// background itself. Text needs 4.5:1 (WCAG 1.4.3); input borders, focus indicators and control
// fills 3:1 (1.4.11). Disabled controls are exempt; decorative borders (`--border`) aren't listed.
export const PAIRS = [
  ['foreground', 'background', 4.5, 'body text'],
  ['card-foreground', 'card', 4.5, 'card text'],
  ['popover-foreground', 'popover', 4.5, 'menu, select and tooltip text'],
  ['primary-foreground', 'primary', 4.5, 'primary button text'],
  ['secondary-foreground', 'secondary', 4.5, 'secondary button text'],
  ['accent-foreground', 'accent', 4.5, 'hovered or highlighted item text'],
  ['muted-foreground', 'background', 4.5, 'secondary text'],
  ['muted-foreground', 'muted', 4.5, 'secondary text on muted surfaces'],
  ['muted-foreground', 'card', 4.5, 'secondary text in cards'],
  ['muted-foreground', 'popover', 4.5, 'secondary text in menus'],
  ['muted-foreground', 'secondary', 4.5, "secondary text on the site's soft panels"],
  ['primary', 'background', 4.5, 'link and primary-coloured text'],
  ['destructive', 'background', 4.5, 'error text'],
  ['destructive', 'destructive/10', 4.5, 'destructive button text on its tint'],
  ['destructive', 'destructive/20', 4.5, 'destructive button text, hovered (and its dark tint)'],
  ['destructive', 'destructive/30', 4.5, 'destructive button text, hovered in dark', 'dark'],
  ['input', 'background', 3, 'input and select borders'],
  ['ring', 'background', 3, 'focus indicator'],
  ['primary', 'background', 3, 'primary button and checked control fill'],
  ['destructive', 'background', 3, 'invalid field border'],
  ['sidebar-foreground', 'sidebar', 4.5, 'app nav text'],
  ['sidebar-primary-foreground', 'sidebar-primary', 4.5, 'active nav item text'],
  ['sidebar-accent-foreground', 'sidebar-accent', 4.5, 'hovered nav item text'],
  ['sidebar-primary', 'sidebar', 3, 'active nav item against the nav'],
  ['ring', 'sidebar', 3, 'focus indicator in the nav'],
]

// `--x: light-dark(<light>, <dark>)` gives each theme its value; a plain value serves both. A
// `.dark { --x: … }` block (shadcn's layout) is read too, so either layout can be checked.
export function parseTokens(css) {
  const block = (selector) => {
    const m = css.match(new RegExp(`(^|\\n)\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`))
    return Object.fromEntries(
      [...(m?.[2] ?? '').matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [
        k,
        v.trim(),
      ]),
    )
  }
  const root = block(':root')
  if (!Object.keys(root).length) throw new Error('no :root custom properties')
  const light = {}
  const dark = {}
  for (const [k, v] of Object.entries(root)) {
    const m = v.match(/^light-dark\((.*)\)$/)
    if (!m) {
      light[k] = dark[k] = v
      continue
    }
    let depth = 0
    const comma = [...m[1]].findIndex(
      (c) => (depth += c === '(' ? 1 : c === ')' ? -1 : 0) === 0 && c === ',',
    )
    if (comma < 0) throw new Error(`--${k}: light-dark() needs two values`)
    light[k] = m[1].slice(0, comma).trim()
    dark[k] = m[1].slice(comma + 1).trim()
  }
  return { light, dark: { ...dark, ...block('.dark') } }
}

// oklch(L C H [/ A]) → [r, g, b, a], channels gamma-encoded sRGB in 0..1, clipped to the gamut.
export function oklchToSrgb(value) {
  const m = value.match(
    /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/,
  )
  if (!m) throw new Error(`not an oklch() colour: ${value}`)
  const L = Number(m[1]) / (m[2] ? 100 : 1)
  const C = Number(m[3])
  const h = (Number(m[4]) * Math.PI) / 180
  const alpha = m[5] === undefined ? 1 : Number(m[5]) / (m[6] ? 100 : 1)
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const lin = [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ]
  const encode = (x) => {
    const c = Math.min(1, Math.max(0, x))
    return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055
  }
  return [...lin.map(encode), alpha]
}

const over = ([r, g, b, a], [br, bg, bb]) => [
  a * r + (1 - a) * br,
  a * g + (1 - a) * bg,
  a * b + (1 - a) * bb,
  1,
]

const luminance = ([r, g, b]) => {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export const ratio = (x, y) => {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p)
  return (hi + 0.05) / (lo + 0.05)
}

/** Every pair in both themes: { theme, fg, bg, min, what, ratio, ok }. */
export function check(css) {
  const themes = parseTokens(css)
  const results = []
  for (const [theme, tokens] of Object.entries(themes)) {
    const page = oklchToSrgb(tokens.background)
    const colour = (spec, base) => {
      const [name, pct] = spec.split('/')
      const value = tokens[name]
      if (!value) throw new Error(`--${name} is not defined (${theme})`)
      let c = oklchToSrgb(value)
      if (pct) c = [c[0], c[1], c[2], c[3] * (Number(pct) / 100)]
      return over(c, base)
    }
    for (const [fg, bg, min, what, only] of PAIRS) {
      if (only && only !== theme) continue
      const back = colour(bg, page)
      const r = ratio(colour(fg, back), back)
      results.push({ theme, fg, bg, min, what, ratio: Math.round(r * 100) / 100, ok: r >= min })
    }
  }
  return results
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2] ?? new URL('../packages/brand/brand.css', import.meta.url).pathname
  const results = check(readFileSync(file, 'utf8'))
  for (const r of results)
    console.log(
      `${r.ok ? 'ok  ' : 'FAIL'} ${r.theme.padEnd(5)} ${r.ratio.toFixed(2).padStart(5)} ≥ ${r.min}  ${r.fg} on ${r.bg} (${r.what})`,
    )
  process.exitCode = results.every((r) => r.ok) ? 0 : 1
}
