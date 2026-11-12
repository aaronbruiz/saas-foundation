import type { ReactNode } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

// The auth pages' frame (ADR-0046): sign-in, sign-up, password reset, invitation, new organization.
//
// The 320 px gutter is deliberate. Turnstile's widget is a fixed 300 px wide, so on a 320 px screen
// the content gutter can be at most 10 px a side (`px-2.5`) or the page scrolls sideways. Below
// `sm` the card therefore goes flat and edge to edge (no padding, background, shadow or ring), and
// its overflow stays visible there so focus rings aren't clipped. Pages without Turnstile use the
// same frame so every auth page looks alike.
export function AuthLayout({
  title,
  description,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <main className="mx-auto w-full max-w-sm px-2.5 py-8 sm:px-4">
      <Card className="max-sm:gap-6 max-sm:overflow-visible max-sm:bg-transparent max-sm:shadow-none max-sm:ring-0 max-sm:[--card-spacing:--spacing(0)]">
        <CardHeader>
          <CardTitle>
            <h1 className="text-2xl font-semibold">{title}</h1>
          </CardTitle>
          {description !== undefined && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent className="gap-4">{children}</CardContent>
      </Card>
    </main>
  )
}

// A link inside a sentence.
export const authInlineLink = 'text-primary underline underline-offset-4'
// A link on its own line: at least 24 px tall (WCAG 2.5.8).
export const authStandaloneLink =
  'inline-flex min-h-6 items-center text-primary underline underline-offset-4'
