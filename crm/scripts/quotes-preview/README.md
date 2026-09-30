# Quotes UI preview

From `crm`, run `npx vite --config scripts/quotes-preview/vite.config.ts`, then open http://127.0.0.1:8783/.

This renders the actual Quotes and Package options components with fictional, in-memory records. It does not load the CRM API client or send messages.

Use `?scenario=populated`, `selected`, `estimates`, `error`, or `loading`; the default is `empty`. Add `&estimate=ready` to include a fictional Honeycomb indication. Refreshing resets edits.

Check desktop and mobile layouts, package editing and selection, estimate saving, quote creation, status controls, and authorization/bind panels. The fixture operations support visual checks; they do not replace backend validation tests.
