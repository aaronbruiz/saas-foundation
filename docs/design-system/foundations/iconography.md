# Iconography

**Source:** `lucide-react` (1.70.0 installed when this was written), imported by name.

## In use (Current)

Icons appear in components, not page copy: chevrons and checks in the select, native select and dropdown menu, the close `X` in the dialog, the status icons and spinner in the toaster, and one chevron in the tenant's organization menu. No page uses an icon as its only label.

## Decorative versus meaningful

- **Decorative** (next to text that already says it): hide it from assistive technology with `aria-hidden="true"`, as the organization menu's chevron does. Lucide's React components render an `svg` without a text alternative.
- **Meaningful on its own** (an icon-only button): the control needs an accessible name, `aria-label` or visually hidden text, like the dialog's close button. `Button` has icon sizes (`icon`, `icon-sm`, …) for these; none is used by a page today.

Icons inside `Button` and `Badge` are sized by the component (`size-4`, `size-3`) and don't take pointer events; don't size them per page.

## Not settled

No icon list, no rule on when to add one. Status in the app is worded, not iconographic; keep it that way unless a pattern page says otherwise.
