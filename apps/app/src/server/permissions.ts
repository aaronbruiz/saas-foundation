import { HttpError } from './errors'
import type { TenantContext } from './context'

/**
 * Role → capability matrix for the app's own server functions (ADR-0005: authorization is ours).
 * Better Auth's `/api/auth/organization/*` endpoints enforce its default roles separately; keep the
 * two consistent (owner/admin invite, only the owner deletes the organization).
 */
export const CAPABILITIES = [
  'project:read',
  'project:create',
  'project:update',
  'project:delete',
  'member:read',
  'member:invite',
  'billing:read',
  'billing:manage',
] as const
export type Capability = (typeof CAPABILITIES)[number]

// Members read, create and update projects; deleting (hard, no audit trail) and inviting are
// owner/admin only (owner decision 2026-09-28). Every member sees the member list; pending
// invitations and revoking one go with `member:invite` (owner decision 2026-10-29). Billing (ADR-0020): owner and admin see the plan
// and usage; only the owner, who also alone can delete the organization, starts or changes a paid
// subscription.
const MATRIX = {
  owner: CAPABILITIES,
  admin: CAPABILITIES.filter((c) => c !== 'billing:manage'),
  member: ['project:read', 'project:create', 'project:update', 'member:read'],
} as const satisfies Record<string, readonly Capability[]>

/**
 * Capabilities of a Better Auth `member.role`. It may hold several comma-separated roles; the
 * result is their union. Unknown roles grant nothing (fail closed).
 */
export function capabilitiesOf(role: string): Capability[] {
  const granted = new Set<Capability>()
  for (const r of role.split(',').map((s) => s.trim()))
    if (Object.hasOwn(MATRIX, r)) for (const c of MATRIX[r as keyof typeof MATRIX]) granted.add(c)
  return CAPABILITIES.filter((c) => granted.has(c))
}

export const can = (role: string, capability: Capability) =>
  capabilitiesOf(role).includes(capability)

/**
 * 403 for a member whose role lacks `capability` (AGENTS.md invariant 5). Call it only with a
 * context from `getTenantContext`, which already returned 404 for anyone outside the tenant.
 */
export function authorize(ctx: TenantContext, capability: Capability): void {
  if (!can(ctx.role, capability)) throw new HttpError(403, 'forbidden')
}
