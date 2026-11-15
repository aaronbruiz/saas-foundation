# Selection

**Rule:** a simple single choice in a form is `NativeSelect`; Base UI's `Select` is for rich options, grouping, search or custom interaction (AGENTS.md "UI", ADR-0046 decision 6).

## NativeSelect

[`native-select.tsx`](../../../apps/app/src/components/ui/native-select.tsx): a real `<select>` with the brand's styling and a chevron, sizes `default` and `sm`, `NativeSelectOption` and `NativeSelectOptGroup`.

- **Why native:** it submits with the form without script, the platform handles keyboard and screen readers, and it renders no inline style the CSP would refuse. Where the browser supports customizable selects (`appearance: base-select`: Chromium 135+, Safari 27), its picker takes the brand tokens (`styles.css`); elsewhere, such as Firefox, the operating system's list.
- **Example:** the ownership transfer picker in [`t.$tenant.settings.tsx`](../../../apps/app/src/routes/t.$tenant.settings.tsx), with a `FieldLabel` and the field error rule like any input.
- **Tested:** the keyboard pass moves through its options with the arrow keys and closes it with Escape (Chromium; arrow keys also Firefox; Playwright's WebKit can't drive the native popup). WebKit refuses its own stylesheet for a native select under the CSP: the one allowed exclusion in visual tests, once per page URL, watched by a canary test ([`docs/testing.md`](../../testing.md)).

## Select

[`select.tsx`](../../../apps/app/src/components/ui/select.tsx): Base UI's select with a trigger, positioned popup, groups, labels, separators and scroll buttons. **Available, not used by any page**, so its CSP and keyboard behaviour in this app are unverified. A first use adds it to the visual and keyboard tests (the `ui-page` skill). It wasn't used for the transfer picker because that would change the isolation test `e2e/slice.spec.ts` (ADR-0046 "Alternatives").

## Choosing

| Need                                                         | Use                                                                                       |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| One value from a short or medium list, in a form             | `NativeSelect`                                                                            |
| Options with descriptions, icons or custom rendering; search | `Select`                                                                                  |
| A command, not a value (Rename, Delete, Sign out)            | a menu ([navigation](navigation.md)), not a select                                        |
| Two or three mutually exclusive options always visible       | radio buttons: not implemented yet ([components](README.md#excluded-and-not-implemented)) |
