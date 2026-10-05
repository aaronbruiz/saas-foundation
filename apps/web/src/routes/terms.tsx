import { createFileRoute } from '@tanstack/react-router'
import { legalDocuments } from '../lib/legal'
import { LegalPage, Placeholder, Section } from '../lib/legal-page'

export const Route = createFileRoute('/terms')({ component: Terms })

function Terms() {
  return (
    <LegalPage doc={legalDocuments.terms}>
      <Section title="Parties">
        <Placeholder>Who provides the service and who the agreement is with.</Placeholder>
      </Section>
      <Section title="The service">
        <Placeholder>What the service is.</Placeholder>
      </Section>
      <Section title="Accounts">
        <Placeholder>Account and organization responsibilities, acceptable use.</Placeholder>
      </Section>
      <Section title="Payment">
        <Placeholder>
          Paid plans, billing and refunds. Payments are handled by Polar as merchant of record.
        </Placeholder>
      </Section>
      <Section title="Liability">
        <Placeholder>Warranties and limitation of liability.</Placeholder>
      </Section>
      <Section title="Termination">
        <Placeholder>Ending the agreement and what happens to the data.</Placeholder>
      </Section>
      <Section title="Governing law">
        <Placeholder>Governing law and jurisdiction.</Placeholder>
      </Section>
    </LegalPage>
  )
}
