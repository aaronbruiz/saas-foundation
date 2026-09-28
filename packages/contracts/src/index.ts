// Zod schemas shared by UI and server (AGENTS.md invariant 9). organizationId is never an input
// field: the tenant comes from the `tenant` slug, verified server-side (invariant 1).
import { z } from 'zod'

export const TenantSlug = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lowercase letters, digits and dashes')

export const ProjectId = z.uuid()

// strictObject: unknown keys (e.g. organizationId) are rejected, not silently stripped.
export const ProjectFields = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
})

export const TenantInput = z.strictObject({ tenant: TenantSlug })
export const ProjectRef = z.strictObject({ tenant: TenantSlug, id: ProjectId })
export const CreateProjectInput = z.strictObject({ tenant: TenantSlug, project: ProjectFields })
export const UpdateProjectInput = z.strictObject({
  tenant: TenantSlug,
  id: ProjectId,
  project: ProjectFields.partial(),
})

export const CreateOrganizationInput = z.strictObject({
  name: z.string().trim().min(1).max(120),
  slug: TenantSlug,
})
export const InviteMemberInput = z.strictObject({
  tenant: TenantSlug,
  email: z.email(),
  role: z.enum(['member', 'admin']).default('member'),
})
export const AcceptInvitationInput = z.strictObject({ invitationId: z.string().min(1) })
