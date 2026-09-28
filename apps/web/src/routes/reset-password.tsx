import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState, type FormEvent } from 'react'
import { authClient } from '../lib/auth-client'
import { ErrorText, Field, buttonClass, inputClass, useHydrated } from '../lib/ui'

// Target of the reset email (ADR-0016): /reset-password?token=…. The token is kept in state and
// dropped from the address bar right away, so it doesn't linger in history or get shared.
export const Route = createFileRoute('/reset-password')({
  validateSearch: (s: Record<string, unknown>) => ({
    token: typeof s.token === 'string' ? s.token : undefined,
  }),
  component: ResetPassword,
})

function ResetPassword() {
  const hydrated = useHydrated()
  const navigate = useNavigate()
  const search = Route.useSearch()
  const [token] = useState(search.token)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (search.token)
      void navigate({ to: '/reset-password', search: { token: undefined }, replace: true })
  }, [search.token, navigate])

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!token) return setError('This reset link is invalid or has expired.')
    const form = new FormData(e.currentTarget)
    setBusy(true)
    const { error } = await authClient.resetPassword({
      newPassword: String(form.get('password')),
      token,
    })
    setBusy(false)
    if (error) return setError(error.message ?? 'This reset link is invalid or has expired.')
    setDone(true)
  }

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="mb-6 text-2xl font-semibold">Choose a new password</h1>
      {done ? (
        <p role="status" className="text-sm">
          Password changed. Other sessions were signed out.{' '}
          <Link to="/login" search={{ redirect: '/' }} className="underline">
            Sign in
          </Link>
        </p>
      ) : (
        <form method="post" onSubmit={onSubmit} className="space-y-4">
          <Field label="New password">
            <input
              name="password"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              className={inputClass}
            />
          </Field>
          <ErrorText error={error} />
          <button type="submit" disabled={!hydrated || busy} className={buttonClass}>
            Change password
          </button>
        </form>
      )}
    </main>
  )
}
