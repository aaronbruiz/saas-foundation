import { createFileRoute } from '@tanstack/react-router'
import { legalDocuments, subprocessors } from '../lib/legal'
import { LegalPage, Placeholder } from '../lib/legal-page'

export const Route = createFileRoute('/subprocessors')({ component: Subprocessors })

function Subprocessors() {
  return (
    <LegalPage doc={legalDocuments.subprocessors}>
      <p>Service providers that process data for this application.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-300">
              <th className="py-2 pr-4">Provider</th>
              <th className="py-2 pr-4">Service</th>
              <th className="py-2 pr-4">Data</th>
              <th className="py-2">Location</th>
            </tr>
          </thead>
          <tbody>
            {subprocessors.map((s) => (
              <tr key={s.service} className="border-b border-gray-200 align-top">
                <td className="py-2 pr-4">{s.name}</td>
                <td className="py-2 pr-4">{s.service}</td>
                <td className="py-2 pr-4">{s.data}</td>
                <td className="py-2">{s.location}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Placeholder>How changes to this list are announced.</Placeholder>
    </LegalPage>
  )
}
