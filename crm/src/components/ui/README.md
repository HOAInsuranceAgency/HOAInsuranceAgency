# Shared CRM controls

Import controls from this directory rather than rendering native `button`, `input`,
`select`, `textarea`, or `table` elements in feature components.

```tsx
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Field } from './ui/Field';
import { Table } from './ui/Table';

<Field label="Effective date" help="Use the policy's effective date.">
  {control => <Input {...control} type="date" required value={date} onChange={event => setDate(event.target.value)} />}
</Field>
<Button type="submit" variant="primary">Save</Button>
```

- `Input`, `Select`, and `Textarea` preserve native props, events, validation and
  refs. Checkbox/radio/file inputs retain native behavior; use `FilePicker` for
  a styled upload action. Use `ButtonLink` for navigation and `ButtonSummary`
  for a native disclosure rather than changing their semantics to buttons.
- `controlSize="standard"` is 14px / 38px and `compact` is 13px / 32px.
  Narrow or coarse-pointer surfaces use 16px / 44px. `size` and `rows` retain
  their native meanings; visual density never replaces these attributes.
- `Table` supplies compact density to nested controls. An explicit
  `controlSize` overrides inherited density. Use `ControlSizeProvider` for
  other compact surfaces; do not recreate the recipe in descendant CSS.
- `Tabs` switches between panels; pair it with `TabPanel`. `SegmentedControl`
  filters a view, and `SegmentedRadioControl` retains native radio form values.
- `Field` composes one labeled control, optional help and an error. Spread its
  render-prop attributes onto the actual control, including formatted inputs;
  it does not inspect or clone children. IDs are unique and stable by default.
  Pass `id` to preserve an existing control ID and `describedBy` for external
  descriptions. Help and errors are connected through `aria-describedby`, and
  errors set `aria-invalid`. Keep validation and save behavior in the form.
  Checkbox collections retain their individual native labels and group semantics.
- `SuggestionList` and `SuggestionOption` style app-owned combobox suggestions.
  The owner keeps keyboard navigation, focus and `aria-activedescendant`;
  options receive `aria-selected`. Google Places and browser datalist popups
  remain provider-owned controls.
- Feature `className` and CSS may arrange controls using width, position,
  spacing and layout. Visual recipes, including font, color, padding, border,
  background, height, focus, hover and disabled states, belong here. Add a
  shared variant when needed. Keep content/status and icon styling on their
  own descendants rather than overriding the control root.
- Inline `style` on shared controls must contain explicit layout-only keys,
  such as `minWidth` or `marginTop`. Property values may be dynamic. Visual
  properties and unknown style objects, spreads or computed keys are rejected by
  the guard; use a shared variant or an explicit layout class instead.
  The primitives still forward native `style` props unchanged at runtime.

Run the architecture checks from `crm`:

```sh
npx vitest run src/components/ui/ControlArchitecture.test.ts
```

The guard checks production JSX with TypeScript's AST and CSS with PostCSS.
It also follows static custom classes on shared controls, so a feature class
cannot silently introduce a second visual recipe.
