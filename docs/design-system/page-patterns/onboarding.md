# Onboarding

**Purpose:** get a signed-in person into an organization, by creating one or by accepting an invitation. **Frame:** `AuthLayout` (Rule: AGENTS.md "UI": sign-in and onboarding pages use it).

## The landing route

`/` ([`index.tsx`](../../../apps/app/src/routes/index.tsx)) has no page of its own. Signed out → `/login`; no organization → `/orgs/new`; otherwise → the first organization's projects. The active organization only chooses this landing; it grants nothing (invariant 1).

## Create an organization

[`orgs.new.tsx`](../../../apps/app/src/routes/orgs.new.tsx): a name and a URL slug, then the organization's projects page. The slug becomes part of every URL (`/t/<slug>/…`); renaming later changes the display name only, and the settings page says so.

| State                              | Current behaviour                   |
| ---------------------------------- | ----------------------------------- |
| Slug invalid or taken              | the server's message                |
| Created                            | navigates into the new organization |
| Reached from the organization menu | the same page: "New organization"   |

Consequential defaults (research scenario 12): the creator becomes the organization's owner, and its plan is the policy's default. Neither is chosen on the form, and neither needs a warning today.

## Accept an invitation

[`invite.$id.tsx`](../../../apps/app/src/routes/invite.$id.tsx): signed out → sign-in, then back. "Join organization", "Signed in as <email>.", and "Accept invitation". All failure cases are covered in [invitations and access](../patterns/invitations-and-access.md#invitations), including why the page doesn't name the organization.

## Completion

Both paths end on the organization's projects page, where the empty state invites the first project ([collection and detail](collection-and-detail.md)). There's no welcome screen or checklist; a product that wants one adds it in its own pages.

## Tests

[`e2e/slice.spec.ts`](../../../apps/app/e2e/slice.spec.ts) (create, invite, accept, isolation), [`e2e/members.spec.ts`](../../../apps/app/e2e/members.spec.ts), [`visual/auth.visual.ts`](../../../apps/app/visual/auth.visual.ts).
