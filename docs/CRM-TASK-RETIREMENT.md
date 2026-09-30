# CRM task and daily email retirement

September 29, 2026. This implementation is intended for review through a pull request to `staging`; it does not enable or deploy itself.

## Current behavior

- Salespeople see their own Leads and Clients without the Salesperson column or filter. Their table downloads omit that column too. Administrators retain the column, filter and assignment tools.
- Tasks and Lead Follow-up no longer appear in navigation, account pages, dashboards, Settings or the Front sidebar. Old `/tasks` and `/lead-work` URLs redirect to Leads.
- Task creation, completion, delegation, reminders, annual follow-up and renewal task generation are retired. Cached task API requests fail for every role, including administrators. Actual lead creation, ownership, call records, customer correspondence, quotes, policies and billing continue.
- Task digest, operations rollup, licence-expiry digest and Front morning staff report functions and schedules are no longer deployed. Their old source entry points are inert. The daily premium-finance check retains its payment and default safeguards but sends no accounting reminder email.
- Customer emails, invitations, event-driven upload notifications and real provider delivery/reconciliation remain. The Friday 8 a.m. Eastern marketing report and its manual Settings action remain.

## Historical records

No task tables or task data are deleted by this change. The old MarketingTask model remains for storage compatibility, while signed-in browser access is denied. Old communication tasks and notifications retain their data; the worker can remove their obsolete queue metadata without generating reminders or new tasks.

The weekly marketing workbook retains its 53 columns and includes all CRM leads and converted clients. Historical task due dates, blockers and document requests no longer establish a current status. The report continues to use recorded accounts, communication, documents, quotes and policies. Where no current evidence exists, fields stay `Not recorded`.

## Staging acceptance

1. Sign in as a salesperson and open Leads and Clients. Confirm the Salesperson heading, filter and download column are absent, and only assigned accounts are visible.
2. Sign in as an administrator. Confirm account assignment, the Salesperson column and filter remain available.
3. Open an account and Front sidebar. Confirm assignment and communication tools remain and task controls are absent. Confirm old Tasks and Lead Follow-up links redirect to Leads.
4. Create a test lead and process test inbound/outbound messages and call outcomes. Confirm records and business delivery evidence persist without task rows or daily notifications.
5. Confirm Settings retains weekly marketing configuration and manual delivery. Use a controlled staging recipient for any manual send.
6. Confirm the deployed environment has no daily staff email schedules. Payment/default checks must still run without staff reminder email permissions.

Automated coverage verifies role-specific tables, retired route redirects and APIs, legacy task history handling, provider/business workflows, weekly report delivery, payment safeguards and synthesized infrastructure. Historical workflow specifications remain reference material, not current feature requirements.
