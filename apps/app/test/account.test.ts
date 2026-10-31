import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { withDb } from '../src/server/db'
import { authFor } from '../src/server/auth'
import { getViewer } from '../src/modules/organizations/service'
import { authPost, createOrg, PASSWORD, randomIp, signUp, type TestUser } from './helpers'

// The account page (apps/app/src/routes/account.tsx) and the organization menu call these: Better
// Auth's own endpoints through the HTTP handler, and getViewer.
const NEW_PASSWORD = 'another-correct-horse-battery'

const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')

const sessionUser = async (cookie: string) => {
  const res = await withDb((db) =>
    authFor(db).handler(
      new Request(`${env.BETTER_AUTH_URL}/api/auth/get-session`, { headers: { cookie } }),
    ),
  )
  return ((await res.json()) as { user: { name: string } } | null)?.user ?? null
}

describe('changing the password while signed in', () => {
  it('keeps this session, ends the others and only the new password signs in', async () => {
    const user = await signUp()
    const other = await authPost('/sign-in/email', { email: user.email, password: PASSWORD })
    expect(other.status).toBe(200)
    const otherCookie = cookieOf(other)
    expect(await sessionUser(otherCookie)).not.toBeNull()

    const res = await authPost(
      '/change-password',
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true },
      randomIp(),
      user,
    )
    expect(res.status).toBe(200)

    expect(await sessionUser(otherCookie)).toBeNull()
    expect(await sessionUser(user.headers.get('cookie')!)).toBeNull()
    expect(await sessionUser(cookieOf(res))).not.toBeNull()
    const signIn = (password: string) => authPost('/sign-in/email', { email: user.email, password })
    expect((await signIn(PASSWORD)).status).toBe(401)
    expect((await signIn(NEW_PASSWORD)).status).toBe(200)
  })

  it('refuses a wrong current password and changes nothing', async () => {
    const user = await signUp()
    const res = await authPost(
      '/change-password',
      { currentPassword: 'wrong-password-123', newPassword: NEW_PASSWORD },
      randomIp(),
      user,
    )
    expect(res.status).toBe(400)
    expect(await sessionUser(user.headers.get('cookie')!)).not.toBeNull()
    const signIn = await authPost('/sign-in/email', { email: user.email, password: PASSWORD })
    expect(signIn.status).toBe(200)
  })

  it('refuses a new password shorter than 8 characters', async () => {
    const user = await signUp()
    const res = await authPost(
      '/change-password',
      { currentPassword: PASSWORD, newPassword: 'short' },
      randomIp(),
      user,
    )
    expect(res.status).toBe(400)
  })

  it('refuses a request without a session', async () => {
    const res = await authPost('/change-password', {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    })
    expect(res.status).toBe(401)
  })

  it('limits guesses at the current password from one client (ADR-0005)', async () => {
    const user = await signUp()
    const ip = randomIp()
    const attempt = () =>
      authPost(
        '/change-password',
        { currentPassword: 'wrong-password-123', newPassword: NEW_PASSWORD },
        ip,
        user,
      )
    const statuses = []
    for (let i = 0; i < 4; i++) statuses.push((await attempt()).status)
    expect(statuses).toEqual([400, 400, 400, 429])
  })
})

describe('changing the name while signed in', () => {
  it('changes it for this user only', async () => {
    const user = await signUp()
    const bystander = await signUp()
    const before = await getViewer(bystander.headers)
    const res = await authPost('/update-user', { name: 'New Name' }, randomIp(), user)
    expect(res.status).toBe(200)
    await expect(getViewer(user.headers)).resolves.toMatchObject({ name: 'New Name' })
    await expect(getViewer(bystander.headers)).resolves.toEqual(before)
  })

  it('refuses an email change through the same endpoint', async () => {
    const user = await signUp()
    const res = await authPost(
      '/update-user',
      { email: `other-${crypto.randomUUID()}@test.local` },
      randomIp(),
      user,
    )
    expect(res.status).toBe(400)
    await expect(getViewer(user.headers)).resolves.toMatchObject({ email: user.email })
  })

  it('never changes the email, even when an empty one comes with a new name', async () => {
    // Better Auth refuses only a non-empty email; an empty one is ignored and the name still saves.
    const user = await signUp()
    const res = await authPost('/update-user', { name: 'Changed', email: '' }, randomIp(), user)
    expect(res.status).toBe(200)
    await expect(getViewer(user.headers)).resolves.toMatchObject({
      name: 'Changed',
      email: user.email,
    })
  })

  it('refuses a request without a session', async () => {
    expect((await authPost('/update-user', { name: 'Nobody' })).status).toBe(401)
  })
})

describe('the organizations a user can switch to', () => {
  it('are their own, not another user’s', async () => {
    const alice = await signUp()
    const bob = await signUp()
    const a1 = await createOrg(alice, 'a')
    const a2 = await createOrg(alice, 'a')
    const b1 = await createOrg(bob, 'b')
    const slugs = async (u: TestUser) =>
      (await getViewer(u.headers))!.organizations.map((o) => o.slug).sort()
    expect(await slugs(alice)).toEqual([a1, a2].sort())
    expect(await slugs(bob)).toEqual([b1])
  })

  it('are nobody’s without a session', async () => {
    await expect(getViewer(new Headers())).resolves.toBeNull()
  })
})
