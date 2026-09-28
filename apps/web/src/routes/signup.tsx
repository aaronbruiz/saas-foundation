import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { authClient } from '../lib/auth-client'
import { safeRedirect } from '../lib/safe-redirect'
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

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setBusy(true)
    const { error } = await authClient.signUp.email({
      name: String(form.get('name')),
      email: String(form.get('email')),
      password: String(form.get('password')),
    })
    setBusy(false)
    if (error) return setError(error.message ?? 'Sign-up failed')
    await router.invalidate()
    await router.navigate({ href: redirect })
  }

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
