import { Link, useRouter, type ErrorComponentProps } from '@tanstack/react-router'

/**
 * Every route's error page (the router's `defaultErrorComponent`, so it also renders during SSR):
 * a loader or render failure. Fixed copy: an error's message isn't shown, since a client-side
 * failure's text can be anything (server functions already send safe messages).
 */
export function ErrorPage({ reset }: ErrorComponentProps) {
  const router = useRouter()
  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-gray-600">
        This page couldn&apos;t be loaded. Try again, or go home.
      </p>
      <div className="mt-4 flex gap-4">
        <button
          type="button"
          className="underline"
          onClick={() => {
            reset()
            void router.invalidate()
          }}
        >
          Try again
        </button>
        <Link to="/" className="underline">
          Go home
        </Link>
      </div>
    </main>
  )
}
