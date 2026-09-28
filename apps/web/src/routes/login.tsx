import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { authClient } from '../lib/auth-client'
import { safeRedirect } from '../lib/safe-redirect'
import { ErrorText, Field, buttonClass, inputClass, useHydrated } from '../lib/ui'

export const Route = createFileRoute('/login')({
  validateSearch: (s: Record<string, unknown>) => ({ redirect: safeRedirect(s.redirect) }),
  component: Login,
})

function Login() {
  const hydrated = useHydrated()
  const { redirect } = Route.useSearch()
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
    if (error) return setError(error.message ?? 'Sign-in failed')
    await router.invalidate()
    await router.navigate({ href: redirect })
  }

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="mb-6 text-2xl font-semibold">Sign in</h1>
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
