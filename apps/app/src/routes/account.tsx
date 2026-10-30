import { createFileRoute, Link, redirect, useRouter } from '@tanstack/react-router'
import { useRef, useState, type FormEvent } from 'react'
import { authClient } from '../lib/auth-client'
import { getViewerFn } from '../modules/organizations/functions'
import { ErrorText, Field, buttonClass, inputClass, messageOf, useHydrated } from '../lib/ui'

// The signed-in user's own account: Better Auth's endpoints through the HTTP client, which rate
// limit password guesses (ADR-0005). Email changes aren't offered (they touch verification, ADR-0016).
export const Route = createFileRoute('/account')({
  loader: async () => {
    const viewer = await getViewerFn()
    if (!viewer) throw redirect({ to: '/login', search: { redirect: '/account' } })
    return viewer
  },
  component: Account,
})

function Account() {
  const viewer = Route.useLoaderData()
  return (
    <main className="mx-auto max-w-sm space-y-10 p-8">
      <section>
        <h1 className="mb-6 text-2xl font-semibold">Account</h1>
        <p className="mb-4 text-sm text-gray-600">Signed in as {viewer.email}</p>
        <NameForm name={viewer.name} />
      </section>
      <section>
        <h2 className="mb-4 text-lg font-semibold">Password</h2>
        <PasswordForm />
      </section>
      <section>
        <h2 className="mb-4 text-lg font-semibold">Organizations</h2>
        <ul className="space-y-2 text-sm">
          {viewer.organizations.map((o) => (
            <li key={o.slug}>
              <Link to="/t/$tenant/projects" params={{ tenant: o.slug }} className="underline">
                {o.name}
              </Link>
            </li>
          ))}
          <li>
            <Link to="/orgs/new" className="underline">
              New organization
            </Link>
          </li>
        </ul>
      </section>
    </main>
  )
}

function NameForm({ name }: { name: string }) {
  const hydrated = useHydrated()
  const router = useRouter()
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (pending.current) return
    setSaved(false)
    const next = String(new FormData(e.currentTarget).get('name')).trim()
    if (!next) return setError('Enter a name.')
    setError(null)
    pending.current = true
    setBusy(true)
    try {
      const { error } = await authClient.updateUser({ name: next })
      if (error) return setError(error.message ?? "Your name couldn't be saved.")
      setSaved(true)
      await router.invalidate()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <form method="post" onSubmit={onSubmit} className="space-y-4">
      <Field label="Name">
        <input name="name" required defaultValue={name} className={inputClass} />
      </Field>
      <ErrorText error={error} />
      {saved && (
        <p role="status" className="text-sm">
          Name saved.
        </p>
      )}
      <button type="submit" disabled={!hydrated || busy} className={buttonClass}>
        Save name
      </button>
    </form>
  )
}

function PasswordForm() {
  const hydrated = useHydrated()
  const [changed, setChanged] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Set before the first await: the disabled button only renders after a submit that's already in.
  const pending = useRef(false)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (pending.current) return
    pending.current = true
    const formEl = e.currentTarget
    const form = new FormData(formEl)
    setChanged(false)
    setError(null)
    setBusy(true)
    // Other sessions end, as after a password reset: a change is often the answer to a suspected
    // compromise. This session continues on the new token Better Auth sets. Better Auth checks the
    // current password outside its write, so overlapping changes can both report success while only
    // the last password written works. `pending` stops this page's duplicates, not requests from
    // other tabs or clients (owner accepted 2026-10-30; roadmap M5).
    try {
      const { error } = await authClient.changePassword({
        currentPassword: String(form.get('currentPassword')),
        newPassword: String(form.get('newPassword')),
        revokeOtherSessions: true,
      })
      if (error) return setError(error.message ?? "Your password couldn't be changed.")
      formEl.reset()
      setChanged(true)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <form method="post" onSubmit={onSubmit} className="space-y-4">
      <Field label="Current password">
        <input
          name="currentPassword"
          type="password"
          required
          autoComplete="current-password"
          className={inputClass}
        />
      </Field>
      <Field label="New password">
        <input
          name="newPassword"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          className={inputClass}
        />
      </Field>
      <ErrorText error={error} />
      {changed && (
        <p role="status" className="text-sm">
          Password changed. Other sessions were signed out.
        </p>
      )}
      <button type="submit" disabled={!hydrated || busy} className={buttonClass}>
        Change password
      </button>
    </form>
  )
}
