import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { authClient } from '../lib/auth-client'
import { safeRedirect } from '../lib/safe-redirect'
import { useHydrated } from '../lib/ui'
import { useTurnstile } from '../lib/turnstile'
import { getTurnstileConfigFn } from '../server/turnstile'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

export const Route = createFileRoute('/login')({
  // `verified` / `error`: where a verification link lands (ADR-0016); Better Auth appends `error`
  // when the link is invalid or expired. Only their presence is used, never their text.
  validateSearch: (
    s: Record<string, unknown>,
  ): { redirect: string; verified?: boolean; error?: boolean } => ({
    redirect: safeRedirect(s.redirect),
    ...(String(s.verified) === '1' && { verified: true }),
    ...(s.error !== undefined && { error: true }),
  }),
  loader: () => getTurnstileConfigFn(),
  component: Login,
})

function Login() {
  const hydrated = useHydrated()
  const { redirect, verified, error: linkError } = Route.useSearch()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const turnstile = useTurnstile(Route.useLoaderData(), '/sign-in/email')

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setBusy(true)
    const { error } = await authClient.signIn.email({
      email: String(form.get('email')),
      password: String(form.get('password')),
      fetchOptions: { headers: turnstile.headers },
    })
    setBusy(false)
    turnstile.reset()
    if (error)
      return setError(
        error.code === 'EMAIL_NOT_VERIFIED'
          ? 'Verify your email address first. We sent you a new link.'
          : (error.message ?? 'Sign-in failed'),
      )
    await router.invalidate()
    await router.navigate({ href: redirect })
  }

  return (
    <main className={authMain}>
      <Card className={authCard}>
        <CardHeader>
          <CardTitle>
            <h1 className="text-2xl font-semibold">Sign in</h1>
          </CardTitle>
        </CardHeader>
        <CardContent className="gap-4">
          {linkError ? (
            <p role="status" className="text-sm">
              That verification link is invalid or has expired. Sign in to receive a new one.
            </p>
          ) : verified ? (
            <p role="status" className="text-sm">
              Email verified. Sign in to continue.
            </p>
          ) : null}
          <form method="post" onSubmit={onSubmit} className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="login-email">Email</FieldLabel>
              <Input id="login-email" name="email" type="email" required />
            </Field>
            <Field>
              <FieldLabel htmlFor="login-password">Password</FieldLabel>
              <Input id="login-password" name="password" type="password" required />
            </Field>
            {turnstile.element}
            <FieldError>{error}</FieldError>
            <Button type="submit" disabled={!hydrated || busy || !turnstile.token}>
              Sign in
            </Button>
          </form>
          <p className="text-sm">
            <Link to="/forgot-password" className={standaloneLink}>
              Forgot password?
            </Link>
          </p>
          <p className="text-sm">
            No account?{' '}
            <Link to="/signup" search={{ redirect }} className={inlineLink}>
              Sign up
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
const inlineLink = 'text-primary underline underline-offset-4'
// A link on its own line: at least 24 px tall (WCAG 2.5.8).
const standaloneLink = 'inline-flex min-h-6 items-center text-primary underline underline-offset-4'
