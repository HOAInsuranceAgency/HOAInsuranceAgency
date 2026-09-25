# CRM UX review preview

From `crm/`:

```sh
npx vite --config scripts/crm-ux-preview/vite.config.ts
```

Open `http://127.0.0.1:8769`. This renders the real CRM shell and pages with fictional records. It aliases model reads, communications, and storage to local fixtures. Model/communications writes and storage operations reject; the preview does not authenticate to the agency backend. Do not add real client data or credentials to these fixtures.

Useful routes:

- `/` — personal work with due actions
- `/leads` — working account directory, report columns, filters
- `/accounts/willow` — lead summary
- `/accounts/willow?tab=quotes` — quote workflow
- `/accounts/willow?tab=documents` — file library/upload controls
- `/accounts/willow?tab=property` — underwriting disclosures
- `/accounts/cedar?tab=policies` — client policy
- `/accounts/cedar?tab=certificates` — certificate draft/review (stop before generating)
- `/billing`, `/reports`, `/carriers`, `/settings` — operational and administrative pages

The preview reuses the existing commercial and Front sidebar fixture datasets. Not every backend response or empty/nonempty state is modeled; use the automated suite for business behavior and staging for authenticated end-to-end validation. Email, file delivery, PDF generation, finance transactions, and carrier submissions are not exercised here.
