# Commission workflow release review

This release brings the commission workflow tested on staging into the current main architecture. It changes application code and infrastructure definitions only. It does not import staging records, statements, agreements, receipts, earnings or payroll payments.

## Workflow

- Work queue identifies the next review action. Guided workflow follows a statement from import through employee payment without requiring separate reconciliation and payroll tabs.
- Saved carrier mappings, exact policy matches and payment allocations can be suggested. A person confirms source values, eligibility, matching, posting, payroll approval and payment.
- A carrier deposit can be recorded before its remittance arrives. Matching carries the bank date, amount, reference and evidence into the selected statement. One deposit can match one statement, including a partial payment; deposits spanning several statements remain unresolved.
- Payroll uses actual carrier receipt dates. The workflow distinguishes future cutoff dates, unresolved receipts, missing historical agreements, held earnings and completed payments, with links to the relevant record.
- Plans, effective employee assignments, shared commissions, departure reviews, adjustments and archived reports remain available to authorized Owners. Producer views retain their restricted scope.
- Source documents and recoverable working drafts remain private. Restoring a draft does not restore approval checkboxes.

## Release controls

The commission report scheduler is disabled in the infrastructure definition for every environment. Report delivery settings default to disabled. Downloads remain available; this release does not enable report emails.

Main's shared controls, typed existing APIs, access-denial handling, bounded storage operations, issued-renewal behavior, feature modules and live-update protection are retained. Dirty drafts defer live replacement; authorization revocation still clears private data.

Merging main triggers the configured production builds. Keep the pull request unmerged until a production release is separately approved.

## Acceptance checks with fictional data

1. Create a fictional carrier, account, policy and documented employee agreement at 10%. Upload a statement containing $1,000 and $500 commission rows for that policy, with a $1,500 control total. Confirm suggested mappings and matches. Verify currency formatting and a clear next action after each save.
2. Leave one row or historical agreement unresolved. Verify the exact issue is visible and posting is blocked. Resolve it with evidence and explicit confirmation; verify no earnings exist before payment is posted.
3. Record one $1,500 carrier payment with a unique TEST bank reference and the actual test receipt date. Confirm allocation and post. Verify $1,500 agency receipts and $150 employee earnings, without duplication when reopened.
4. Follow Review payroll. Verify the statement's exact earnings are suggested and previously paid earnings cannot be selected. A future cutoff must explain when approval becomes available. A valid cutoff includes receipts on the cutoff date.
5. Confirm and approve a fictional unpaid payroll cycle. Inspect its archived report, then record supported fictional partial employee payments totaling $150. Verify outstanding balances fall to zero and the workflow shows Complete.
6. For a separate fictional bank deposit, record it before uploading remittance. Verify it remains Awaiting remittance and blocks relevant payroll until resolved. Select a suggested statement and confirm; the bank details must carry forward without re-entry.
7. Verify duplicate references, stale versions, ambiguous mappings, excessive allocations and incomplete reconciliation fail without partial financial writes. A noncommission deposit requires an explicit reason and confirmation; it must create no employee earnings.
8. Edit a form while a live update arrives, fail a save, reopen a private working draft and switch roles. Verify edits remain protected, confirmations reset, and unauthorized data disappears. Inspect desktop and 390-pixel layouts.

Use new fictional references for each run. Do not repeat payments against completed cycles. Real statement review details belong in private records, never in this repository.

## Verification

Run `npm run verify` from the repository root. This includes the offline commission/payroll integration suite, application tests, architecture checks, frontend/backend types, fictional previews, builds and both retained-environment synthesis checks. No credentials, email delivery or deployment is required for these checks.
