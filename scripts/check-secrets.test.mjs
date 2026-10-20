// Runs check-secrets.mjs against a fake `wrangler` on PATH that prints a fixture secret list, so
// the --deployed policy is tested without Cloudflare credentials or the production Worker.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const SCRIPT = new URL('./check-secrets.mjs', import.meta.url).pathname
const bin = mkdtempSync(join(tmpdir(), 'check-secrets-'))
after(() => rmSync(bin, { recursive: true, force: true }))

// Answers only `wrangler secret list --format json`, with FAKE_OUT and FAKE_EXIT.
writeFileSync(
  join(bin, 'wrangler'),
  `#!/bin/sh
[ "$*" = "secret list --format json" ] || { echo "unexpected args: $*" >&2; exit 64; }
printf '%s' "$FAKE_OUT"
exit "\${FAKE_EXIT:-0}"
`,
)
chmodSync(join(bin, 'wrangler'), 0o755)

const REQUIRED = [
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'TURNSTILE_SECRET_KEY',
  'TURNSTILE_SITE_KEY',
]

/** Wrangler's JSON output for these secret names, after its banner. */
const listing = (names) =>
  ' ⛅️ wrangler 4\n' + JSON.stringify(names.map((name) => ({ name, type: 'secret_text' })))

function run(args, { out = '', exit = 0 } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_OUT: out,
      FAKE_EXIT: String(exit),
    },
  })
  return { status: r.status, output: r.stdout + r.stderr }
}

test('the deployed check passes with every required secret and no SIGNUP_MODE', () => {
  const r = run(['--deployed'], { out: listing([...REQUIRED, 'SIGNUP_ALLOWLIST']) })
  assert.equal(r.status, 0, r.output)
  assert.match(r.output, /check-secrets: ok/)
})

for (const missing of REQUIRED)
  test(`the deployed check fails when the production Worker has no ${missing}`, () => {
    const r = run(['--deployed'], { out: listing(REQUIRED.filter((n) => n !== missing)) })
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, new RegExp(`has no ${missing} secret`))
    assert.doesNotMatch(r.output, /check-secrets: ok/)
  })

test('the deployed check fails when the production Worker has an EMAIL_VERIFICATION secret', () => {
  const r = run(['--deployed'], { out: listing([...REQUIRED, 'EMAIL_VERIFICATION']) })
  assert.equal(r.status, 1, r.output)
  assert.match(r.output, /has an EMAIL_VERIFICATION secret/)
})

test('a failed secret listing fails the deployed check', () => {
  const r = run(['--deployed'], { out: 'Authentication error', exit: 1 })
  assert.notEqual(r.status, 0, r.output)
  assert.doesNotMatch(r.output, /check-secrets: ok/)
})

test('an unreadable secret listing fails the deployed check', () => {
  const r = run(['--deployed'], { out: 'no JSON here' })
  assert.notEqual(r.status, 0, r.output)
  assert.doesNotMatch(r.output, /check-secrets: ok/)
})

test('without --deployed the check reads only the committed config, never the secret list', () => {
  const r = run([], { exit: 1 })
  assert.equal(r.status, 0, r.output)
  assert.match(r.output, /check-secrets: ok/)
})
