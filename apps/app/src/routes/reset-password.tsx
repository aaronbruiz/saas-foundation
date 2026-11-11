import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState, type FormEvent } from 'react'
import { authClient } from '../lib/auth-client'
import { useHydrated } from '../lib/ui'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

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
    <main className={authMain}>
      <Card className={authCard}>
        <CardHeader>
          <CardTitle>
            <h1 className="text-2xl font-semibold">Choose a new password</h1>
          </CardTitle>
        </CardHeader>
        <CardContent className="gap-4">
          {done ? (
            <p role="status" className="text-sm">
              Password changed. Other sessions were signed out.{' '}
              <Link to="/login" search={{ redirect: '/' }} className={inlineLink}>
                Sign in
              </Link>
            </p>
          ) : (
            <form method="post" onSubmit={onSubmit} className="flex flex-col gap-4">
              <Field>
                <FieldLabel htmlFor="new-password">New password</FieldLabel>
                <Input
                  id="new-password"
                  name="password"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                />
              </Field>
              <FieldError>{error}</FieldError>
              <Button type="submit" disabled={!hydrated || busy}>
                Change password
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  )
}

// The auth pages' frame (ADR-0046): flat and edge to edge below `sm`, like the pages with
// Turnstile, whose fixed 300 px widget has to fit a 320 px screen.
const authMain = 'mx-auto w-full max-w-sm px-2.5 py-8 sm:px-4'
const authCard =
  'max-sm:gap-6 max-sm:overflow-visible max-sm:bg-transparent max-sm:shadow-none max-sm:ring-0 max-sm:[--card-spacing:--spacing(0)]'
const inlineLink = 'text-primary underline underline-offset-4'
