# Forms

`Field` and its parts ([`field.tsx`](../../../apps/app/src/components/ui/field.tsx)), `Input`, `Textarea`, `Label`.

## Anatomy

```tsx
<form method="post" onSubmit={onSubmit}>
  <Field data-invalid={fieldError || undefined}>
    <FieldLabel htmlFor="org-name">Organization name</FieldLabel>
    <Input id="org-name" name="name" required aria-invalid={fieldError || undefined} />
    {fieldError && <FieldError>{error}</FieldError>}
  </Field>
  {error && !fieldError && <FieldError>{error}</FieldError>}
  <Button type="submit" disabled={disabled}>
    Save
  </Button>
</form>
```

Simplified from the rename form in [`t.$tenant.settings.tsx`](../../../apps/app/src/routes/t.$tenant.settings.tsx). The parts:

- `Field` is a `role="group"`; `data-invalid` styles its label and input as invalid.
- `FieldLabel` is a `<label>`; tie it to the input with `htmlFor` and `id`. Every input has a visible label.
- `FieldDescription` is help text under the label or input.
- `FieldError` renders `role="alert"`, so its text is announced when it appears; it renders nothing when empty.
- `FieldGroup`, `FieldSet` and `FieldLegend` group several fields; `FieldSeparator` divides them.
- `Input` (Base UI's input) and `Textarea` take the brand's input border, focus ring and `aria-invalid` styles.

## Rules

- `method="post"`, submit disabled until hydrated (invariant 8).
- A field error marks its field (`data-invalid` and a `FieldError` inside it) and says what to change; any other failure goes in a form-level `role="alert"`, on single-field forms too; toasts for success only (AGENTS.md "UI").
- No schema in the browser: use HTML constraints (`required`, `maxLength`, `type="email"`, `autoComplete`) and show the server's answer (ADR-0046 decision 7).

## Deciding which errors are field errors

Only the server knows why it refused. A page lists the answers that mean "this value is invalid" and marks the field for those; anything else is form-level. The settings page's `useAction(['invalid input'])` and the account deletion form's `INVALID_PASSWORD` are the models (Current).

ADR-0046's Notes list five single-field forms that didn't follow the error rule yet (account name and deletion; organization rename, transfer and delete). All five follow it in the current code (`data-invalid` with a `FieldError` in the field, other failures form-level), so that note is history. **Gap:** the project pages and the invitation page show every failure in a `FieldError` after the fields without marking a field: a form-level alert in effect, which suits operation errors but would hide which field a 400 was about. Use the settings and account forms as the model.

## What the page still does

Keep the person's input on failure (the forms don't reset on error; the create form resets only on success). Decide what happens to focus after a failed submit; no page moves it today (Not verified with a screen reader that the `role="alert"` is enough).

## Tests

E2E finds fields by label (`getByLabel('Project name')`); the keyboard pass checks the settings page's Tab order and focus indicators ([`visual/keyboard.visual.ts`](../../../apps/app/visual/keyboard.visual.ts)).
