import type { AuthEmail } from '@saas-foundation/auth'
import { logError, logWarn } from './log'

/**
 * Transactional email behind one seam (ADR-0016): templates here, delivery chosen by configuration,
 * so the provider can change without touching auth code. Sending is synchronous (no Queues).
 */
export type EmailMessage = { to: string; subject: string; text: string; html: string }
export type Mailer = (message: EmailMessage) => Promise<void>

/** The subset of Cloudflare's `send_email` binding we use (Email Service, Workers Paid). */
export type SendEmailBinding = {
  send(message: {
    to: string
    from: { email: string; name: string }
    subject: string
    text: string
    html: string
  }): Promise<unknown>
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function message(to: string, subject: string, lines: string[], url: string): EmailMessage {
  const text = [...lines, '', url].join('\n')
  const html =
    lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('') +
    `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`
  return { to, subject, text, html }
}

/** Renders an auth email. `invitationUrl` builds the accept link for an invitation id. */
export function render(email: AuthEmail, invitationUrl: (id: string) => string): EmailMessage {
  switch (email.kind) {
    case 'invitation':
      return message(
        email.to,
        `You're invited to ${email.organizationName}`,
        [
          `You've been invited to join ${email.organizationName}.`,
          'Sign in or create an account with this email address, then accept the invitation:',
        ],
        invitationUrl(email.invitationId),
      )
    case 'password-reset':
      return message(
        email.to,
        'Reset your password',
        [
          'Someone asked to reset the password for this account.',
          'If it was you, open this link within an hour. Otherwise ignore this email.',
        ],
        email.url,
      )
    case 'verification':
      return message(
        email.to,
        'Verify your email address',
        ['Confirm this email address for your account:'],
        email.url,
      )
  }
}

export type EmailConfig = {
  EMAIL_DELIVERY?: string
  EMAIL_FROM?: string
  BETTER_AUTH_URL: string
  EMAIL?: SendEmailBinding
}

/**
 * Delivery by `EMAIL_DELIVERY`:
 * - `cloudflare`: the `EMAIL` binding, from `EMAIL_FROM` (production, once the domain is onboarded).
 * - `console`: local development only. Prints the message, links included, and is refused unless
 *   the app runs on localhost, so tokens can't reach production logs.
 * - unset: disabled. Nothing is sent; a warning without the address is logged. Invitations still
 *   return their link to the inviter.
 * A misconfiguration fails the send (logged), not every auth request.
 */
function misconfigured(reason: string): Mailer {
  return async () => {
    const e = new Error(reason)
    logError('email.misconfigured', e)
    throw e
  }
}

export function mailerFor(config: EmailConfig): Mailer {
  const mode = config.EMAIL_DELIVERY
  if (mode === 'cloudflare') {
    const binding = config.EMAIL
    const from = config.EMAIL_FROM
    if (!binding || !from)
      return misconfigured('EMAIL_DELIVERY=cloudflare needs the EMAIL binding and EMAIL_FROM')
    return async (m) => {
      try {
        await binding.send({
          to: m.to,
          from: { email: from, name: 'SaaS Foundation' },
          subject: m.subject,
          text: m.text,
          html: m.html,
        })
      } catch (e) {
        logError('email.send_failed', e, { subject: m.subject })
        throw e
      }
    }
  }
  if (mode === 'console') {
    if (!/^http:\/\/localhost(:\d+)?$/.test(config.BETTER_AUTH_URL))
      return misconfigured('EMAIL_DELIVERY=console is only allowed on localhost')
    return async (m) => console.info(`[email] to=${m.to} subject=${m.subject}\n${m.text}`)
  }
  return async (m) => logWarn('email.delivery_disabled', { subject: m.subject })
}
