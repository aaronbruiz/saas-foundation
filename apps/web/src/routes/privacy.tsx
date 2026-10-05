import { createFileRoute, Link } from '@tanstack/react-router'
import { legalDocuments } from '../lib/legal'
import { LegalPage, Placeholder, Section } from '../lib/legal-page'

export const Route = createFileRoute('/privacy')({ component: Privacy })

function Privacy() {
  return (
    <LegalPage doc={legalDocuments.privacy}>
      <Section title="Who we are">
        <Placeholder>The data controller&apos;s identity and contact details.</Placeholder>
      </Section>
      <Section title="Data we collect">
        <Placeholder>Categories of personal data and where they come from.</Placeholder>
      </Section>
      <Section title="How we use it">
        <Placeholder>Purposes of processing and their legal basis.</Placeholder>
      </Section>
      <Section title="Who we share it with">
        <p>
          Service providers that process data for us are listed on the{' '}
          <Link to="/subprocessors" className="underline">
            Subprocessors
          </Link>{' '}
          page.
        </p>
        <Placeholder>International transfers and the safeguards that apply.</Placeholder>
      </Section>
      <Section title="Retention">
        <Placeholder>How long each category of data is kept.</Placeholder>
      </Section>
      <Section title="Your rights">
        <Placeholder>Data subject rights and how to exercise them.</Placeholder>
      </Section>
      <Section title="Contact">
        <Placeholder>How to contact us about privacy.</Placeholder>
      </Section>
    </LegalPage>
  )
}
