import { HeadContent, Scripts, createRootRoute, Link, useMatches } from '@tanstack/react-router'
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

// The footer's column matches the page's content column (its left edge lines up): the account
// page's and the auth pages' (components/ui/auth-layout.tsx); every other page uses max-w-3xl p-8.
const authColumn = 'mx-auto w-full max-w-sm px-2.5 py-8 sm:px-4'
const footerColumns: Partial<Record<string, string>> = {
  '/account': 'mx-auto w-full max-w-xl px-4 py-8 sm:px-8',
  '/login': authColumn,
  '/signup': authColumn,
  '/forgot-password': authColumn,
  '/reset-password': authColumn,
  '/invite/$id': authColumn,
  '/orgs/new': authColumn,
}

function RootDocument({ children }: { children: ReactNode }) {
  const routeId = useMatches({ select: (matches) => matches[matches.length - 1]?.routeId })
  const footerColumn = footerColumns[routeId ?? ''] ?? 'mx-auto max-w-3xl p-8'
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
        <footer className={`${footerColumn} text-sm text-muted-foreground`}>
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
