import { parseInput } from './errors'

/** Server-function boundary validator (invariant 9): same contract + 400/404 mapping as services. */
export const validateWith =
  <T>(schema: Parameters<typeof parseInput<T>>[0]) =>
  (data: unknown): T =>
    parseInput(schema, data)
