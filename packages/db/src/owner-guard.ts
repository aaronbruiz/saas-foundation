/** The `member_keeps_owner` trigger's refusal (ADR-0043), through any wrapper's `cause`. */
export function isOwnerGuardViolation(error: unknown): boolean {
  for (let e = error; e instanceof Object; e = (e as { cause?: unknown }).cause) {
    const { code, constraint } = e as { code?: unknown; constraint?: unknown }
    if (code === '23514' && constraint === 'member_keeps_owner') return true
  }
  return false
}
