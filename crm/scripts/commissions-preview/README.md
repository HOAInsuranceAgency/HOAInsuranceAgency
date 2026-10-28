# Commission workflow preview

From `crm`, run `npx vite --config scripts/commissions-preview/vite.config.ts` and open http://127.0.0.1:8791/.

This renders the production commission components with fictional in-memory records. Use `?role=producer` to inspect the producer statement view. No authentication, CRM requests, cloud storage, or payroll actions are performed. Save and download actions deliberately refuse. This preview supports visual checks; the service tests cover posting and authorization.
