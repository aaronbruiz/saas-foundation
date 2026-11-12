import { createFileRoute } from '@tanstack/react-router'
import { legalDocuments, subprocessors } from '../lib/legal'
import { LegalPage, Placeholder } from '../lib/legal-page'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export const Route = createFileRoute('/subprocessors')({ component: Subprocessors })

/** Cells wrap their text. Below `sm` a stacked list replaces the table (same data). */
const cell = 'align-top whitespace-normal'

const columns = [
  ['Provider', 'name'],
  ['Service', 'service'],
  ['Data', 'data'],
  ['Location', 'location'],
] as const

function Subprocessors() {
  return (
    <LegalPage doc={legalDocuments.subprocessors}>
      <p>Service providers that process data for this application.</p>
      <div className="hidden sm:block">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map(([label]) => (
                <TableHead key={label}>{label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {subprocessors.map((s) => (
              <TableRow key={s.service}>
                {columns.map(([label, key]) => (
                  <TableCell key={label} className={cell}>
                    {s[key]}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-col gap-4 sm:hidden">
        {subprocessors.map((s) => (
          <dl key={s.service} className="flex flex-col gap-1 rounded-lg border p-4 text-sm">
            {columns.map(([label, key]) => (
              <div key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="break-words">{s[key]}</dd>
              </div>
            ))}
          </dl>
        ))}
      </div>
      <Placeholder>How changes to this list are announced.</Placeholder>
    </LegalPage>
  )
}
