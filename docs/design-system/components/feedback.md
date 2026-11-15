# Feedback

How the app tells someone what happened: toasts, inline status and alerts, loading placeholders and tooltips.

## Choosing

| What happened                                    | Use                                                                                                       | Rule or example                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| An action succeeded and its effect isn't obvious | a toast (`toast.success`)                                                                                 | Rule: toasts for success only (AGENTS.md "UI"). "Name saved."       |
| An action succeeded and the page shows it        | nothing extra; the changed page is the feedback                                                           | creating a project shows it in the list                             |
| A result that replaces the form                  | a `role="status"` paragraph                                                                               | sign-up: "We sent a verification link to …"                         |
| Invalid input                                    | a `FieldError` in the field ([forms](forms.md))                                                           | Rule: AGENTS.md "UI"                                                |
| Any other failure                                | a form-level `role="alert"`                                                                               | Rule: AGENTS.md "UI"                                                |
| The page can't load                              | the router's error page or the not-found page ([errors and recovery](../patterns/errors-and-recovery.md)) | `lib/error-page.tsx`, `__root.tsx` `NotFound`                       |
| Waiting                                          | disable the action and say what's happening                                                               | [loading and empty states](../patterns/loading-and-empty-states.md) |

## Toaster

[`sonner.tsx`](../../../apps/app/src/components/ui/sonner.tsx) renders one `Toaster` in the root with icons per type and the brand's popover colours. sonner injects a `<style>` element, which the CSP allows by its two exact hashes (ADR-0045 decision 5; a sonner bump regenerates them with `pnpm csp:hashes`).

Toasts disappear and don't take focus: the keyboard pass checks that the rename toast appears without moving focus. So a toast never carries something the person must act on or read later, and never an error. Primer, the design system's model, avoids toasts altogether for accessibility reasons ([Primer saving](https://primer.style/product/ui-patterns/saving/), read 2026-11-15); this app keeps them for success only, per its rule. Whether a toast is announced by screen readers is **not verified**.

## Alerts and status

There is no `Alert` component (**not implemented**). A form-level alert is a `FieldError` outside any field, or a `<p role="alert">` with `text-destructive` (the invite page, the Turnstile widget). A status is a `<p role="status">`. `role="alert"` is announced at once and interrupts; `role="status"` politely, without moving focus (WCAG 4.1.3, [Understanding status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)). Render the element when the message appears, so the change is announced.

## Skeleton

[`skeleton.tsx`](../../../apps/app/src/components/ui/skeleton.tsx), a pulsing muted block: available, unused. Loaders run on the server and pages render with their data, so most pages never show a loading state; a skeleton is for content fetched after the page renders.

## Tooltip

[`tooltip.tsx`](../../../apps/app/src/components/ui/tooltip.tsx): the provider is in the root; no page shows a tooltip. A tooltip only adds to a control that already has a visible or accessible name; it appears on hover and focus, never on touch alone, so nothing essential goes in one, and it never explains a disabled control by itself (a disabled control isn't focusable).
