import { createFileRoute, Link } from '@tanstack/react-router'
import { legalDocuments, legalEntity } from '../lib/legal'
import { LegalPage, Section } from '../lib/legal-page'

export const Route = createFileRoute('/terms')({ component: Terms })

const { name, product, contactEmail, governingLaw, courts } = legalEntity

function Terms() {
  return (
    <LegalPage doc={legalDocuments.terms}>
      <Section title="Parties">
        <p>
          These terms are an agreement between {name} (&ldquo;we&rdquo;) and you, the person or
          organization using {product} (&ldquo;the service&rdquo;). By creating an account you
          accept them and confirm you can enter into a binding contract. If you use the service for
          an organization, you accept them on its behalf.
        </p>
      </Section>
      <Section title="The service">
        <p>
          {product} is a hosted application where organizations and their members manage projects.
          Sign-up may be limited to invited users, and features and plans may change.
        </p>
      </Section>
      <Section title="Accounts">
        <p>
          Keep your credentials secure; you are responsible for activity under your account.
          Organization owners and admins manage members and their roles.
        </p>
        <p>
          Don&apos;t use the service to break the law, infringe others&apos; rights, send spam,
          attack or overload it, or get around its limits or security. We may suspend accounts that
          do.
        </p>
        <p>
          You keep ownership of the content you put in the service and allow us to host and process
          it only to provide the service, as described in the{' '}
          <Link to="/privacy" className="underline">
            Privacy Policy
          </Link>
          .
        </p>
      </Section>
      <Section title="Payment">
        <p>
          Paid plans are sold by Polar as merchant of record: Polar takes payment, issues invoices
          and handles taxes and refunds under its own terms. Plans, prices and limits are shown in
          the service. If a subscription ends or its payment fails, the organization returns to the
          free plan&apos;s limits; nothing is deleted.
        </p>
      </Section>
      <Section title="Liability">
        <p>
          The service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;, without
          warranties of any kind, to the extent the law allows. To the same extent, we aren&apos;t
          liable for indirect or consequential losses, and our total liability is limited to the
          amount you paid for the service in the 12 months before the claim.
        </p>
      </Section>
      <Section title="Termination">
        <p>
          You can stop using the service at any time and ask us to delete your account at{' '}
          {contactEmail}. We may suspend or end your access if you break these terms. When an
          account or organization is deleted, its data is removed from the service, and from backups
          within 30 days.
        </p>
      </Section>
      <Section title="Governing law">
        <p>
          These terms are governed by the laws of {governingLaw}, and disputes go to {courts},
          unless the law where you live gives you the right to bring them elsewhere.
        </p>
        <p>
          We may update these terms; the version and effective date above change when we do, and we
          tell account holders by email before a significant change takes effect.
        </p>
      </Section>
    </LegalPage>
  )
}
