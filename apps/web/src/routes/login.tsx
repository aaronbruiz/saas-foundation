import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { authClient } from '../lib/auth-client'
import { safeRedirect } from '../lib/safe-redirect'
import { ErrorText, Field, buttonClass, inputClass, useHydrated } from '../lib/ui'

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
  component: Login,
})

function Login() {
  const hydrated = useHydrated()
  const { redirect, verified, error: linkError } = Route.useSearch()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setBusy(true)
    const { error } = await authClient.signIn.email({
      email: String(form.get('email')),
      password: String(form.get('password')),
    })
    setBusy(false)
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
    <main className="mx-auto max-w-sm p-8">
      <h1 className="mb-6 text-2xl font-semibold">Sign in</h1>
      {linkError ? (
        <p role="status" className="mb-4 text-sm">
          That verification link is invalid or has expired. Sign in to receive a new one.
        </p>
      ) : verified ? (
        <p role="status" className="mb-4 text-sm">
          Email verified. Sign in to continue.
        </p>
      ) : null}
      <form method="post" onSubmit={onSubmit} className="space-y-4">
        <Field label="Email">
          <input name="email" type="email" required className={inputClass} />
        </Field>
        <Field label="Password">
          <input name="password" type="password" required className={inputClass} />
        </Field>
        <ErrorText error={error} />
        <button type="submit" disabled={!hydrated || busy} className={buttonClass}>
          Sign in
        </button>
      </form>
      <p className="mt-4 text-sm">
        <Link to="/forgot-password" className="underline">
          Forgot password?
        </Link>
      </p>
      <p className="mt-2 text-sm">
        No account?{' '}
        <Link to="/signup" search={{ redirect }} className="underline">
          Sign up
        </Link>
      </p>
    </main>
  )
}
