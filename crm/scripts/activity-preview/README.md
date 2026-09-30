# Activity UI preview

From `crm`, run `npx vite --config scripts/activity-preview/vite.config.ts`, then open http://127.0.0.1:8784/.

The actual Activity components render with fictional, in-memory data. No CRM API client is loaded, mutations stay local, and opening external message links is blocked in the preview.

Use `?scenario=empty`, `client`, `error`, or `loading`; the default is `lead`. Refresh to reset edits.

Check desktop and mobile layouts, communication filters and disclosures, notes, assignment editing, lead/client controls, account-change filters, and long before/after values. Audit fixtures include pagination and structured values. This visual workspace does not replace backend validation tests.
