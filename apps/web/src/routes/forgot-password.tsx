import { createFileRoute, Link } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { authClient } from '../lib/auth-client'
import { ErrorText, Field, buttonClass, inputClass, useHydrated } from '../lib/ui'

// Password reset request (ADR-0016). The answer is the same whether or not the account exists.
export const Route = createFileRoute('/forgot-password')({ component: ForgotPassword })

function ForgotPassword() {
  const hydrated = useHydrated()
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setBusy(true)
    const { error } = await authClient.requestPasswordReset({
      email: String(form.get('email')),
      redirectTo: '/reset-password',
    })
    setBusy(false)
    if (error) return setError(error.message ?? 'Request failed')
    setSent(true)
  }

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="mb-6 text-2xl font-semibold">Reset your password</h1>
      {sent ? (
        <p role="status" className="text-sm">
          If an account exists for that address, we've sent a link to reset the password.
        </p>
      ) : (
        <form method="post" onSubmit={onSubmit} className="space-y-4">
          <Field label="Email">
            <input name="email" type="email" required className={inputClass} />
          </Field>
          <ErrorText error={error} />
          <button type="submit" disabled={!hydrated || busy} className={buttonClass}>
            Send reset link
          </button>
        </form>
      )}
      <p className="mt-4 text-sm">
        <Link to="/login" search={{ redirect: '/' }} className="underline">
          Back to sign in
        </Link>
      </p>
    </main>
  )
}
