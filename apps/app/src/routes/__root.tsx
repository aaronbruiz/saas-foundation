import { HeadContent, Scripts, createRootRoute, Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import appCss from '../styles.css?url'
import { CSPProvider } from '@base-ui/react/csp-provider'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'saas-foundation' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
  // Same page for unknown and foreign tenants/resources (AGENTS.md invariant 5).
  notFoundComponent: NotFound,
})

function NotFound() {
  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl font-semibold">Not found</h1>
      <p className="mt-2 text-muted-foreground">
        This page doesn&apos;t exist or you don&apos;t have access to it.
      </p>
      <Link to="/" className="mt-4 inline-block text-primary underline underline-offset-4">
        Go home
      </Link>
    </main>
  )
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background text-foreground">
        {/* Base UI injects no <style> elements (the CSP refuses them, ADR-0045); styles.css has the rule. */}
        <CSPProvider disableStyleElements>
          <TooltipProvider>{children}</TooltipProvider>
        </CSPProvider>
        <Toaster />
        <footer className="mx-auto max-w-3xl p-8 text-sm text-muted-foreground">
          <nav aria-label="Legal" className="flex gap-4">
            <Link to="/privacy" className="text-primary underline underline-offset-4">
              Privacy
            </Link>
            <Link to="/terms" className="text-primary underline underline-offset-4">
              Terms
            </Link>
            <Link to="/subprocessors" className="text-primary underline underline-offset-4">
              Subprocessors
            </Link>
          </nav>
        </footer>
        <Scripts />
      </body>
    </html>
  )
}
