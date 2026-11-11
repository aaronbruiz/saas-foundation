import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { authClient } from '../lib/auth-client'
import { safeRedirect, verifiedLoginUrl } from '../lib/safe-redirect'
import { useHydrated } from '../lib/ui'
import { useTurnstile } from '../lib/turnstile'
import { getTurnstileConfigFn } from '../server/turnstile'
import { AuthLayout, authInlineLink } from '@/components/ui/auth-layout'
import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

export const Route = createFileRoute('/signup')({
  validateSearch: (s: Record<string, unknown>) => ({ redirect: safeRedirect(s.redirect) }),
  loader: () => getTurnstileConfigFn(),
  component: Signup,
})

function Signup() {
  const hydrated = useHydrated()
  const { redirect } = Route.useSearch()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const turnstile = useTurnstile(Route.useLoaderData(), '/sign-up/email')

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const email = String(form.get('email'))
    setBusy(true)
    const { data, error } = await authClient.signUp.email({
      name: String(form.get('name')),
      email,
      password: String(form.get('password')),
      callbackURL: verifiedLoginUrl(redirect),
      fetchOptions: { headers: turnstile.headers },
    })
    setBusy(false)
    turnstile.reset()
    if (error) return setError(error.message ?? 'Sign-up failed')
    // ADR-0016: no session until the address is verified (always the answer where verification is
    // required, whether or not the address already had an account).
    if (!data?.token) return setSentTo(email)
    await router.invalidate()
    await router.navigate({ href: redirect })
  }

  if (sentTo)
    return (
      <AuthLayout title="Check your email">
        <p role="status">We sent a verification link to {sentTo}. Open it, then sign in.</p>
        <p className="text-sm text-muted-foreground">
          Didn't receive it?{' '}
          <Link to="/login" search={{ redirect }} className={authInlineLink}>
            Sign in
          </Link>{' '}
          again to receive a new verification link.
        </p>
      </AuthLayout>
    )

  return (
    <AuthLayout title="Create account">
      <form method="post" onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor="signup-name">Name</FieldLabel>
          <Input id="signup-name" name="name" required />
        </Field>
        <Field>
          <FieldLabel htmlFor="signup-email">Email</FieldLabel>
          <Input id="signup-email" name="email" type="email" required />
        </Field>
        <Field>
          <FieldLabel htmlFor="signup-password">Password</FieldLabel>
          <Input id="signup-password" name="password" type="password" required minLength={8} />
        </Field>
        {turnstile.element}
        <FieldError>{error}</FieldError>
        {/* Wording is the owner's (or their lawyer's) to confirm; acceptance isn't recorded. */}
        <p className="text-sm text-muted-foreground">
          By creating an account you agree to the{' '}
          <Link to="/terms" className={authInlineLink}>
            Terms
          </Link>{' '}
          and acknowledge the{' '}
          <Link to="/privacy" className={authInlineLink}>
            Privacy Policy
          </Link>
          .
        </p>
        <Button type="submit" disabled={!hydrated || busy || !turnstile.token}>
          Create account
        </Button>
      </form>
      <p className="text-sm">
        Have an account?{' '}
        <Link to="/login" search={{ redirect }} className={authInlineLink}>
          Sign in
        </Link>
      </p>
    </AuthLayout>
  )
}
