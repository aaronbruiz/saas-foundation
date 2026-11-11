// WCAG contrast of the brand tokens (packages/brand/brand.css), light and dark (ADR-0046).
// Reads the `:root` and `.dark` custom properties (oklch only), converts them to sRGB, composites
// translucent colours over their background the way browsers do (in gamma-encoded sRGB), and
// checks each pair below. Usage: node scripts/brand-contrast.mjs [css file]; the test imports it.
import { readFileSync } from 'node:fs'

// [foreground, background, minimum ratio, what it is, theme (both when absent)]. A token may carry an alpha
// (`destructive/10`), composited over the pair's background, or, when it is the background itself,
// over the surface after `@` (`primary/90@card`), `background` when there is none. Text needs 4.5:1 (WCAG 1.4.3); input borders, focus indicators and control
// fills 3:1 (1.4.11). Disabled controls are exempt; decorative borders (`--border`) aren't listed.
// `a+5%b` is `color-mix(in oklch, var(--a), var(--b) 5%)` (the secondary button's hover). Focus
// indicators drawn in a token's opaque colour are covered by its text pairs (4.5:1 ≥ 3:1).
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
  ['destructive', 'destructive/25', 4.5, 'destructive button text, hovered in dark', 'dark'],
  ['destructive', 'destructive/10@card', 4.5, 'destructive button text on its tint, in a card'],
  ['destructive', 'destructive/20@card', 4.5, 'destructive button text, hovered, in a card'],
  [
    'destructive',
    'destructive/25@card',
    4.5,
    'destructive button text, hovered in dark, in a card',
    'dark',
  ],
  ['primary-foreground', 'primary/90', 4.5, 'primary button and linked badge text, hovered'],
  ['primary-foreground', 'primary/90@card', 4.5, 'primary button text, hovered, in a card'],
  ['secondary-foreground', 'secondary/80', 4.5, 'linked secondary badge text, hovered'],
  [
    'secondary-foreground',
    'secondary/80@card',
    4.5,
    'linked secondary badge text, hovered, in a card',
  ],
  ['foreground', 'muted', 4.5, 'outline and ghost button text, hovered'],
  ['foreground', 'muted@card', 4.5, 'outline and ghost button text, hovered, in a card'],
  [
    'foreground',
    'muted/50@card',
    4.5,
    'ghost button and table row text, hovered in dark, in a card',
  ],
  ['foreground', 'input/30@card', 4.5, 'outline button and field text in dark, in a card', 'dark'],
  ['foreground', 'input/40', 4.5, 'outline button and field text, hovered in dark', 'dark'],
  [
    'foreground',
    'input/40@card',
    4.5,
    'outline button and field text, hovered in dark, in a card',
    'dark',
  ],
  [
    'muted-foreground',
    'muted@card',
    4.5,
    'ghost and linked outline badge text, hovered, in a card',
  ],
  ['muted-foreground', 'input/30', 4.5, 'field placeholder in dark', 'dark'],
  ['muted-foreground', 'input/30@card', 4.5, 'field placeholder in dark, in a card', 'dark'],
  ['muted-foreground', 'input/40', 4.5, 'select placeholder, hovered in dark', 'dark'],
  [
    'muted-foreground',
    'input/40@card',
    4.5,
    'select placeholder, hovered in dark, in a card',
    'dark',
  ],
  ['secondary-foreground', 'secondary+5%foreground', 4.5, 'secondary button text, hovered'],
  [
    'secondary-foreground',
    'secondary+5%foreground@card',
    4.5,
    'secondary button text, hovered, in a card',
  ],
  ['destructive', 'destructive/10', 3, 'destructive button focus border against its tint'],
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

// oklch(L C H [/ A]) → [L, C, H in degrees, alpha].
function parseOklch(value) {
  const m = value.match(
    /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/,
  )
  if (!m) throw new Error(`not an oklch() colour: ${value}`)
  return [
    Number(m[1]) / (m[2] ? 100 : 1),
    Number(m[3]),
    Number(m[4]),
    m[5] === undefined ? 1 : Number(m[5]) / (m[6] ? 100 : 1),
  ]
}

// color-mix(in oklch, x, y p%): each channel interpolated, the hue along the shorter arc (CSS Color 4).
function mixOklch(x, y, p) {
  const [a, b] = [parseOklch(x), parseOklch(y)]
  let dh = b[2] - a[2]
  if (dh > 180) dh -= 360
  if (dh < -180) dh += 360
  const at = (i) => a[i] + (b[i] - a[i]) * p
  return `oklch(${at(0)} ${at(1)} ${(a[2] + dh * p + 360) % 360} / ${at(3)})`
}

// oklch(L C H [/ A]) → [r, g, b, a], channels gamma-encoded sRGB in 0..1, clipped to the gamut.
export function oklchToSrgb(value) {
  const [L, C, H, alpha] = parseOklch(value)
  const h = (H * Math.PI) / 180
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
      const [own, surface] = spec.split('@')
      if (surface) base = colour(surface, page)
      const [mixed, pct] = own.split('/')
      const token = (name) => {
        if (!tokens[name]) throw new Error(`--${name} is not defined (${theme})`)
        return tokens[name]
      }
      const mix = mixed.match(/^([a-z-]+)\+(\d+)%([a-z-]+)$/)
      const value = mix
        ? mixOklch(token(mix[1]), token(mix[3]), Number(mix[2]) / 100)
        : token(mixed)
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
