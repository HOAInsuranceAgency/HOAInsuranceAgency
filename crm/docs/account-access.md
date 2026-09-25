# CRM account access

| Signed-in user | Account visibility |
| --- | --- |
| Administrator (`ADMIN` Cognito group) | All accounts, including unassigned accounts |
| Salesperson | Accounts currently assigned to their Cognito user ID |
| Sales manager | Their own accounts and accounts assigned to their direct reports in Team settings |

The authoritative assignment is `workflow:<accountId>.data.salespersonId` in the server-only communication table. Manager relationships come from the administrator-managed `team-routing` record. A manager must have `salesManager: true`; a teammate's `salesManagerId` alone does not confer management privileges. Self-editable `UserProfile.role`, legacy champion fields, old reminders, temporary coverage, and service-task assignments do not grant account access.

Contacts, quotes, submissions, policies, billing/finance records, activity, documents, and certificates inherit the account's access. Search, dashboard summaries, and exports use those same scoped reads. Shared agency resources—carriers, templates, licensing, profiles, agency settings—retain their existing permissions. The unassigned/unlinked intake tools are administrator-only. Non-admin lead creation defaults to the creator; managers can select an eligible direct report.

## Enforcement

`amplify/account-access.ts` adds an authorization function to Amplify's generated AppSync pipelines while preserving native model authorization:

- Reads, secondary indexes, and relationships filter results before GraphQL sends them to the browser. Filtered pages preserve their pagination cursor, including empty pages.
- Mutations check the stored record, proposed record, and related record IDs before writing. Moving a record to an accessible parent cannot claim someone else's record.
- Custom account operations check stored IDs before invoking the business handler; communication work/report responses are filtered too.
- Server IAM calls retain their existing native permissions. Cognito identity-pool calls cannot bypass the account guard by selecting IAM authentication.
- Account model subscriptions are disabled to prevent broadcasts after reassignment. Documents use authorized paginated reads, polling, and explicit refresh after changes.

Assignment reads are strongly consistent and cached only within one request. Reassignment and manager changes take effect on the next request without an ACL backfill. Existing browser content is refreshed as pages reload; previously viewed/downloaded information cannot be recalled.

## Files

Browsers have no direct S3 grants. `crmFile` checks the current assignment and canonical document/parent before signing a read/upload or performing a delete. URLs expire after 60 seconds. Upload signatures include content type and exact content length. Existing account, quote, policy, certificate, generated form, property photo, and finance agreement paths remain supported. Templates are shared for reading and admin-only for changes; signature changes require the profile owner or an administrator.

The public website/upload portals still use their existing token-protected APIs and server IAM permissions.

## Validation and rollout

Run `npm run test:run`, `npm run typecheck`, `npm run synth:check`, and `npm run build` from `crm/`. Synthesis fails on an unclassified model/endpoint, missing account guard, private subscription, direct Cognito S3 permission, or CloudFormation dependency cycle. It also verifies the generated physical table-name expressions used to avoid nested-stack cycles.

Deploy with the salesperson-ownership change from PR #24. Administrators should review unassigned accounts and set direct-report relationships in Team settings. After staging deployment, smoke-test with two salespeople, their managers, and an administrator: lists/search, copied account links, a document upload/download, lead creation, a submission, and reassignment followed by a fresh read. These live checks require the deployed backend and real staging identities; unit tests and synthesis do not replace them.
