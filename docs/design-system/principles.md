# Principles

Each principle explains rules that already exist; the rule's source is in brackets. None of them is a rule on its own.

## The server decides; the interface explains

A hidden button is a courtesy, not a control. Pages read the member's capabilities to hide actions they can't take (`getTenant` in the tenant layout), and every server function checks again ([invariant 4](../../AGENTS.md#invariants-non-negotiable)). So a page must still handle the server's 403 and 404 for an action it showed, because roles change while a page is open. Explanations must not leak what the server hides: another tenant's resources, unknown tenants and non-members all look like "not found" (invariant 5).

## Say what happened, including when you don't know

A person should be able to tell whether an action worked, failed, or may have worked. Field errors say what to fix at the field; any other failure is a form-level alert; success is a toast or the visible result (AGENTS.md "UI"). When the app can't know the outcome (a lost response after a write, a payment completed elsewhere), it says so rather than guessing: the account deletion form is the model ("We couldn't confirm your account was deleted. Try signing in again to check.", [`account.tsx`](../../apps/app/src/routes/account.tsx)). See [saving and submitting](patterns/saving-and-submitting.md).

## Friction in proportion to consequence

Where the app asks for confirmation, it's for an action that can't be undone or that hands over control (ownership transfer, organization and account deletion); an ordinary save needs none. Which irreversible actions must be confirmed isn't a settled rule ([destructive actions](patterns/destructive-actions.md)). The strongest visual signal, the solid destructive button, is reserved for the final step of such a confirmation (AGENTS.md "UI", `destructiveSolid`). Typing the organization's name to delete it is the heaviest friction the app uses. WCAG 3.3.4 asks for reversible, checked or confirmed submissions for legal and financial transactions, not a dialog for everything ([WCAG 2.2 Understanding 3.3.4](https://www.w3.org/WAI/WCAG22/Understanding/error-prevention-legal-financial-data.html)). See [destructive actions](patterns/destructive-actions.md).

## Tokens, not colours

Pages use the brand's semantic tokens (`bg-background`, `text-muted-foreground`, …), never raw colours, so a product can rebrand in one file and both system themes keep their tested contrast (AGENTS.md "UI", ADR-0046 decisions 2–3). See [color](foundations/color.md).

## Within the CSP, by construction

The app's Content Security Policy allows no inline style except four generated hashes. A component that can't render under it isn't used: that's why six Base UI components are excluded and why pages never use `style` (ADR-0045 decision 5, ADR-0046 decisions 4–5). See [accessibility](foundations/accessibility.md#csp-and-what-it-rules-out).

## Keep the browser simple and safe

Forms post (`method="post"`) and stay disabled until React has hydrated, so a password never ends up in a URL; the browser gets no schemas and no secrets, and the server's validation is the one that counts (invariant 8, ADR-0046 decision 7). Client-side constraints such as `required` and `maxLength` help the person typing; they don't protect anything.

## Prove it in both themes, at both sizes, by keyboard

A page is checked at 320 and 1280 px, light and dark, in three browser engines, with a keyboard pass, before it changes (ADR-0046 decision 8, the `ui-page` skill). What the checks don't cover, they don't prove: no assistive-technology testing has been done ([accessibility](foundations/accessibility.md)).
