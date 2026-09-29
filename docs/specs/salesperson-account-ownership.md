# Salesperson account ownership

Current operating model, September 25, 2026. This supersedes the separate salesperson/deal-champion ownership and marketing-manager escalation rules in the earlier sales/carrier and reminder specifications.

Each account has one salesperson. That person handles prospect communication, carrier submissions and underwriting questions, quote presentation, binding, renewals, and ongoing client service. Binding changes the account's business context; it does not hand the account to another role. Client and carrier correspondence remain separate so a reply on one side cannot complete work on the other.

All of this work follows the salesperson's sales-manager/agency-owner escalation chain. Temporary cover, an explicitly named specialist, and recorded blockers remain available; the account salesperson retains accountability. The CRM no longer offers champion assignment, champion eligibility/defaults, champion help, a champion work filter, or a separate marketing-manager configuration. Existing CRM sign-in permissions are unaffected.

## Front behavior

Scheduled task reminders remain in the CRM and internal daily reports. They do not reopen or post routine comments on Front conversations. Previously queued daily reopen/comment operations are suppressed, including retries. New inbound activity retains its immediate reopen behavior; ordinary team comments and independently configured inbox cleanup retain their existing behavior.

## Existing records

The communications worker runs a bounded, restartable migration, including while delivery is paused. It removes retired defaults, eligibility fields, and marketing-manager settings. Each workflow retains its existing salesperson; a missing salesperson is filled only from a validated configured default. An invalid or unavailable owner remains an assignment exception. A former champion-only teammate is not automatically granted salesperson eligibility.

A durable per-account job converts open tasks to salesperson ownership, preserves their IDs, business deadlines, escalation clocks, source evidence, carrier/client domain, and lead/renewal/service context, and retires obsolete reminders to former owners. Automatic Front links follow the current salesperson; manual Front assignment stays manual. Deleted accounts are skipped. Historical completed tasks and audit records are preserved.

Legacy fields and the legacy carrier follow-up ID suffix remain readable for migration/idempotency only. Cached clients cannot restore the champion role. Reads and routing use salesperson ownership while the stored records migrate.

## Acceptance

- Create a lead with one eligible salesperson and no champion settings. Run client contact, carrier submission, quote presentation, and binding; the same salesperson owns the account throughout.
- Confirm carrier, renewal, and service work appears in that salesperson's work list/report and their sales manager's escalations.
- Verify manual Front routing survives migration and automatic routing uses the salesperson's mapped Front teammate.
- Migrate accounts with pending tasks and old reminders over multiple pages and an interrupted run. Verify IDs, dates, evidence, and context remain unchanged; old champion notices disappear.
- Confirm due work creates CRM reminders without scheduled Front reopen/comment operations, while a new inbound request can still reopen its conversation.
