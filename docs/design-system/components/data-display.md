# Data display

Cards, lists, tables, badges, empty states and separators.

## Card

[`card.tsx`](../../../apps/app/src/components/ui/card.tsx): `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`, `CardContent`, `CardFooter`. A card groups one form or one set of facts: the "New project" form, the billing summary, each settings section (with `ring-destructive/40` in the danger zone), and the auth frame on wider screens. Put the section's heading element inside `CardTitle` at the right outline level ([typography](../foundations/typography.md)).

## Lists

Collections are plain lists today (Current):

- **Projects:** a `<ul>` of links, one row each, 44 px tall, with the card's surface and dividers ([`t.$tenant.projects.index.tsx`](../../../apps/app/src/routes/t.$tenant.projects.index.tsx)).
- **Members and invitations:** a list of rows with the email, a role `Badge`, and row actions ([`t.$tenant.members.tsx`](../../../apps/app/src/routes/t.$tenant.members.tsx)).

## Table

[`table.tsx`](../../../apps/app/src/components/ui/table.tsx): semantic `<table>` parts, with a caption. Used for the subprocessors list on a legal page. Use a table when people compare values across columns; give it a `TableCaption` or a heading it's labelled by. Its container scrolls sideways when the table is wider than the screen, so the page itself doesn't. No sorting, selection or pagination is implemented.

## Badge

[`badge.tsx`](../../../apps/app/src/components/ui/badge.tsx), variants `default`, `secondary`, `destructive`, `outline`, `ghost`, `link`: a short label next to something, such as a member's role. Its text carries the meaning; the colour only reinforces it. A badge rendered as a link (`render`) gets the link's focus and hover styles.

## Empty states

[`empty.tsx`](../../../apps/app/src/components/ui/empty.tsx) (`Empty`, `EmptyHeader`, `EmptyMedia` with variants `default` and `icon`, `EmptyTitle`, `EmptyDescription`, `EmptyContent`): available, unused. The pages show a muted sentence instead: "No projects yet.", "No pending invitations." What to say depends on why the list is empty ([loading and empty states](../patterns/loading-and-empty-states.md)); the component doesn't decide that.

## Separator

[`separator.tsx`](../../../apps/app/src/components/ui/separator.tsx), Base UI's separator, used inside `FieldSeparator`. Decorative separators shouldn't be announced; the Base UI part sets its role.
