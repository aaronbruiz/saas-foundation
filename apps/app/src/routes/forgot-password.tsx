import { createFileRoute, Link } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { authClient } from '../lib/auth-client'
import { useHydrated } from '../lib/ui'
import { useTurnstile } from '../lib/turnstile'
import { getTurnstileConfigFn } from '../server/turnstile'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
    <main className={authMain}>
      <Card className={authCard}>
        <CardHeader>
          <CardTitle>
            <h1 className="text-2xl font-semibold">Reset your password</h1>
          </CardTitle>
        </CardHeader>
        <CardContent className="gap-4">
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
            <Link to="/login" search={{ redirect: '/' }} className={standaloneLink}>
              Back to sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </main>
  )
}

// The auth pages' frame (ADR-0046). Below `sm` the card goes flat and edge to edge, so Turnstile's
// fixed 300 px widget fits a 320 px screen without sideways scroll; its overflow stays visible
// there, so focus rings aren't clipped.
const authMain = 'mx-auto w-full max-w-sm px-2.5 py-8 sm:px-4'
const authCard =
  'max-sm:gap-6 max-sm:overflow-visible max-sm:bg-transparent max-sm:shadow-none max-sm:ring-0 max-sm:[--card-spacing:--spacing(0)]'
// A link on its own line: at least 24 px tall (WCAG 2.5.8).
const standaloneLink = 'inline-flex min-h-6 items-center text-primary underline underline-offset-4'
