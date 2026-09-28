import { createFileRoute } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState, type FormEvent } from 'react'
import { inviteMemberFn } from '../modules/organizations/functions'
import { ErrorText, Field, buttonClass, inputClass, messageOf, useHydrated } from '../lib/ui'

// The invitee is also emailed when delivery is configured (ADR-0016); the link stays shareable here.
export const Route = createFileRoute('/t/$tenant/invite')({ component: Invite })

function Invite() {
  const hydrated = useHydrated()
  const { tenant } = Route.useParams()
  const invite = useServerFn(inviteMemberFn)
  const [link, setLink] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Invite a member</h2>
      <form method="post" onSubmit={onSubmit} className="space-y-4 rounded border bg-white p-4">
        <Field label="Invitee email">
          <input name="email" type="email" required className={inputClass} />
        </Field>
        <ErrorText error={error} />
        <button type="submit" disabled={!hydrated} className={buttonClass}>
          Create invitation
        </button>
      </form>
      {link && (
        <p className="rounded border bg-white p-4 text-sm">
          Share this link with the invitee:{' '}
          <a href={link} data-testid="invite-link" className="break-all underline">
            {link}
          </a>
        </p>
      )}
    </section>
  )
}
