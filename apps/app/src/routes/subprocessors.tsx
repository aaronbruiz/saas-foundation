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

/** Cells wrap their text, so the table fits narrow screens instead of scrolling. */
const cell = 'align-top whitespace-normal'

function Subprocessors() {
  return (
    <LegalPage doc={legalDocuments.subprocessors}>
      <p>Service providers that process data for this application.</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Provider</TableHead>
            <TableHead>Service</TableHead>
            <TableHead>Data</TableHead>
            <TableHead>Location</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {subprocessors.map((s) => (
            <TableRow key={s.service}>
              <TableCell className={cell}>{s.name}</TableCell>
              <TableCell className={cell}>{s.service}</TableCell>
              <TableCell className={cell}>{s.data}</TableCell>
              <TableCell className={cell}>{s.location}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Placeholder>How changes to this list are announced.</Placeholder>
    </LegalPage>
  )
}
