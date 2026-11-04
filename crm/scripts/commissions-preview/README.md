# Commission workflow preview

From `crm`, run `npx vite --config scripts/commissions-preview/vite.config.ts` and open http://127.0.0.1:8791/.

This renders the production commission components with fictional in-memory records. Use `?role=producer` to inspect the producer statement view. No authentication, CRM requests, cloud storage, or payroll actions are performed. Save and download actions deliberately refuse. This preview supports visual checks; the service tests cover posting and authorization.

The Seaside HOA example has a partial carrier-supported schedule: $1,000 due
November 1, $900 received November 3, and $1,000 scheduled for December 1.
Review as of November 4, 2026 to see $100 overdue with the remaining unscheduled
estimate shown separately. The Cedar HOA example retains unknown legacy timing
and an adjustment requiring forecast review. All names and amounts are fictional.
