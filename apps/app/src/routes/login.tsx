import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { authClient } from '../lib/auth-client'
import { safeRedirect } from '../lib/safe-redirect'
import { useHydrated } from '../lib/ui'
import { useTurnstile } from '../lib/turnstile'
import { getTurnstileConfigFn } from '../server/turnstile'
import { AuthLayout, authInlineLink, authStandaloneLink } from '@/components/ui/auth-layout'
import { Button } from '@/components/ui/button'
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
    <AuthLayout title="Sign in">
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
        <Link to="/forgot-password" className={authStandaloneLink}>
          Forgot password?
        </Link>
      </p>
      <p className="text-sm">
        No account?{' '}
        <Link to="/signup" search={{ redirect }} className={authInlineLink}>
          Sign up
        </Link>
      </p>
    </AuthLayout>
  )
}
