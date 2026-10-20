import { createDb, findOrganizationBySlug, type Db } from '@saas-foundation/db'
import { rawDb } from '@saas-foundation/db/internal'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createProject } from '../src/modules/projects/service'
import { authFor } from '../src/server/auth'
import { withDb } from '../src/server/db'
import { authPost, createOrg, joinAs, PASSWORD, randomIp, signUp, type TestUser } from './helpers'

// ADR-0039: owner-owned triggers copy deleted rows into `archive.deleted_row` and record
// access-granting auth writes in `archive.auth_event`, attributed to the database login
// (`session_user`). The runtime role can't reach either (database-role.test.ts).

// The local owner (docker-compose's known credentials, as in global-setup.ts); test-only.
const OWNER_URL = 'postgres://app:app@localhost:5432/app_test'

type Row = Record<string, unknown>
type Query = (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>
const clientOf = (db: Db) => (rawDb(db) as unknown as { $client: { query: Query } }).$client

async function asOwner(sql: string, params: unknown[] = []) {
  const { db, close } = await createDb(OWNER_URL)
  try {
    return (await clientOf(db).query(sql, params)).rows
  } finally {
    await close()
  }
}

/** Statements on one connection as the runtime role (the DB binding), like the app or a leaked credential. */
const asRuntime = <T>(fn: (q: Query) => Promise<T>) =>
  withDb((db) => {
    const c = clientOf(db)
    return fn(c.query.bind(c) as Query)
  })

const sha256 = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

const archived = (orgId: string) =>
  asOwner(
    `SELECT table_name, db_user, txid::text, row_data FROM archive.deleted_row
      WHERE organization_id = $1 ORDER BY id`,
    [orgId],
  )

const eventsOf = (userId: string) =>
  asOwner(
    `SELECT event, db_user, user_id, previous_user_id, organization_id, detail FROM archive.auth_event
      WHERE user_id = $1 OR previous_user_id = $1 ORDER BY id`,
    [userId],
  )

const sessionToken = async (user: TestUser) =>
  (
    await asOwner(`SELECT token FROM session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [
      user.userId,
    ])
  )[0]!.token as string

/** The user a session cookie signs in as, through Better Auth's real handler. */
const sessionUserId = async (user: TestUser) => {
  const res = await withDb((db) =>
    authFor(db).handler(
      new Request(`${env.BETTER_AUTH_URL}/api/auth/get-session`, { headers: user.headers }),
    ),
  )
  return ((await res.json()) as { user?: { id: string } } | null)?.user?.id ?? null
}

async function orgWithProjects() {
  const owner = await signUp()
  const slug = await createOrg(owner, 'arc')
  for (const name of ['one', 'two'])
    await createProject(owner.headers, { tenant: slug, project: { name } })
  const orgId = (await withDb((db) => findOrganizationBySlug(db, slug)))!.id
  return { owner, slug, orgId }
}

describe('the archive triggers in the catalog', () => {
  it('every table with tenant data, plus user and account, archives its deletes with an enabled trigger', async () => {
    const tenantTables = await asOwner(
      `SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
          AND a.attname = 'organization_id' AND NOT a.attisdropped`,
    )
    const required = [
      ...tenantTables.map((t) => t.relname as string),
      'organization',
      'user',
      'account',
    ]
    const triggers = await asOwner(
      `SELECT c.relname, t.tgenabled, p.proname FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE c.relnamespace = 'public'::regnamespace AND t.tgname = 'archive_delete'`,
    )
    const byTable = Object.fromEntries(triggers.map((t) => [t.relname, t]))
    for (const table of required)
      expect(byTable[table], `archive_delete on ${table}`).toMatchObject({
        tgenabled: 'O',
        proname: 'capture_delete',
      })
  })

  it('has exactly the reviewed archive and audit triggers, all enabled', async () => {
    const rows = await asOwner(
      `SELECT c.relname || '.' || t.tgname AS trigger, t.tgenabled FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE NOT t.tgisinternal AND p.pronamespace = 'archive'::regnamespace ORDER BY 1`,
    )
    expect(rows.every((r) => r.tgenabled === 'O')).toBe(true)
    expect(rows.map((r) => r.trigger)).toEqual(
      [
        'account.archive_delete',
        'account.audit_insert',
        'account.audit_update',
        'billing_subscription.archive_delete',
        'invitation.archive_delete',
        'member.archive_delete',
        'member.audit_insert',
        'member.audit_update',
        'organization.archive_delete',
        'project.archive_delete',
        'session.audit_delete',
        'session.audit_insert',
        'session.audit_update',
        'user.archive_delete',
        'user.audit_update',
        'verification.audit_insert',
        'verification.audit_update',
      ].sort(),
    )
  })

  it('runs its functions as their owner with a pinned search_path, executable by nobody else', async () => {
    const rows = await asOwner(
      `SELECT proname, prosecdef, proconfig, proowner::regrole::text AS owner,
              has_function_privilege('app_runtime', oid, 'EXECUTE') AS runtime_execute,
              coalesce(array_to_string(proacl, ','), '') AS acl
         FROM pg_proc WHERE pronamespace = 'archive'::regnamespace ORDER BY 1`,
    )
    expect(rows.map((r) => r.proname)).toEqual(['audit_auth', 'capture_delete'])
    for (const r of rows) {
      expect(r).toMatchObject({
        prosecdef: true,
        proconfig: ['search_path=pg_catalog, pg_temp'],
        runtime_execute: false,
      })
      expect(r.owner).not.toBe('app_runtime')
      expect(r.acl).not.toMatch(/(^|,)=/) // no PUBLIC entry
    }
  })
})

describe('deleted rows are archived', () => {
  it('a raw delete as the runtime role is archived with the full rows, attributed to app_runtime', async () => {
    const { orgId } = await orgWithProjects()
    const before = await asOwner(`SELECT * FROM project WHERE organization_id = $1 ORDER BY id`, [
      orgId,
    ])
    await asRuntime((q) => q('DELETE FROM project WHERE organization_id = $1', [orgId]))
    const rows = await archived(orgId)
    expect(rows.map((r) => [r.table_name, r.db_user])).toEqual([
      ['project', 'app_runtime'],
      ['project', 'app_runtime'],
    ])
    const restored = await asOwner(
      `SELECT r.* FROM archive.deleted_row a, jsonb_populate_record(NULL::public.project, a.row_data) r
        WHERE a.organization_id = $1 AND a.table_name = 'project' ORDER BY r.id`,
      [orgId],
    )
    expect(restored).toEqual(before)
  })

  it('a rolled-back delete leaves nothing in the archive', async () => {
    const { orgId } = await orgWithProjects()
    await asRuntime(async (q) => {
      await q('BEGIN')
      await q('DELETE FROM project WHERE organization_id = $1', [orgId])
      await q('ROLLBACK')
    })
    expect(await archived(orgId)).toEqual([])
  })

  it("a temporary table named like the archive doesn't divert the copy", async () => {
    const { orgId } = await orgWithProjects()
    await asRuntime(async (q) => {
      await q('CREATE TEMP TABLE deleted_row (LIKE project)')
      await q('DELETE FROM project WHERE organization_id = $1', [orgId])
    })
    expect(await archived(orgId)).toHaveLength(2)
  })

  it('an account delete is archived without its password hash or tokens', async () => {
    const user = await signUp()
    // The runtime role has no DELETE on account (ADR-0038); the owner, or a user delete's cascade, does.
    await asOwner('DELETE FROM account WHERE user_id = $1', [user.userId])
    const [row] = await asOwner(
      `SELECT db_user, row_data FROM archive.deleted_row
        WHERE table_name = 'account' AND row_data->>'user_id' = $1`,
      [user.userId],
    )
    expect(row!.db_user).toBe('app')
    expect(row!.row_data).toMatchObject({ user_id: user.userId, provider_id: 'credential' })
    for (const key of ['password', 'access_token', 'refresh_token', 'id_token'])
      expect(row!.row_data).not.toHaveProperty(key)
  })

  it('an organization deleted through the app can be restored from that deletion, without members removed earlier', async () => {
    const { owner, slug, orgId } = await orgWithProjects()
    // An admin removed before the deletion must not regain access on restore.
    const removed = await joinAs(owner, slug, 'admin')
    await asRuntime((q) =>
      q('DELETE FROM member WHERE organization_id = $1 AND user_id = $2', [orgId, removed.userId]),
    )
    const snapshot = () =>
      asOwner(
        `SELECT (SELECT to_jsonb(o) FROM organization o WHERE id = $1) AS org,
                (SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM member m WHERE organization_id = $1) AS members,
                (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM project p WHERE organization_id = $1) AS projects`,
        [orgId],
      )
    const before = await snapshot()
    expect(
      (await authPost('/organization/delete', { organizationId: orgId }, randomIp(), owner)).status,
    ).toBe(200)
    expect(await withDb((db) => findOrganizationBySlug(db, slug))).toBeNull()

    // The runbook's restore ("Database → Archive and audit"): the deletion's txid, one
    // transaction, parents first.
    const [{ txid }] = (await asOwner(
      `SELECT txid::text FROM archive.deleted_row WHERE organization_id = $1 AND table_name = 'organization'`,
      [orgId],
    )) as [{ txid: string }]
    const { db, close } = await createDb(OWNER_URL)
    try {
      const q = clientOf(db)
      await q.query('BEGIN')
      for (const table of [
        'organization',
        'member',
        'invitation',
        'project',
        'billing_subscription',
      ])
        await q.query(
          `INSERT INTO public.${table}
             SELECT r.* FROM archive.deleted_row a, jsonb_populate_record(NULL::public.${table}, a.row_data) r
              WHERE a.txid = $2 AND a.organization_id = $1 AND a.table_name = '${table}'`,
          [orgId, txid],
        )
      await q.query('COMMIT')
    } finally {
      await close()
    }
    expect(await snapshot()).toEqual(before)
  })
})

describe('auth writes are audited', () => {
  it('sign-in and sign-out record the session with a token fingerprint, never the token', async () => {
    const user = await signUp()
    const token = await sessionToken(user)
    const created = await eventsOf(user.userId)
    expect(created.find((e) => e.event === 'session.insert')).toMatchObject({
      db_user: 'app_runtime',
      user_id: user.userId,
      detail: { token_sha256: await sha256(token) },
    })
    expect((await authPost('/sign-out', {}, randomIp(), user)).status).toBe(200)
    const events = await eventsOf(user.userId)
    expect(events.at(-1)).toMatchObject({
      event: 'session.delete',
      user_id: user.userId,
      detail: { token_sha256: await sha256(token) },
    })
    expect(JSON.stringify(events)).not.toContain(token)
  })

  it('routine session refreshes and switching the active organization record nothing', async () => {
    const user = await signUp()
    const slug = await createOrg(user)
    const orgId = (await withDb((db) => findOrganizationBySlug(db, slug)))!.id
    const before = (await eventsOf(user.userId)).length
    expect(
      (await authPost('/organization/set-active', { organizationId: orgId }, randomIp(), user))
        .status,
    ).toBe(200)
    await asRuntime((q) =>
      q(
        `UPDATE session SET expires_at = now() + interval '7 days', updated_at = now(),
                ip_address = '10.0.0.1', user_agent = 'x', active_organization_id = NULL
          WHERE user_id = $1`,
        [user.userId],
      ),
    )
    expect(await eventsOf(user.userId)).toHaveLength(before)
  })

  it('reassigning a session to another user is recorded with both users, and the cookie now signs in as the victim', async () => {
    const [attacker, victim] = [await signUp(), await signUp()]
    await asRuntime((q) =>
      q('UPDATE session SET user_id = $1 WHERE user_id = $2', [victim.userId, attacker.userId]),
    )
    expect(await sessionUserId(attacker)).toBe(victim.userId)
    expect((await eventsOf(victim.userId)).at(-1)).toMatchObject({
      event: 'session.update',
      db_user: 'app_runtime',
      user_id: victim.userId,
      previous_user_id: attacker.userId,
    })
  })

  it('deleting a session and re-inserting its token for another user is recorded as a delete and an insert with the same fingerprint', async () => {
    const [attacker, victim] = [await signUp(), await signUp()]
    const token = await sessionToken(attacker)
    await asRuntime(async (q) => {
      await q('BEGIN')
      await q('DELETE FROM session WHERE token = $1', [token])
      await q(
        `INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at)
           VALUES ($1, $2, $3, now() + interval '1 day', now(), now())`,
        [crypto.randomUUID(), token, victim.userId],
      )
      await q('COMMIT')
    })
    expect(await sessionUserId(attacker)).toBe(victim.userId)
    const fingerprint = await sha256(token)
    expect((await eventsOf(attacker.userId)).at(-1)).toMatchObject({
      event: 'session.delete',
      user_id: attacker.userId,
      detail: { token_sha256: fingerprint },
    })
    expect((await eventsOf(victim.userId)).at(-1)).toMatchObject({
      event: 'session.insert',
      user_id: victim.userId,
      detail: { token_sha256: fingerprint },
    })
  })

  it('a password change, through the app or written directly, is recorded as a flag without the hash', async () => {
    const user = await signUp()
    const signUpEvent = (await eventsOf(user.userId)).find((e) => e.event === 'account.insert')
    expect(signUpEvent).toMatchObject({ detail: { provider_id: 'credential', password_set: true } })

    const res = await authPost(
      '/change-password',
      { currentPassword: PASSWORD, newPassword: 'another-correct-horse-battery' },
      randomIp(),
      user,
    )
    expect(res.status).toBe(200)
    const [{ password: hash }] = (await asOwner(`SELECT password FROM account WHERE user_id = $1`, [
      user.userId,
    ])) as [{ password: string }]
    const injected = `injected-${crypto.randomUUID()}`
    await asRuntime((q) =>
      q(`UPDATE account SET password = $1 WHERE user_id = $2`, [injected, user.userId]),
    )
    const changes = (await eventsOf(user.userId)).filter((e) => e.event === 'account.update')
    expect(changes).toHaveLength(2)
    for (const e of changes)
      expect(e.detail).toMatchObject({ password_set: true, password_changed: true })
    expect(JSON.stringify(changes)).not.toContain(hash)
    expect(JSON.stringify(changes)).not.toContain(injected)
  })

  it('an email change is recorded with the old and new address', async () => {
    const user = await signUp()
    const next = `n-${crypto.randomUUID()}@test.local`
    await asRuntime((q) => q('UPDATE "user" SET email = $1 WHERE id = $2', [next, user.userId]))
    expect((await eventsOf(user.userId)).at(-1)).toMatchObject({
      event: 'user.update',
      detail: { email: next, previous_email: user.email },
    })
  })

  it('membership inserts, role changes and moves to another user or organization are recorded', async () => {
    const owner = await signUp()
    const slug = await createOrg(owner, 'aud')
    const orgId = (await withDb((db) => findOrganizationBySlug(db, slug)))!.id
    expect((await eventsOf(owner.userId)).find((e) => e.event === 'member.insert')).toMatchObject({
      organization_id: orgId,
      detail: { role: 'owner' },
    })

    const admin = await joinAs(owner, slug, 'admin')
    const [{ id: memberId }] = (await asOwner(
      'SELECT id FROM member WHERE organization_id = $1 AND user_id = $2',
      [orgId, admin.userId],
    )) as [{ id: string }]
    expect(
      (
        await authPost(
          '/organization/update-member-role',
          { memberId, role: 'member', organizationId: orgId },
          randomIp(),
          owner,
        )
      ).status,
    ).toBe(200)
    expect((await eventsOf(admin.userId)).at(-1)).toMatchObject({
      event: 'member.update',
      user_id: admin.userId,
      organization_id: orgId,
      detail: { member_id: memberId, role: 'member', previous_role: 'admin' },
    })

    const other = await signUp()
    const otherSlug = await createOrg(owner, 'aud')
    const otherOrgId = (await withDb((db) => findOrganizationBySlug(db, otherSlug)))!.id
    await asRuntime((q) =>
      q('UPDATE member SET user_id = $1 WHERE id = $2', [other.userId, memberId]),
    )
    expect((await eventsOf(other.userId)).at(-1)).toMatchObject({
      event: 'member.update',
      user_id: other.userId,
      previous_user_id: admin.userId,
    })
    await asRuntime((q) =>
      q('UPDATE member SET organization_id = $1 WHERE id = $2', [otherOrgId, memberId]),
    )
    expect((await eventsOf(other.userId)).at(-1)).toMatchObject({
      event: 'member.update',
      organization_id: otherOrgId,
      detail: { previous_organization_id: orgId },
    })
  })

  it('a password-reset request is recorded for the user without its stored identifier', async () => {
    const user = await signUp()
    await authPost('/request-password-reset', { email: user.email, redirectTo: '/reset-password' })
    const [row] = await asOwner(`SELECT id, identifier FROM verification WHERE value = $1`, [
      user.userId,
    ])
    const event = (await eventsOf(user.userId)).find((e) => e.event === 'verification.insert')
    expect(event).toMatchObject({ user_id: user.userId, previous_user_id: null })
    expect(Object.keys(event!.detail as object).sort()).toEqual(['expires_at', 'verification_id'])
    expect((event!.detail as Row).verification_id).toBe(row!.id)
    expect(JSON.stringify(event)).not.toContain(row!.identifier as string)
  })

  it('a verification row written directly with any identifier is recorded for the user it names', async () => {
    const user = await signUp()
    const id = crypto.randomUUID()
    await asRuntime((q) =>
      q(
        `INSERT INTO verification (id, identifier, value, expires_at)
           VALUES ($1, $2, $3, now() + interval '1 hour')`,
        [id, `planted-${crypto.randomUUID()}`, user.userId],
      ),
    )
    expect((await eventsOf(user.userId)).at(-1)).toMatchObject({
      event: 'verification.insert',
      db_user: 'app_runtime',
      user_id: user.userId,
      detail: { verification_id: id },
    })
  })

  it("a verification row whose value isn't a user id is recorded without that value", async () => {
    const id = crypto.randomUUID()
    const secret = `otp-${crypto.randomUUID()}`
    await asRuntime((q) =>
      q(
        `INSERT INTO verification (id, identifier, value, expires_at)
           VALUES ($1, $2, $3, now() + interval '1 hour')`,
        [id, `sign-in-otp-${crypto.randomUUID()}`, secret],
      ),
    )
    const events = await asOwner(
      `SELECT event, user_id, detail FROM archive.auth_event WHERE detail->>'verification_id' = $1`,
      [id],
    )
    expect(events).toMatchObject([{ event: 'verification.insert', user_id: null }])
    expect(JSON.stringify(events)).not.toContain(secret)
  })

  it('reviving an expired verification row or swapping its identifier is recorded', async () => {
    const user = await signUp()
    const id = crypto.randomUUID()
    await asOwner(
      `INSERT INTO verification (id, identifier, value, expires_at)
         VALUES ($1, $2, $3, now() - interval '1 hour')`,
      [id, crypto.randomUUID(), user.userId],
    )
    await asRuntime((q) =>
      q(`UPDATE verification SET expires_at = now() + interval '1 hour' WHERE id = $1`, [id]),
    )
    expect((await eventsOf(user.userId)).at(-1)).toMatchObject({
      event: 'verification.update',
      db_user: 'app_runtime',
      user_id: user.userId,
      previous_user_id: user.userId,
      detail: { verification_id: id, identifier_changed: false, value_changed: false },
    })
    const planted = crypto.randomUUID()
    await asRuntime((q) =>
      q(`UPDATE verification SET identifier = $1 WHERE id = $2`, [planted, id]),
    )
    const event = (await eventsOf(user.userId)).at(-1)
    expect(event).toMatchObject({
      event: 'verification.update',
      detail: { verification_id: id, identifier_changed: true, value_changed: false },
    })
    expect(JSON.stringify(event)).not.toContain(planted)
  })
})
