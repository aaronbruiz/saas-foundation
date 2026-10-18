// Runs dump.sh end to end with the real AWS CLI and the pinned client image, against a disposable
// Postgres container holding synthetic rows and a local S3-compatible endpoint (this file's server).
// Nothing reaches Neon, R2 or Healthchecks; every credential below is a dummy.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'

const SCRIPT = new URL('./dump.sh', import.meta.url).pathname
const PG_IMAGE = readFileSync(SCRIPT, 'utf8').match(/^PG_IMAGE=(\S+)$/m)[1]
// The CI service image (ci.yml).
const SERVER_IMAGE =
  'postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24'
const BUCKET = 'test-bucket'
const DB_PASSWORD = `dummy-db-pw-${randomBytes(6).toString('hex')}`
const KEY_ID = `DUMMYKEYID${randomBytes(4).toString('hex')}`
const SECRET = `dummy-secret-${randomBytes(8).toString('hex')}`
const CONTAINER = `dump-test-${process.pid}-${randomBytes(3).toString('hex')}`

const dir = mkdtempSync(join(tmpdir(), 'dump-test-'))
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
const psql = (db, sql) => docker('exec', CONTAINER, 'psql', '-U', 'postgres', '-d', db, '-Atc', sql)
const clientContainers = () => docker('ps', '-aq', '--filter', `ancestor=${PG_IMAGE}`)
const day = () => new Date().toISOString().slice(0, 10).replaceAll('-', '')
const keyOf = () => `daily/app-${day()}.dump`
const COUNTS = `select table_schema||'.'||table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::int from information_schema.tables where table_schema in ('public','drizzle') and table_type='BASE TABLE' order by 1`

// --- a minimal S3 endpoint: path-style PUT/HEAD, with injectable failures ---
const store = new Map()
let requests = []
let faults = {} // "METHOD key" → HTTP status; "SIZE key" → Content-Length to report
const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const key = path.slice(`/${BUCKET}/`.length)
    requests.push(`${req.method} ${key}`)
    const status = faults[`${req.method} ${key}`]
    if (status) {
      res.writeHead(status, { 'content-type': 'application/xml' })
      return res.end(req.method === 'HEAD' ? undefined : '<Error><Code>AccessDenied</Code></Error>')
    }
    if (req.method === 'PUT') {
      const body = Buffer.concat(chunks)
      store.set(key, body)
      res.writeHead(200, { ETag: `"${createHash('md5').update(body).digest('hex')}"` })
      return res.end()
    }
    if (req.method === 'HEAD' && store.has(key)) {
      const length = faults[`SIZE ${key}`] ?? store.get(key).length
      res.writeHead(200, { 'Content-Length': length, ETag: '"x"' })
      return res.end()
    }
    res.writeHead(404)
    res.end()
  })
})
let endpoint
let databaseUrl

before(async () => {
  for (const image of [PG_IMAGE, SERVER_IMAGE]) docker('pull', '-q', image)
  docker(
    'run',
    '-d',
    '--rm',
    '--name',
    CONTAINER,
    '-e',
    `POSTGRES_PASSWORD=${DB_PASSWORD}`,
    '-p',
    '127.0.0.1::5432',
    SERVER_IMAGE,
  )
  for (let i = 0; ; i++) {
    try {
      // pg_isready passes during the init phase's temporary server; a query through TCP doesn't.
      docker('exec', CONTAINER, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-Atc', 'select 1')
      break
    } catch (e) {
      if (i >= 60) throw e
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  const port = docker('port', CONTAINER, '5432/tcp').split('\n')[0].split(':').pop()
  databaseUrl = `postgres://postgres:${DB_PASSWORD}@127.0.0.1:${port}/app?sslmode=disable`
  psql('postgres', 'create database app')
  psql(
    'app',
    `create schema drizzle;
     create table drizzle.__drizzle_migrations (id serial primary key, hash text);
     create table organization (id text primary key, name text);
     create table "user" (id text primary key, email text);
     create table member (id text primary key, organization_id text references organization, user_id text references "user");
     insert into drizzle.__drizzle_migrations (hash) select 'm' || g from generate_series(1, 5) g;
     insert into organization select 'org-' || g, 'Synthetic ' || g from generate_series(1, 3) g;
     insert into "user" select 'user-' || g, 'user' || g || '@example.test' from generate_series(1, 4) g;
     insert into member select 'mem-' || g, 'org-' || (1 + g % 3), 'user-' || g from generate_series(1, 4) g;`,
  )
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  endpoint = `http://127.0.0.1:${server.address().port}`
})

after(() => {
  server.close()
  spawnSync('docker', ['rm', '-f', CONTAINER])
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  store.clear()
  requests = []
  faults = {}
})

/**
 * Runs dump.sh with only the given environment (no inherited AWS_*, HOME or PG* variables).
 * `aws` is the synthetic AWS config file's content, or null for no config file at all.
 */
function run({ aws = null, env = {}, timeout = null } = {}) {
  const home = mkdtempSync(join(dir, 'home-'))
  const tmp = mkdtempSync(join(dir, 'tmp-'))
  const out = join(home, 'github-output')
  writeFileSync(out, '')
  if (aws !== null) writeFileSync(join(home, 'aws-config'), aws)
  const fullEnv = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: tmp,
    ...(process.env.DOCKER_HOST && { DOCKER_HOST: process.env.DOCKER_HOST }),
    AWS_CONFIG_FILE: join(home, 'aws-config'),
    AWS_SHARED_CREDENTIALS_FILE: join(home, 'aws-credentials'),
    AWS_MAX_ATTEMPTS: '1',
    DATABASE_URL: databaseUrl,
    R2_BACKUP_ENDPOINT: endpoint,
    R2_BACKUP_BUCKET: BUCKET,
    AWS_ACCESS_KEY_ID: KEY_ID,
    AWS_SECRET_ACCESS_KEY: SECRET,
    GITHUB_OUTPUT: out,
    ...env,
  }
  const [cmd, args] = timeout
    ? ['timeout', ['-s', 'TERM', String(timeout), 'bash', SCRIPT]]
    : ['bash', [SCRIPT]]
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: fullEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    child.on('close', (status) =>
      resolve({
        status,
        output,
        uploaded: readFileSync(out, 'utf8').includes('uploaded=true'),
        tmp,
      }),
    )
  }).then((r) => {
    // No dummy credential, connection URL or endpoint may appear in what the run printed. The
    // Actions mask command is the exception: the runner hides the value and never prints that line.
    const printed = r.output.replace(/^::add-mask::.*$/gm, '')
    for (const secret of [DB_PASSWORD, KEY_ID, SECRET, databaseUrl, endpoint])
      assert.ok(!printed.includes(secret), `output exposes ${secret}:\n${r.output}`)
    return r
  })
}

const puts = () => requests.filter((r) => r.startsWith('PUT '))

/** The run uploaded today's dump, then its checksum, and reported a new copy. */
function assertUploaded(r) {
  assert.equal(r.status, 0, r.output)
  const key = keyOf()
  assert.deepEqual(puts(), [`PUT ${key}`, `PUT ${key}.sha256`])
  const sha = createHash('sha256').update(store.get(key)).digest('hex')
  assert.equal(store.get(`${key}.sha256`).toString(), `${sha}  app-${day()}.dump\n`)
  // The creation checksum is in the log too, so a run's record doesn't depend on the stored copy.
  assert.match(r.output, new RegExp(`dump ok: .*, sha256 ${sha}\n`))
  assert.ok(r.uploaded, 'uploaded=true missing')
}

/** The run failed without completing the day or reporting a new copy. */
function assertFailedWithoutSuccess(r) {
  assert.notEqual(r.status, 0, r.output)
  assert.ok(!store.has(`${keyOf()}.sha256`), `day marked complete: ${puts()}`)
  assert.ok(!r.uploaded, 'reported a new copy')
}

test("an invalid output setting in the operator's AWS config doesn't break the upload", async () => {
  const r = await run({ aws: '[default]\noutput = no\ncli_pager = less\ncli_auto_prompt = on\n' })
  assertUploaded(r)
})

test('the uploaded dump restores into a fresh database with the same row counts', async () => {
  const r = await run()
  assertUploaded(r)
  psql('postgres', 'create database restored')
  try {
    execFileSync(
      'docker',
      [
        'exec',
        '-i',
        CONTAINER,
        'pg_restore',
        '-U',
        'postgres',
        '--no-owner',
        '--no-acl',
        '--exit-on-error',
        '-d',
        'restored',
      ],
      { input: store.get(keyOf()) },
    )
    assert.equal(psql('restored', COUNTS), psql('app', COUNTS))
  } finally {
    psql('postgres', 'drop database restored')
  }
})

test('CI-style explicit credentials with no AWS config file still upload', async () => {
  const r = await run({ env: { GITHUB_ACTIONS: 'true', NEON_API_KEY: 'dummy-neon-key' } })
  assertUploaded(r)
})

test('a named AWS profile with its own invalid output setting still works with env credentials', async () => {
  const r = await run({
    aws: '[default]\noutput = no\n[profile backup]\noutput = no\nregion = us-east-1\n',
    env: { AWS_PROFILE: 'backup' },
  })
  assertUploaded(r)
})

test('an AWS_PROFILE naming a missing profile fails before any upload', async () => {
  const r = await run({ env: { AWS_PROFILE: 'missing' } })
  assertFailedWithoutSuccess(r)
  assert.deepEqual(puts(), [])
})

test('a failed pg_dump fails the run and uploads nothing', async () => {
  const r = await run({ env: { DATABASE_URL: databaseUrl.replace(DB_PASSWORD, 'wrong-password') } })
  assertFailedWithoutSuccess(r)
  assert.deepEqual(puts(), [])
})

test('a rejected dump upload fails the run without the checksum or a success report', async () => {
  faults[`PUT ${keyOf()}`] = 403
  assertFailedWithoutSuccess(await run())
})

test('a stored size that differs from the dump fails the run without the checksum', async () => {
  faults[`SIZE ${keyOf()}`] = 1
  assertFailedWithoutSuccess(await run())
})

test('a rejected checksum upload fails the run without a success report', async () => {
  faults[`PUT ${keyOf()}.sha256`] = 403
  assertFailedWithoutSuccess(await run())
})

test('a day whose checksum already exists is left alone and reports no new copy', async () => {
  store.set(`${keyOf()}.sha256`, Buffer.from('existing'))
  const r = await run()
  assert.equal(r.status, 0, r.output)
  assert.match(r.output, /already complete/)
  assert.deepEqual(puts(), [])
  assert.ok(!r.uploaded)
})

test('a failed lookup of the checksum key is not treated as a missing key', async () => {
  faults[`HEAD ${keyOf()}.sha256`] = 403
  const r = await run()
  assertFailedWithoutSuccess(r)
  assert.deepEqual(puts(), [])
  assert.match(r.output, /can't check/)
})

test('an unreachable endpoint is not treated as a missing key', async () => {
  const r = await run({ env: { R2_BACKUP_ENDPOINT: 'http://127.0.0.1:9' } })
  assertFailedWithoutSuccess(r)
  assert.ok(!r.output.includes('127.0.0.1:9'), r.output)
})

test('a dump without its checksum (an interrupted day) is redone', async () => {
  store.set(keyOf(), Buffer.from('partial'))
  assertUploaded(await run())
})

test('a timed-out run removes its client container, connection and temporary files', async () => {
  const before = clientContainers()
  // Hold a lock pg_dump has to wait for, so the run is mid-dump when the timeout hits.
  docker(
    'exec',
    '-d',
    CONTAINER,
    'psql',
    '-U',
    'postgres',
    '-d',
    'app',
    '-c',
    'begin; lock table organization in access exclusive mode; select pg_sleep(300);',
  )
  try {
    for (
      let i = 0;
      psql(
        'app',
        "select count(*) from pg_locks where mode = 'AccessExclusiveLock' and relation = 'organization'::regclass",
      ) !== '1';
      i++
    ) {
      assert.ok(i < 30, 'lock not taken')
      await new Promise((r) => setTimeout(r, 200))
    }
    const r = await run({ timeout: 20 })
    assert.equal(r.status, 124, r.output)
    assert.match(r.output, /dumping main/)
    assert.deepEqual(puts(), [])
    assert.ok(!r.uploaded)
    assert.deepEqual(readdirSync(r.tmp), [], 'temporary files left behind')
    let left
    for (let i = 0; i < 20; i++) {
      left = psql('app', "select count(*) from pg_stat_activity where application_name = 'pg_dump'")
      if (left === '0' && clientContainers() === before) break
      await new Promise((r) => setTimeout(r, 500))
    }
    assert.equal(left, '0', 'pg_dump still connected')
    assert.equal(clientContainers(), before, 'client container left running')
  } finally {
    psql(
      'app',
      "select pg_terminate_backend(pid) from pg_stat_activity where query like '%pg_sleep(300)%' and pid <> pg_backend_pid()",
    )
  }
})
