import { createFileRoute, Link } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { authClient } from '../lib/auth-client'
import { useHydrated } from '../lib/ui'
import { useTurnstile } from '../lib/turnstile'
import { getTurnstileConfigFn } from '../server/turnstile'
import { AuthLayout, authStandaloneLink } from '@/components/ui/auth-layout'
import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

// Password reset request (ADR-0016). The answer is the same whether or not the account exists.
export const Route = createFileRoute('/forgot-password')({
  loader: () => getTurnstileConfigFn(),
  component: ForgotPassword,
})

function ForgotPassword() {
  const hydrated = useHydrated()
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const turnstile = useTurnstile(Route.useLoaderData(), '/request-password-reset')

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setBusy(true)
    const { error } = await authClient.requestPasswordReset({
      email: String(form.get('email')),
      redirectTo: '/reset-password',
      fetchOptions: { headers: turnstile.headers },
    })
    setBusy(false)
    turnstile.reset()
    if (error) return setError(error.message ?? 'Request failed')
    setSent(true)
  }

  return (
    <AuthLayout title="Reset your password">
      {sent ? (
        <p role="status" className="text-sm">
          If an account exists for that address, we've sent a link to reset the password.
        </p>
      ) : (
        <form method="post" onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="forgot-email">Email</FieldLabel>
            <Input id="forgot-email" name="email" type="email" required />
          </Field>
          {turnstile.element}
          <FieldError>{error}</FieldError>
          <Button type="submit" disabled={!hydrated || busy || !turnstile.token}>
            Send reset link
          </Button>
        </form>
      )}
      <p className="text-sm">
        <Link to="/login" search={{ redirect: '/' }} className={authStandaloneLink}>
          Back to sign in
        </Link>
      </p>
    </AuthLayout>
  )
}
