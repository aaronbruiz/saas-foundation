import { createFileRoute, Link, redirect, useRouter } from '@tanstack/react-router'
import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { authClient } from '../lib/auth-client'
import { getViewerFn } from '../modules/organizations/functions'
import { messageOf, useHydrated } from '../lib/ui'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

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
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 p-4 sm:p-8">
      <section className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold">Account</h1>
          <p className="text-sm break-words text-muted-foreground">Signed in as {viewer.email}</p>
        </div>
        <Card>
          <CardContent>
            <NameForm name={viewer.name} />
          </CardContent>
        </Card>
      </section>
      <Section title="Password">
        <PasswordForm />
      </Section>
      <Section title="Organizations">
        <ul className="flex flex-col gap-1 text-sm">
          {viewer.organizations.map((o) => (
            <li key={o.slug}>
              <Link
                to="/t/$tenant/projects"
                params={{ tenant: o.slug }}
                className="inline-flex min-h-6 items-center break-all text-primary underline underline-offset-4"
              >
                {o.name}
              </Link>
            </li>
          ))}
          <li>
            <Link
              to="/orgs/new"
              className="inline-flex min-h-6 items-center text-primary underline underline-offset-4"
            >
              New organization
            </Link>
          </li>
        </ul>
      </Section>
      <Section title="Danger zone" danger>
        <DeleteAccountForm />
      </Section>
    </main>
  )
}

/** An account section: its heading is an h2, so the page keeps one outline. */
function Section({
  title,
  danger = false,
  children,
}: {
  title: string
  danger?: boolean
  children: ReactNode
}) {
  return (
    <section>
      <Card className={danger ? 'ring-destructive/40' : undefined}>
        <CardHeader>
          <CardTitle>
            <h2 className={danger ? 'text-base text-destructive' : 'text-base'}>{title}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </section>
  )
}

function NameForm({ name }: { name: string }) {
  const hydrated = useHydrated()
  const router = useRouter()
  const [saved, setSaved] = useState(false)
  // `field`: the typed value was invalid, so the error marks the field; any other failure is a
  // form-level alert (AGENTS.md "UI").
  const [error, setError] = useState<{ text: string; field: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (pending.current) return
    setSaved(false)
    const next = String(new FormData(e.currentTarget).get('name')).trim()
    if (!next) return setError({ text: 'Enter a name.', field: true })
    setError(null)
    pending.current = true
    setBusy(true)
    try {
      const { error } = await authClient.updateUser({ name: next })
      if (error)
        return setError({ text: error.message ?? "Your name couldn't be saved.", field: false })
      setSaved(true)
      await router.invalidate()
    } catch (err) {
      setError({ text: messageOf(err), field: false })
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <form method="post" onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field data-invalid={error?.field || undefined}>
        <FieldLabel htmlFor="account-name">Name</FieldLabel>
        <Input
          id="account-name"
          name="name"
          required
          defaultValue={name}
          aria-invalid={error?.field || undefined}
        />
        {error?.field && <FieldError>{error.text}</FieldError>}
      </Field>
      {error && !error.field && <FieldError>{error.text}</FieldError>}
      {saved && (
        <p role="status" className="text-sm">
          Name saved.
        </p>
      )}
      <div>
        <Button type="submit" disabled={!hydrated || busy}>
          Save name
        </Button>
      </div>
    </form>
  )
}

type DeleteRefusal = { code?: string; message?: string; left?: string[] }
/** The answers that establish the account wasn't deleted; anything else (a 500) doesn't. */
const NOT_DELETED = [
  'INVALID_PASSWORD',
  'SOLE_OWNER',
  'BILLING_ACCESS_BUSY',
  'NOW_SOLE_OWNER',
  'BILLING_UNAVAILABLE',
  'TRY_AGAIN',
]

/** What a refused deletion tells the user, including what already happened (ADR-0044). */
function deleteRefusalText({ code, message, left = [] }: DeleteRefusal) {
  if (!code || !NOT_DELETED.includes(code))
    return "We couldn't confirm your account was deleted. Try signing in again to check."
  const done = left.length > 0 ? ` You left ${left.join(', ')}.` : ''
  return `Your account wasn't deleted.${done} ${message ?? 'Please try again.'}`
}

function DeleteAccountForm() {
  const hydrated = useHydrated()
  // `field`: a wrong password, the one answer about the typed value; any other refusal is a
  // form-level alert (AGENTS.md "UI").
  const [error, setError] = useState<{ text: string; field: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (pending.current) return
    setError(null)
    pending.current = true
    setBusy(true)
    try {
      const password = String(new FormData(e.currentTarget).get('password'))
      const { error } = await authClient.$fetch('/delete-account', {
        method: 'POST',
        body: { password },
      })
      if (error) {
        const refusal = error as DeleteRefusal
        return setError({
          text: deleteRefusalText(refusal),
          field: refusal.code === 'INVALID_PASSWORD',
        })
      }
      window.location.assign('/')
    } catch (err) {
      setError({ text: messageOf(err), field: false })
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <form method="post" onSubmit={onSubmit} className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Your account stops working at once, and you leave your organizations. If you solely own one,
        transfer or delete it first. Your data is removed later, as the{' '}
        <Link to="/privacy" className="underline">
          Privacy Policy
        </Link>{' '}
        describes. You can sign up again with the same email, as a new, empty account.
      </p>
      <Field data-invalid={error?.field || undefined}>
        <FieldLabel htmlFor="delete-password">Password to delete your account</FieldLabel>
        <Input
          id="delete-password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          aria-invalid={error?.field || undefined}
        />
        {error?.field && <FieldError>{error.text}</FieldError>}
      </Field>
      {error && !error.field && <FieldError>{error.text}</FieldError>}
      <div>
        <Button type="submit" variant="destructive" disabled={!hydrated || busy}>
          Delete account
        </Button>
      </div>
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
    <form method="post" onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field>
        <FieldLabel htmlFor="current-password">Current password</FieldLabel>
        <Input
          id="current-password"
          name="currentPassword"
          type="password"
          required
          autoComplete="current-password"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="new-password">New password</FieldLabel>
        <Input
          id="new-password"
          name="newPassword"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
        />
      </Field>
      {/* One error for the form: it may be about either password. */}
      <FieldError>{error}</FieldError>
      {changed && (
        <p role="status" className="text-sm">
          Password changed. Other sessions were signed out.
        </p>
      )}
      <div>
        <Button type="submit" disabled={!hydrated || busy}>
          Change password
        </Button>
      </div>
    </form>
  )
}
