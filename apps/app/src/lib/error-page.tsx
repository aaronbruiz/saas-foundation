import { Link, useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { createContext, useContext } from 'react'

/** True inside a layout that already renders the page's `main` landmark (the tenant shell): the
 * error page then renders a plain element, so the document keeps one `main`. */
export const InsideMain = createContext(false)

/**
 * Every route's error page (the router's `defaultErrorComponent`, so it also renders during SSR):
 * a loader or render failure. Fixed copy: an error's message isn't shown, since a client-side
 * failure's text can be anything (server functions already send safe messages).
 */
export function ErrorPage({ reset }: ErrorComponentProps) {
  const router = useRouter()
  const Root = useContext(InsideMain) ? 'div' : 'main'
  return (
    <Root className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-muted-foreground">
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
    </Root>
  )
}
