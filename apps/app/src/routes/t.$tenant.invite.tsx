import { createFileRoute } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState, type FormEvent } from 'react'
import { inviteMemberFn } from '../modules/organizations/functions'
import { messageOf, useHydrated } from '../lib/ui'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

// The invitee is also emailed when delivery is configured (ADR-0016); the link stays shareable here.
export const Route = createFileRoute('/t/$tenant/invite')({ component: Invite })

function Invite() {
  const hydrated = useHydrated()
  const { tenant } = Route.useParams()
  const invite = useServerFn(inviteMemberFn)
  const [link, setLink] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Only the server's input-validation 400 is about the email field (apps/app/src/server/errors.ts).
  const fieldError = error === 'invalid input'

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    try {
      const result = await invite({
        data: { tenant, email: String(form.get('email')), role: 'member' },
      })
      setLink(result.link)
      setError(null)
    } catch (err) {
      setError(messageOf(err))
    }
  }

  return (
    <section className="flex flex-col gap-6">
      <h2 className="text-lg font-semibold">Invite a member</h2>
      <Card>
        <CardContent>
          <form method="post" onSubmit={onSubmit} className="flex flex-col gap-4">
            <Field data-invalid={fieldError ? true : undefined}>
              <FieldLabel htmlFor="invitee-email">Invitee email</FieldLabel>
              <Input
                id="invitee-email"
                name="email"
                type="email"
                required
                aria-invalid={fieldError ? true : undefined}
              />
              {fieldError && <FieldError>{error}</FieldError>}
            </Field>
            {error && !fieldError && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div>
              <Button type="submit" disabled={!hydrated}>
                Create invitation
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      {link && (
        <Card>
          <CardContent>
            <p>
              Share this link with the invitee:{' '}
              <a
                href={link}
                data-testid="invite-link"
                className="break-all text-primary underline underline-offset-4"
              >
                {link}
              </a>
            </p>
          </CardContent>
        </Card>
      )}
    </section>
  )
}
