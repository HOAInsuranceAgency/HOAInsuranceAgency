# CRM interaction kit

Use these patterns when adding or changing CRM screens. Shared appearance lives in `src/ui.css`; retain the existing color, type, spacing, badge, modal, formatted-input, and `SaveStatus` primitives.

## Page and navigation contract

- Start with the task, a short read-only summary, and the next useful action. Put optional editors and maintenance behind `Disclosure` or a focused subview.
- Use `SectionNav` for page sections: desktop buttons and a labeled mobile select share the same state. Derive linkable view state from the URL.
- Use real `Link` elements for record names. Carry the originating list URL in `state.from`, and preserve it when changing record subviews. Include a `Breadcrumb` back to results.
- Use `Pagination` and `useListPage` for bounded presentation. Keep backend continuation/loading separate and describe whether the count covers loaded results or the entire dataset. Exports cover the full filtered dataset, not just the displayed page.

## Forms

```tsx
<Field>
  <label>Annual premium</label>
  <MoneyInput value={form.premium} onChange={value => setF("premium", value)} />
</Field>
```

- `Field` connects a direct label and control with a stable ID. Custom controls must forward `id` to their input. Groups without one control receive a group label; each checkbox/radio still needs its own label. Add help/error IDs and `aria-describedby` explicitly where needed.
- Use the shared money, number, date, phone, percentage, and FEIN inputs. Keep storage values numeric/unformatted according to the existing model contract.
- Use `useFormState` and a visible save boundary. Call `markSaved` only after persistence succeeds; clear dirty state before navigating. A failed save must retain the draft. Use `useDirtyForm` for editors that need their own state model.
- The app's `DirtyFormsProvider` guards route/query changes and browser departure. Custom local view switches that unmount an editor must call `confirmDiscard`. `Disclosure` already does so when closing; it lazily mounts its content.
- Use `StatusEditor` for quote/policy status changes. Selection edits a draft; only **Save status** writes. Keep binding, cancellation, and other business authorization/validation in the existing mutation path.
- Do not use a filtering control as a write destination. Document upload association is explicit and independent of the library filter.

## Lists, responsiveness, and read states

- Default working views to a small set of identity/action/owner/date columns. Put secondary data in details or an explicitly selected report.
- `stacked-table` uses `data-label` on each cell to become record cards at phone widths. Hidden mobile headers must not leave invisible keyboard controls. Every sortable card/table view must include `MobileSort` from `lib/useSort`, with the same keys, direction, and toggle handler as its desktop `SortTh` controls. Include any default sort key even when it has no visible desktop column.
- Use `SortTh` for keyboard-operable sorting and `aria-sort`. `useSort` optionally accepts controlled sort state for URL-backed views.
- Distinguish loading, failed, empty, incomplete, and zero. Use `LoadingState`, local retry, and completeness labels. Do not hide valid independent sections because another query failed.
- Cache only named, read-only resources with an appropriate expiry. The overview cache is memory-only, clears on sign-out, and has an explicit refresh/freshness label.
- Verify a changed working view at 390px and 1280px, including long names and expanded controls. Analytical reports may scroll within their container; routine agent workflows should fit without whole-page horizontal overflow.

The local fixture preview is documented in `scripts/crm-ux-preview/README.md`. Shared behavior regression tests are in `kit.test.tsx`; they cover naming, keyboard sorting, draft/save/cancel, controlled sorting, and unsaved navigation.
