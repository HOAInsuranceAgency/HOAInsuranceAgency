# Relationships and management changes

## Product behavior

The Relationships directory holds people and organizations independently of insurance leads. Business names, contact details, affiliations and relationship notes are shared with active staff. A profile's owner or an active Administrator/Owner can edit it. Only administrators can transfer ownership. Insured accounts, portfolio rows, account relationship notes, policies and correspondence retain the existing salesperson assignment restrictions. Owning a directory profile grants no additional account access.

The insured Account remains the permanent record. A company or person can manage multiple accounts, own property, refer business, and also have an insurance account of their own. Separate relationship roles capture those facts. Original referral links are retained when management changes.

### Management handoff

On the account Overview, choose **Change management**. Select a company or individual (or self-managed), the effective date, and the general, billing and inspection contacts. Select any additional legacy contacts who will no longer represent the account. Review the summary before saving.

Dates use the agency's Eastern calendar. `validUntil` is exclusive: on that date the former relationship no longer applies. Future changes appear in history/scheduled changes and become current through date-aware reads. Changes cannot precede the latest recorded management date. A same-day correction retains the superseded relationship as a zero-day historical interval, with separate timestamped audit entries; it never creates two current managers.

A conditional DynamoDB transaction saves the new relationship, closes the previous relationship and its linked contacts, closes explicitly selected legacy contacts, records the account audit and writes the retry receipt. The version check rejects concurrent handoffs. The transaction checks current account assignment, account deletion and the acting user's enabled status. No policy, invoice, insured identity or salesperson assignment is moved. Future initial AI emails are suppressed using existing human-takeover behavior; already dispatched messages cannot be recalled.

Contacts are account-specific snapshots of directory information. Editing a business directory profile does not silently replace account contact details or previously issued documents. The Contacts card supports editing current snapshots. Former and future snapshots cannot be edited through generated mutations; managed contacts cannot be deleted independently of their history. General contact, billing and inspection defaults ignore former/future representatives. A cached invoice recipient known only as a former contact is rejected at send time. Existing Front threads/drafts and previously issued payment/upload links require case-specific review; the handoff does not readdress messages or rewrite historical artifacts.

There is one management timeline per account in this release. Other roles can coexist. Co-management, a full opportunity pipeline and relationship follow-up tasks are separate future work.

## Implementation

- `Party`: shared identity, contact details, owner, notes, archival state, revision.
- `PartyAffiliation`: dated person/organization employment, with revision.
- `AccountRelationship`: account-scoped management, owner, original-referrer and own-insurance links, with dates and revision.
- `Contact`: additive optional party/relationship references, effective dates and billing designation.
- The three new models expose reads only. Writes use validated `relationship*` operations on the existing authenticated communication API. The management lock and idempotency receipt use the existing workflow store; business records use dedicated model tables.
- New account relationship indexes are guarded by the same access layer as the other account models, including direct IDs, lists and reverse portfolio lookups. Shared parties and affiliations do not embed account names or portfolio totals.
- Universal search includes directory names, emails, phones and categories. New lead creation can select a relationship; manager links lead into the reviewed handoff form.
- Leads' Active, Snoozed and Follow-up due views exclude closed dispositions using the dashboard's shared open-lead definition. All leads remains historical.

## Additive migration and rollout

1. Deploy the schema, access guards, server operations and date-aware contact readers to **staging** together. Existing accounts/contact IDs are untouched; null dates retain legacy behavior. No automatic data copy runs on deployment.
2. In Relationships, select **Review existing manager contacts**. The list contains only current, unlinked contacts on accounts the viewer can access. Search for an existing shared profile before creating one. Review whether the name represents a person or organization, then create/link it and review the account's management handoff.
3. Do not infer an employer from an email domain, merge people using a shared mailbox, or invent a historical start date. Unknown start dates are supported on general relationships and affiliations. A new management handoff records its explicitly chosen effective date.
4. Verify one company across two insureds, one company with its own policy account, a person changing employers, and a two-year management change where the condominium retains the agency. Verify former contacts are not selected for new forms/invoices and the original referrer remains.
5. Test as two different salespeople and an administrator. The shared company remains findable; each salesperson sees only their own insured portfolio. Direct IDs and reverse relationship indexes must not disclose the other portfolio.
6. Review and merge through the staging PR. Production promotion remains a separate release decision.

Rollback must retain the additive columns and date-aware contact readers once a handoff has occurred. Reverting to a pre-feature reader could select a former primary contact. Stop new relationship writes while repairing; do not drop relationship tables or erase historical contacts.

## Acceptance and automated coverage

Backend tests cover atomic handoffs, original referral retention, explicit legacy contact retirement, self-management chronology, retry idempotence, conflicting versions, assignment restrictions and directory ownership. Contact tests cover effective-date boundaries and purpose-specific selection. UI coverage exercises directory discovery, management confirmation, errors/retry and the active/closed lead view. Existing full CRM tests, frontend/backend typechecks, production build and infrastructure synthesis remain release gates.

This release does not deploy itself or send customer communications during verification. Use fictional fixture data for local UI checks.
