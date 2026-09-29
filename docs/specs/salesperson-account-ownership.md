# Salesperson account ownership

Current operating model, September 29, 2026. This supersedes the separate salesperson/deal-champion ownership and marketing-manager escalation rules in the earlier sales/carrier and reminder specifications.

Each account has one salesperson. That person handles prospect communication, carrier submissions and underwriting questions, quote presentation, binding, renewals, and ongoing client service. Binding changes the account's business context; it does not hand the account to another role. Client and carrier correspondence remain separate so a reply on one side cannot complete work on the other.

Manager and temporary-cover accountability is managed outside the CRM. Work reminders and account reports go directly to the assigned salesperson, with no manager or agency-owner escalation. Existing specialist and blocker details remain task context; they do not grant access or route account details to other teammates. The CRM no longer offers manager eligibility, direct reports, away/coverage schedules, manager takeover, champion assignment, or champion help. Administrators retain access to all accounts; every other user sees only their own assigned accounts. Old manager and cover settings cannot grant access.

Settings → Team has one member table for roles, lead texts, salesperson eligibility, and provider connections. The separate Report delivery card configures operational alert contacts and the internal reporting channel, without a management hierarchy.

## Front behavior

Scheduled task reminders remain in the CRM and internal daily reports. They do not reopen or post routine comments on Front conversations. Previously queued daily reopen/comment operations are suppressed, including retries. New inbound activity retains its immediate reopen behavior; ordinary team comments and independently configured inbox cleanup retain their existing behavior.

## Existing records

The communications worker runs a bounded, restartable migration, including while delivery is paused. It removes retired defaults, eligibility fields, manager relationships, and temporary-cover settings. Each workflow retains its existing salesperson; a missing salesperson is filled only from a validated configured default. An invalid or unavailable owner remains an assignment exception. A former champion-only teammate is not automatically granted salesperson eligibility.

A durable per-account job converts open tasks to salesperson ownership, preserves their IDs, business deadlines, source evidence, carrier/client domain, and lead/renewal/service context. Retired escalation metadata and helper assignments are removed; old manager/cover notices are suppressed. The next wake time follows the direct morning reminder schedule. Automatic Front links follow the current salesperson; manual Front assignment stays manual. Deleted accounts are skipped. Historical completed tasks and audit records are preserved.

Legacy fields and the legacy carrier follow-up ID suffix remain readable for migration/idempotency only. Cached clients cannot restore champion, manager, or temporary-cover authority. Reads and routing use salesperson ownership while the stored records migrate.

## Acceptance

- Create a lead with one eligible salesperson and no champion settings. Run client contact, carrier submission, quote presentation, and binding; the same salesperson owns the account throughout.
- Confirm carrier, renewal, and service work appears in the assigned salesperson's work list/report; former managers and cover teammates receive no automatic escalation or team summary.
- Verify manual Front routing survives migration and automatic routing uses the salesperson's mapped Front teammate.
- Migrate accounts with pending tasks and old reminders over multiple pages and an interrupted run. Verify IDs, dates, evidence, and context remain unchanged; old champion, manager, cover, and owner-escalation notices disappear.
- Confirm due work creates CRM reminders without scheduled Front reopen/comment operations, while a new inbound request can still reopen its conversation.
- Verify legacy manager relationships cannot authorize account lists, direct links, documents, custom operations, or assignment to another salesperson. Administrator access remains available.
