# Salesperson access settings

Settings → Team → Salesperson access provides three sections:

- Visibility: Assigned only (default), All leads, All leads and clients.
- Access to other accounts: Read only (default), Collaborate, Edit.
- Independent switches: sending emails/proposals, creating/sending/voiding invoices, binding policies. All default off.

These settings apply only to the active, authenticated PRODUCER view. STAFF remains assignment-only. OWNER/ADMIN retain their existing access. A missing setting preserves the current behavior; malformed settings and failed reads fail closed. Administrators save the complete policy with an optimistic version. Each change stores the authenticated administrator and an immutable audit-history row in the existing server-only Communication table. No new tables or account backfill are required.

All leads includes shared and unassigned LEAD accounts, while assigned clients remain accessible. All leads and clients also includes CLIENT accounts. Lists traverse the existing Account stage index in bounded pages, and re-read current account stage, assignment, and deletion state before returning records. Continuation tokens include the visibility policy; changing it invalidates old shared-list cursors. Search, direct IDs, relationships, and file reads use the same access rule.

Collaborate allows internal notes and new document uploads, including finalizing a new document's pending path. It does not allow replacing/deleting existing documents. Shared-account uploads are signed with a create-only S3 condition. The CRM task feature is retired and is not restored by this change.

Edit additionally permits account details, contacts, underwriting details and draft/open quote edits. It does not grant reassignment, lifecycle changes, deletion, editing bound terms, financing administration, recording receipts, or private compensation access. Existing assignment-based permissions continue on one's own accounts. Sending, invoicing and binding each require their explicit switch; financial/source/signature safeguards remain in place. Lead ownership and commission attribution remain tied to the assigned producer.

The account page fetches current effective permissions before mounting controls, displays the shared-access level, and disables relevant editing/action controls. The backend remains authoritative for native model writes, custom mutations and file signing. Settings changes publish the existing live-change signal; previously downloaded data and already-issued 60-second file URLs cannot be recalled.

Deployment must be followed by staged checks with two actual salespeople: all three scopes and levels, independent action switches, direct account/document links, unassigned leads, CLIENT transition, and revocation during an open session. Unit/build/synthesis checks do not replace those deployed identity checks.

---

# CRM account access

| Signed-in user | Account visibility |
| --- | --- |
| Administrator (`ADMIN` Cognito group) | All accounts, including unassigned accounts |
| Salesperson | Assigned accounts, plus the administrator-configured visibility above |

The authoritative assignment is `workflow:<accountId>.data.salespersonId` in the server-only communication table. Manager hierarchies and temporary coverage are retired. Stored manager, owner, and cover relationships do not grant account access. Self-editable `UserProfile.role`, legacy champion fields, old reminders, and service-task assignments do not grant access either.

Contacts, quotes, submissions, policies, billing/finance records, activity, documents, and certificates inherit the account's access. Search and exports use those same scoped reads. The Dashboard navigation and route require the `ADMIN` Cognito group; other users opening the root URL are redirected to Leads before the Dashboard mounts. Shared agency resources—carriers, templates, licensing, profiles, agency settings—retain their existing permissions. The unassigned/unlinked intake tools are administrator-only. Non-admin lead creation is assigned to the creator; only administrators can assign another eligible salesperson.

Settings → Team combines member details, lead-text preferences, salesperson eligibility, and Front/Dialpad connections in one roster. Eligibility changes assignment choices, while access remains governed by the rules above. Invited users remain visible before their first sign-in. The separate assignment-eligibility and manager/coverage tables are removed. Report delivery settings retain only operational alert contacts and the internal reporting connection; these contacts do not grant access to accounts or team-wide work reports.

## Enforcement

`amplify/account-access.ts` adds an authorization function to Amplify's generated AppSync pipelines while preserving native model authorization:

- Reads, secondary indexes, and relationships filter results before GraphQL sends them to the browser. Connection pages batch canonical parents by model, then batch the distinct accounts' workflow and deletion records before filtering. Filtered pages preserve their pagination cursor, including empty pages.
- Non-admin model lists replace the generated global scan, after native authorization, with assignment-index queries and account/parent-index queries. Account reads and ownership checks are batched. Search, dashboards, and account tables use this same path without needing separate frontend APIs. Filtering is bounded to authorized partitions; unrelated accounts are never scanned. Administrators and server IAM retain native listing behavior.
- Mutations check the stored record, proposed record, and related record IDs before writing. Moving a record to an accessible parent cannot claim someone else's record.
- Custom account operations check stored IDs before invoking the business handler; communication work/report responses and bulk account checks batch ownership reads too. Duplicate account IDs share the same request-local read; unprocessed keys retry, and storage failures propagate instead of returning incomplete results.
- Server IAM calls retain their existing native permissions. Cognito identity-pool calls cannot bypass the account guard by selecting IAM authentication.
- Account model subscriptions are disabled to prevent broadcasts after reassignment. Documents use authorized paginated reads, polling, and explicit refresh after changes.

Assignment reads are strongly consistent and cached only within one request. Reassignment takes effect on the next request without an ACL backfill. The listing index is eventually consistent, so newly assigned accounts may take a moment to appear; stale index entries cannot retain access because the authoritative assignment is checked again. Existing browser content is refreshed as pages reload; previously viewed/downloaded information cannot be recalled.

## Files

Browsers have no direct S3 grants. `crmFile` checks the current assignment and canonical document/parent before signing a read/upload or performing a delete. URLs expire after 60 seconds. Upload signatures include content type and exact content length. Existing account, quote, policy, certificate, generated form, property photo, and finance agreement paths remain supported. Templates are shared for reading and admin-only for changes. All signature operations, including reads, require the profile owner or an administrator. Certificate keys must match the stored certificate/account, and deletion remains admin-only; photo keys must use a recognized account slot. The exact premium-finance agreement key is derived from its stored loan and is read/link-only through `crmFile`, including for administrators. Only the finance service can generate or replace it.

The public website/upload portals still use their existing token-protected APIs and server IAM permissions.

## Validation and rollout

Run `npm run test:run`, `npm run typecheck`, `npm run synth:check`, and `npm run build` from `crm/`. Synthesis fails on an unclassified model/endpoint, missing account guard or scoped listing, private subscription, direct Cognito S3 permission, or CloudFormation dependency cycle. It also verifies the generated physical table-name expressions used to avoid nested-stack cycles and limits additions to one GSI per existing table per deployment.

The access guard's exact DynamoDB table/index read grants are split into managed policies of at most eight tables each. This avoids CDK moving one oversized statement into an IAM overflow policy. Synthesis checks managed and aggregate inline policy sizes using conservative bounds for generated names, and Amplify runs this check before deploying the backend.

A dedicated assignment-index worker backfills `assignedSalespersonId`, independent of communication delivery and provider configuration. Each minute it drains 100-row pages with 25 concurrent updates for up to 45 seconds (maximum 1,000 pages per run), checkpointing every completed page. The one-page-per-minute cap is removed; throughput now follows database latency/capacity. Reserved concurrency is one. Progress is available as `processed`, `cursor`, and the checkpoint timestamp. New writes/reassignments maintain the index in the same workflow write. Until `migration:assignment-index:v1` completes, non-admin global lists return a visible preparation error rather than incomplete results. Direct authorized account reads remain available. A failed page is retried without advancing the checkpoint; account owners and deadlines are preserved.

Deploy with the salesperson-ownership change from PR #24. Administrators should review unassigned accounts and salesperson eligibility in Team settings. After staging deployment, smoke-test with two salespeople, a non-admin with legacy manager settings, and an administrator: lists/search, copied account links, a document upload/download, lead creation, a submission, and reassignment followed by a fresh read. These live checks require the deployed backend and real staging identities; unit tests and synthesis do not replace them.

Scoped list pages fill across multiple account/parent partitions, with budgets of 80 index queries, 1,000 evaluated index rows, and 8 seconds. An unfinished traversal returns a cursor even when no matches were found; callers must keep following it. Deleted or moved parent projections are skipped, while database errors remain visible. Applicable non-key filters run in DynamoDB before candidate records are consistently reread and authorized; DynamoDB still charges query reads for evaluated nonmatches. Nested OR/NOT filters involving index keys stay in the final predicate to avoid excluding valid matches.
