# Components

The app's components are shadcn's, on Base UI (`@base-ui/react`, pinned exactly; 1.9.0 when this was written), copied into [`apps/app/src/components/ui/`](../../../apps/app/src/components/ui/) and owned by this repository ([ADR-0046](../../adr/0046-ui-foundation.md) decision 1). They take data through props only: no `modules/`, `server/`, routes or contracts (lint). Read the local file before relying on upstream documentation: the copy can differ from shadcn's current version and from Base UI's defaults.

## Inventory

Every file in `components/ui/`, once. **Used** means a page or the root renders it; **available** means it exists but no page uses it yet, so its behaviour in this app is unverified.

| File                                                                         | Exports (main)                                                                       | Base UI part             | Status                                             | Guide                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------ | -------------------------------------------------- | ---------------------------------------------------- |
| [`alert-dialog.tsx`](../../../apps/app/src/components/ui/alert-dialog.tsx)   | `AlertDialog` and its parts                                                          | `alert-dialog`           | used: settings (ownership transfer)                | [dialogs](dialogs.md)                                |
| [`auth-layout.tsx`](../../../apps/app/src/components/ui/auth-layout.tsx)     | `AuthLayout`, `authInlineLink`, `authStandaloneLink`                                 | none                     | used: every auth and onboarding page               | [authentication](../page-patterns/authentication.md) |
| [`badge.tsx`](../../../apps/app/src/components/ui/badge.tsx)                 | `Badge`                                                                              | `use-render`             | used: members (roles)                              | [data display](data-display.md)                      |
| [`button.tsx`](../../../apps/app/src/components/ui/button.tsx)               | `Button`, `buttonVariants`                                                           | `button`                 | used: most pages                                   | [buttons](buttons.md)                                |
| [`card.tsx`](../../../apps/app/src/components/ui/card.tsx)                   | `Card` and its parts                                                                 | none                     | used: tenant pages, account, auth frame            | [data display](data-display.md)                      |
| [`dialog.tsx`](../../../apps/app/src/components/ui/dialog.tsx)               | `Dialog` and its parts                                                               | `dialog`                 | available                                          | [dialogs](dialogs.md)                                |
| [`dropdown-menu.tsx`](../../../apps/app/src/components/ui/dropdown-menu.tsx) | `DropdownMenu` and its parts                                                         | `menu`                   | available                                          | [navigation](navigation.md)                          |
| [`empty.tsx`](../../../apps/app/src/components/ui/empty.tsx)                 | `Empty` and its parts                                                                | none                     | available (pages use a muted paragraph instead)    | [data display](data-display.md)                      |
| [`field.tsx`](../../../apps/app/src/components/ui/field.tsx)                 | `Field`, `FieldLabel`, `FieldDescription`, `FieldError`, `FieldGroup`, `FieldSet`, … | none                     | used: every form                                   | [forms](forms.md)                                    |
| [`input.tsx`](../../../apps/app/src/components/ui/input.tsx)                 | `Input`                                                                              | `input`                  | used: every form                                   | [forms](forms.md)                                    |
| [`label.tsx`](../../../apps/app/src/components/ui/label.tsx)                 | `Label`                                                                              | none                     | used through `FieldLabel`                          | [forms](forms.md)                                    |
| [`native-select.tsx`](../../../apps/app/src/components/ui/native-select.tsx) | `NativeSelect`, `NativeSelectOption`, `NativeSelectOptGroup`                         | none (native `<select>`) | used: settings (transfer picker)                   | [selection](selection.md)                            |
| [`popover.tsx`](../../../apps/app/src/components/ui/popover.tsx)             | `Popover` and its parts                                                              | `popover`                | available (the organization menu uses `<details>`) | [navigation](navigation.md)                          |
| [`select.tsx`](../../../apps/app/src/components/ui/select.tsx)               | `Select` and its parts                                                               | `select`                 | available                                          | [selection](selection.md)                            |
| [`separator.tsx`](../../../apps/app/src/components/ui/separator.tsx)         | `Separator`                                                                          | `separator`              | used through `FieldSeparator`                      | [data display](data-display.md)                      |
| [`skeleton.tsx`](../../../apps/app/src/components/ui/skeleton.tsx)           | `Skeleton`                                                                           | none                     | available                                          | [feedback](feedback.md)                              |
| [`sonner.tsx`](../../../apps/app/src/components/ui/sonner.tsx)               | `Toaster`                                                                            | none (`sonner`)          | used: root; toasts from settings                   | [feedback](feedback.md)                              |
| [`table.tsx`](../../../apps/app/src/components/ui/table.tsx)                 | `Table` and its parts                                                                | none                     | used: subprocessors (legal)                        | [data display](data-display.md)                      |
| [`tabs.tsx`](../../../apps/app/src/components/ui/tabs.tsx)                   | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`                                     | `tabs`                   | available                                          | [navigation](navigation.md)                          |
| [`textarea.tsx`](../../../apps/app/src/components/ui/textarea.tsx)           | `Textarea`                                                                           | none                     | available                                          | [forms](forms.md)                                    |
| [`tooltip.tsx`](../../../apps/app/src/components/ui/tooltip.tsx)             | `Tooltip`, `TooltipTrigger`, `TooltipContent`, `TooltipProvider`                     | `tooltip`                | provider in the root; no page shows a tooltip      | [feedback](feedback.md)                              |

## Excluded and not implemented

| What                                                                 | Status                                                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Base UI slider, progress, meter, scroll-area, accordion, collapsible | **excluded** by lint, with the package root that re-exports them (ADR-0046 decision 5)         |
| A shared `Alert` (banner) component                                  | not implemented: form-level alerts are a `FieldError` (`role="alert"`) or a `<p role="alert">` |
| Checkbox, radio, switch                                              | not implemented; no page needs one yet                                                         |
| A spinner or progress indicator                                      | not implemented (progress is excluded); pending state is worded or the button is disabled      |
| Pagination, breadcrumbs, a page-header or page-layout component      | not implemented; frames are per page ([page patterns](../page-patterns/README.md))             |

A Base UI component that upstream supports isn't available here until it's copied in (`components.json`), passes the CSP in e2e and visual tests, and its colour pairs are in the contrast list. Adding one is a UI change; an excluded one needs ADR-0046's deferred decision first.

## Guides

[Buttons](buttons.md) · [Forms](forms.md) · [Selection](selection.md) · [Dialogs](dialogs.md) · [Navigation](navigation.md) · [Feedback](feedback.md) · [Data display](data-display.md)

Each guide says when to use the component and what else to consider, its variants and states, what it guarantees and what the page still has to do, a real example and its tests, and known gaps.
