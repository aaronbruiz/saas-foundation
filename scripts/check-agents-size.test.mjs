// Runs check-agents-size.mjs against temporary files at, and just over, the budget.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const SCRIPT = new URL('./check-agents-size.mjs', import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'check-agents-size-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const run = (bytes) => {
  const file = join(dir, `AGENTS-${bytes}.md`)
  writeFileSync(file, 'x'.repeat(bytes))
  return spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' })
}

test('an AGENTS.md within the budget passes', () => {
  assert.equal(run(28_000).status, 0)
})

test('an AGENTS.md over the budget fails, naming the Codex limit', () => {
  const r = run(28_001)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /28,?001 bytes/)
  assert.match(r.stderr, /32 KiB/)
})

test("the repository's AGENTS.md is within the budget", () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 0)
})
