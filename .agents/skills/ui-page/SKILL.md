---
name: ui-page
description: Build or change a page in apps/app on the UI foundation (ADR-0046) and prove it with visual, keyboard and e2e checks. Use for any new page, a page's layout, forms, errors, dialogs or navigation.
---

# Build or change a page

Trial skill (ADR-0042 Notes). A procedure: the rules are in `AGENTS.md` "UI (ADR-0046)", "Module map" and invariant 8, the CSP in ADR-0045, the tests in `docs/testing.md`. A product's brand rules are in its `docs/product/AGENTS.md`.

## 1. Before

- Read those rules and the page's spec (the PR description; `feature-spec` writes one).
- Take a visual baseline at `main`: `scripts/test-lock.sh visual --baseline`. It takes about 12 minutes and loads the machine: start it when the load average (`cat /proc/loadavg`) is below about 3.

## 2. Build

- Pick the page's frame: `AuthLayout` for sign-in and onboarding, the tenant shell (`t.$tenant.tsx`) for tenant pages, the account or legal page's frame otherwise. Don't copy a frame's classes into the page.
- Use `components/ui` and the brand tokens; `NativeSelect` for a simple choice; contract types only (`import type`).
- Forms: `method="post"`, submit disabled until hydrated (`useHydrated`), the server's errors placed as `AGENTS.md` "UI" says (a field error at its field, any other failure in a form-level alert, toasts for success only).
- A destructive action that needs confirming: an `AlertDialog` whose final action is `destructiveSolid`; the page's own button stays tinted.
- A new colour pair (a new variant or surface): add it to `scripts/brand-contrast.mjs`.

## 3. Visual and keyboard tests

- Add the page to its file in `apps/app/visual/` (`auth.visual.ts`, `tenant.visual.ts`, `account.visual.ts`), which takes it at 320 and 1280 px in both themes.
- Mask text that changes every run (a signed-in email, an organization's name, Turnstile's host element). Wait for hydration on an enabled control with `hydrated`.
- List the form's own controls in reading order (`controls`) for the keyboard pass. Every focus stop must show an indicator.
- A dialog: Tab stays inside it. At the wrap, Base UI's focus guard holds focus for a moment, so wait for focus to settle (`expect.poll`) before checking. Escape and Cancel close it and return focus to the button that opened it.
- WebKit's own `<select>` refusals are allowed once per page URL (`allowWebKitSelect`): don't reload a page with a `<select>` in a test; check the result on another page.
- `visual/team.setup.ts` uses fixed accounts: changing one changes other pages' screenshots. Say so in Checks.

## 4. Compare and look

- `scripts/test-lock.sh visual --compare`. Open every changed screenshot (`apps/app/test-results/*/*-actual.png`, with `-expected` and `-diff`) and say in Checks what you saw.
- A change under the 1% diff threshold isn't reported as changed (an icon, a moved footer). For those, look at the page's own screenshots: run `--baseline` into a copy (keep `main`'s `.baseline/` aside and restore it), or screenshot the state from a temporary, uncommitted test.

## 5. e2e

- Select by role and accessible name. When a name repeats behind a dialog, scope to the `alertdialog`.
- Cover each Behaviour line, its failure case included. A changed or corrected test gets its reason in Checks (`AGENTS.md` "Working rules").

## 6. When a run fails

- e2e and visual runs time out under load from other work on the machine (hydration waits, the 60 s test timeout). Read the load average and rerun once before diagnosing; report both runs.
- The first run after a new dependency can hit a stale Vite cache; `vite.config.ts` pre-bundles every Base UI subpath the source imports.

## 7. Checks

Record the compare summary line (baseline commit, N compared, M changed), what was looked at by eye, the keyboard and e2e results, and what stays unverified, each with the commits it ran on.
