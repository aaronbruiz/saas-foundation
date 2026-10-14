import { createFileRoute, Link } from '@tanstack/react-router'
import { legalDocuments, legalEntity } from '../lib/legal'
import { LegalPage, Section } from '../lib/legal-page'

export const Route = createFileRoute('/privacy')({ component: Privacy })

const { name, product, contactEmail } = legalEntity

function Privacy() {
  return (
    <LegalPage doc={legalDocuments.privacy}>
      <Section title="Who we are">
        <p>
          {name} (&ldquo;we&rdquo;) provides {product} (&ldquo;the service&rdquo;) and is
          responsible for the personal data described here. Contact: {contactEmail}.
        </p>
      </Section>
      <Section title="Data we collect">
        <ul className="list-disc space-y-1 pl-6">
          <li>
            <strong>Account:</strong> your name, email address, whether you verified it, and your
            password, stored only as a hash. You give us these when you sign up.
          </li>
          <li>
            <strong>Sign-in sessions:</strong> a cookie that keeps you signed in, and for each
            session your IP address and browser user agent.
          </li>
          <li>
            <strong>Organizations:</strong> each organization&apos;s name and address in the
            service, its members and their roles, and pending invitations (the invitee&apos;s email
            address, role and who invited them).
          </li>
          <li>
            <strong>Content you create:</strong> projects (name, description and who created them).
          </li>
          <li>
            <strong>Billing:</strong> your organization&apos;s plan and subscription status. You
            enter payment details in Polar&apos;s checkout; we don&apos;t receive card data.
          </li>
          <li>
            <strong>Security:</strong> your IP address, used to limit repeated sign-in and sign-up
            attempts, and sent with a bot-check token to Cloudflare Turnstile when you sign up, sign
            in, reset your password or request a verification email.
          </li>
          <li>
            <strong>Technical logs:</strong> for each request, its path (without query string),
            status and outcome, and error messages.
          </li>
        </ul>
        <p>We don&apos;t use advertising or analytics trackers.</p>
      </Section>
      <Section title="How we use it">
        <ul className="list-disc space-y-1 pl-6">
          <li>
            To provide the service (accounts, sign-in, organizations, invitations, projects) and
            send its emails (address verification, password reset, invitations), as needed to
            perform our contract with you.
          </li>
          <li>To bill paid plans through Polar, as needed to perform that contract.</li>
          <li>
            To keep the service secure and working (rate limiting, bot protection, logs, error
            alerts, backups), in our legitimate interest in its security and reliability.
          </li>
        </ul>
        <p>We don&apos;t sell personal data or use it for marketing.</p>
      </Section>
      <Section title="Who we share it with">
        <p>
          Service providers that process data for us are listed on the{' '}
          <Link to="/subprocessors" className="underline">
            Subprocessors
          </Link>{' '}
          page. Polar sells paid plans as merchant of record and handles the payment data you give
          it under its own privacy policy.
        </p>
        <p>
          Our database runs in the United States (AWS us-east-1), and our providers may process data
          in other countries. Where the law requires safeguards for such transfers, we rely on our
          providers&apos; data processing terms.
        </p>
      </Section>
      <Section title="Retention">
        <ul className="list-disc space-y-1 pl-6">
          <li>
            Account, organization and project data: while the account or organization exists. To
            delete your account or an organization, write to {contactEmail}.
          </li>
          <li>
            Sessions expire after 7 days without use; verification, password-reset and invitation
            links expire too.
          </li>
          <li>Request logs: 7 days.</li>
          <li>
            Backups: daily copies of the database kept for up to 30 days, and a few recent database
            snapshots that are replaced as new ones are taken. Deleted data leaves the backups as
            they expire or are replaced.
          </li>
        </ul>
      </Section>
      <Section title="Your rights">
        <p>
          You can ask us to access, correct, delete or export your personal data, or object to its
          processing, by writing to {contactEmail}. We may ask you to confirm your identity first.
          You can also complain to the data protection authority where you live.
        </p>
      </Section>
      <Section title="Contact">
        <p>Questions about this policy: {contactEmail}.</p>
      </Section>
    </LegalPage>
  )
}
