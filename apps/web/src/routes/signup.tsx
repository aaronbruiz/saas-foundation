import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { authClient } from '../lib/auth-client'
import { safeRedirect, verifiedLoginUrl } from '../lib/safe-redirect'
import { ErrorText, Field, buttonClass, inputClass, useHydrated } from '../lib/ui'

export const Route = createFileRoute('/signup')({
  validateSearch: (s: Record<string, unknown>) => ({ redirect: safeRedirect(s.redirect) }),
  component: Signup,
})

function Signup() {
  const hydrated = useHydrated()
  const { redirect } = Route.useSearch()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)

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
    })
    setBusy(false)
    if (error) return setError(error.message ?? 'Sign-up failed')
    // ADR-0016: no session until the address is verified (always the answer where verification is
    // required, whether or not the address already had an account).
    if (!data?.token) return setSentTo(email)
    await router.invalidate()
    await router.navigate({ href: redirect })
  }

  if (sentTo)
    return (
      <main className="mx-auto max-w-sm p-8">
        <h1 className="mb-6 text-2xl font-semibold">Check your email</h1>
        <p role="status" className="mb-4">
          We sent a verification link to {sentTo}. Open it, then sign in.
        </p>
        <p className="text-sm text-gray-600">
          Didn't receive it?{' '}
          <Link to="/login" search={{ redirect }} className="underline">
            Sign in
          </Link>{' '}
          again to receive a new verification link.
        </p>
      </main>
    )

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="mb-6 text-2xl font-semibold">Create account</h1>
      <form method="post" onSubmit={onSubmit} className="space-y-4">
        <Field label="Name">
          <input name="name" required className={inputClass} />
        </Field>
        <Field label="Email">
          <input name="email" type="email" required className={inputClass} />
        </Field>
        <Field label="Password">
          <input name="password" type="password" required minLength={8} className={inputClass} />
        </Field>
        <ErrorText error={error} />
        <button type="submit" disabled={!hydrated || busy} className={buttonClass}>
          Create account
        </button>
      </form>
      <p className="mt-4 text-sm">
        Have an account?{' '}
        <Link to="/login" search={{ redirect }} className="underline">
          Sign in
        </Link>
      </p>
    </main>
  )
}
