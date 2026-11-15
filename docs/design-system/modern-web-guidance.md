# Modern Web Guidance

Google's [Modern Web Guidance](https://developer.chrome.com/docs/modern-web-guidance) is our primary, highly trusted external reference for web-platform techniques: HTML, CSS, browser APIs, accessibility techniques and performance. It is external guidance (ADR-0047 decision 4): it informs a choice, and this repository's rules decide it. This page says when to consult it, how, and what to do when it is missing or disagrees with us. The `ui-page` skill links here.

## When to look something up

- **Look up** when choosing or checking a platform technique the design system doesn't already settle: a layout or CSS feature not used yet, a browser API, an accessibility technique for a new interaction, a performance concern.
- **Don't look up** work the repository's patterns already settle: a form built as the [saving and submitting](patterns/saving-and-submitting.md) pattern says, a dialog from `components/ui`, a copy edit, a rename, a test.

## Where it stops

Upstream advice never overrides these; adapt it within them, or record it as rejected:

| Our rule                                                                                                        | Source                                                                     | What it means for upstream advice                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser floor: Chrome and Edge 123, Firefox 128, Safari 17.5                                                    | [ADR-0046](../adr/0046-ui-foundation.md) decision 2                        | Check the explicit versions, not a Baseline label (see [compatibility](#check-compatibility-against-the-floor)). A newer feature is an enhancement whose absence keeps the required behaviour intact. |
| The CSP: no inline styles beyond four hashes, no new origins without a change                                   | [ADR-0045](../adr/0045-app-security-headers.md) decisions 4–5              | An example that sets `style`, injects a `<style>`, or loads a script, font or frame from another origin can't be copied as is. Guidance is not a reason to change the CSP.                            |
| Components from `components/ui`, Base UI's excluded components, `NativeSelect` for simple choices, brand tokens | [`AGENTS.md`](../../AGENTS.md#ui-adr-0046) "UI", ADR-0046 decisions 1, 5–6 | Advice for a native `<dialog>`, popover or `<select>` doesn't replace the chosen component. Example colours (`white`, `#ccc`) become brand tokens.                                                    |
| Forms post and stay disabled until hydrated                                                                     | [`AGENTS.md`](../../AGENTS.md#invariants-non-negotiable) invariant 8       | Vanilla DOM examples run inside React's ownership of the DOM and TanStack Start's server rendering and hydration; translate them, don't paste them.                                                   |
| The marketing site ships no scripts                                                                             | [`AGENTS.md`](../../AGENTS.md#module-map) "Module map", ADR-0033           | This workflow covers `apps/app`; the [design system's surfaces](README.md#surfaces) say what applies elsewhere.                                                                                       |

## The CLI

The package bundles its guides and search index, so an exact version is a fixed snapshot of the guidance. Use it through `pnpm dlx`; it isn't a dependency of this repository.

```sh
DISABLE_TELEMETRY=1 pnpm --silent dlx modern-web-guidance@1.0.0 search "responsive data table"
DISABLE_TELEMETRY=1 pnpm --silent dlx modern-web-guidance@1.0.0 retrieve responsive-table
DISABLE_TELEMETRY=1 pnpm --silent dlx modern-web-guidance@1.0.0 list
DISABLE_TELEMETRY=1 pnpm --silent dlx modern-web-guidance@1.0.0 --help
```

- **Every invocation** carries `DISABLE_TELEMETRY=1` and the exact version `@1.0.0`. Telemetry is on by default and sends search queries and returned guide IDs. Write queries in generic technical terms, never with user, tenant or product data.
- `search` returns a JSON list of guide IDs and descriptions; `retrieve <id>[,<id>…]` prints the guides. Read the whole guide before deciding. A retrieval larger than about 9.5 KB is written to a temporary file (`mwg-guide-<pid>-<time>.md` in the system temp directory) and the path is printed instead; read that file. Redirecting the output to a file (`> guide.md`) keeps it whole.
- Guides and scanner output print unpinned commands (`npx … modern-web-guidance@latest retrieve …`, `npx modern-web-guidance retrieve …`). Run the pinned form above instead.
- Don't run `install`, `update`, `set-allow-origin-trials` or `set-allow-volatile-features`, and don't add an `.mwgrc`: upstream skills and experimental (origin-trial or volatile) guides are out of scope. A user-level `~/.mwgrc` would still apply, so check a guide's own support section rather than assuming it describes a stable feature.
- `pnpm dlx` downloads the package on first use; it needs the network and isn't an offline tool.

## Check compatibility against the floor

Some guides end with "Fallback strategies" naming the supporting browsers and versions (`animate-to-intrinsic-sizes`: Chrome and Edge 129, not Firefox or Safari). Others, such as `responsive-table`, carry no support data. Either way:

1. List each feature the technique relies on (a CSS property, selector, at-rule, element or API).
2. Check each against Chrome and Edge 123, Firefox 128 and Safari 17.5 in [MDN](https://developer.mozilla.org/)'s compatibility table (from [browser-compat-data](https://github.com/mdn/browser-compat-data)) or [Web Platform Status](https://webstatus.dev/). "Baseline widely available" moves every month and doesn't name our versions; the version numbers do. A guide's support section is a snapshot of when the package was published.
3. Below the floor in any of them: use the feature only as an enhancement whose absence leaves the page usable and correct (the guide's fallback, or an `@supports` block), or choose another technique.

Playwright's Chromium, Firefox and WebKit are current releases: visual and e2e tests show the page works there, not at the floor.

## When guidance is missing, wrong for us or unavailable

- **Empty search** (`[]`, exit 0): rephrase once in platform terms. `list` shows every guide ID for browsing; it says nothing about compatibility.
- **Unknown guide ID**: `retrieve` exits 1 with "No guide found for use case".
- **CLI unavailable** (no network, the package fails to run) or **no relevant guide**: use the official documentation (MDN, the HTML and CSS specifications at [WHATWG](https://html.spec.whatwg.org/) and [W3C](https://www.w3.org/TR/), [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)) and the compatibility sources above.
- **Guidance conflicts with a rule** in [Where it stops](#where-it-stops): adapt it within the rule, or reject it; don't change the rule to fit it.

Record which happened in the PR's Checks.

## Modernization scan

`legacy-scan` checks code against deterministic patterns from about a fifth of the guides (upstream's estimate). Use it only for an explicitly scoped modernization assessment, read-only:

```sh
DISABLE_TELEMETRY=1 pnpm --silent dlx modern-web-guidance@1.0.0 legacy-scan apps/app/src/components/ui --json
```

- Each match comes with `keepWhen` and `dropWhen` criteria. A match is a candidate to judge against them and our rules, never an automatic fix; an intentional fallback can match.
- It scans `.tsx`, `.ts`, `.css` and other web source files, and skips documentation and test files unless given `--include-docs-and-tests`.
- Its CSS rules read stylesheets, not Tailwind classes: a `max-height` transition is found in a `.css` file but not written as `transition-[max-height]` in a component (Not verified for every rule). Most of this app's styling is Tailwind classes, so the scan sees little of it.
- Zero findings means no deterministic pattern matched, not that the code is modern. The JSON doesn't list the files it read.

## Recording a lookup

In the PR's Checks: the package version, the guide IDs (or official pages) consulted, which decision each one affected, any advice adapted or rejected and the rule that decided it, and what stays unverified (for example, support below a guide's snapshot). A lookup is evidence for a choice, not a test: the page's visual, keyboard and e2e checks (`ui-page` skill) still apply.

## Updating the version

A new version is a deliberate change to this page and the `ui-page` skill, never automatic. Repeat the smoke checks with the new version (`--help`, a `search`, a `retrieve` of a returned ID, `list`, and a `legacy-scan` of `apps/app/src/components/ui`), record their commands and exit codes in the PR, and update every pinned command. Trial of 1.0.0 (2026-11-15): all five ran with exit 0; the scan of `components/ui` (21 `.tsx` files) found nothing, and a disposable `.tsx` fixture confirmed `.tsx` files are read.
