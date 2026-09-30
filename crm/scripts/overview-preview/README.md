# Overview UI preview

From `crm`, run `npx vite --config scripts/overview-preview/vite.config.ts`, then open http://127.0.0.1:8786/.

The production Overview, Contacts and Property/Photos components render with fictional in-memory data. Account saves, contact CRUD and primary selection, and photo upload/remove update only local state. Refresh resets everything. Storage is local blob/data URLs; the production modal shell shows a fictional placeholder when previewing files. Address autocomplete is a plain editable input and never loads Google Places. No CRM API, cloud storage, Google, email or external messaging request runs.

Use `?scenario=empty`, `client`, `error`, or `loading`; the default is populated. Error fails the first contact read and each kind of first write so saved input can be retried. Loading leaves contact and thumbnail reads pending; account fields are already loaded in this component-level preview.

Check desktop and mobile layouts, long legal names and contact emails, details/property saves, contact validation and CRUD/primary selection, coastal fields, and photo upload/replace/remove. Shared enums, form codecs, account validation and input components use the production modules. Account validation is imported from a pure module so the real cloud client is never initialized. This preview does not replace backend validation tests.
