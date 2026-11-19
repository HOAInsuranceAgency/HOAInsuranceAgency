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


## PR 167 review corrections

- Direct and linked late receipts hold affected approved payroll in the receipt transaction. Reconciliation is read before cycle discovery so a concurrent approval forces a retry; stale reports cannot authorize payment.
- Empty or unreadable sources offer **Enter source rows manually**. Review and posting confirmations are still required.
- Receipt posting and financial workspaces load exact policy receipt and approved adjustment identities with consistent, bounded reads. Missing history fails closed. Earnings display in pages of 50; totals and exports use the complete snapshot. Existing per-scope complete-read and transaction limits remain in effect.
- Intake read authorization failures invalidate parent caches. Earlier audit pages filter current-format records after the bounded database query and retain continuation through empty pages.
- Payroll PDFs embed Noto Sans and Noto CJK fonts. Regression checks cover Unicode extraction, drawable glyph outlines, deterministic bytes, archive size, employee isolation and long reports. Font source/licensing and generation notes are beside the assets.
- The dormant payroll worker joins existing transactional-mail and migration registries. The report schedule remains disabled and this change does not enable delivery settings.
- Retired agreement UI is removed; currency formatting uses the shared formatter.

Review regression exercise: start an empty fictional statement, choose manual entry, save reviewed rows, then confirm payment and posting. Separately approve a fictional payroll cycle and record a late receipt within its cutoff: the cycle must require fresh review. Verify access-denial cache clearing, earlier audit pages, paginated ledger totals and PDFs containing `Łukasz 李明` and `東京 김민수 José`.


### Statement lookup upgrade (required before release)

Active work and per-statement references commit with each source record. Archived statements are paged; the complete-read limit stays at 5,000 records. Existing ledgers fail closed with an upgrade message until their lookup backfill completes. New empty ledgers initialize the marker with the first statement.

After deploying the new commission writer, run the dry-run backfill against the explicitly verified staging ledger and region, then run the same command with `--apply` and verify `ready: true`. Production requires a separately authorized release. Do not run maintenance from the original working copy.

From `crm`: `npx tsx scripts/backfill-commission-statements.ts --table <verified-ledger-table> --region <verified-region>` (dry run). Add `--apply` only for the approved target. The script writes derived references only; source statements, settlements, policies, earnings, payroll, and email settings remain unchanged. Source-version conditions protect against concurrent writes. The readiness marker is published only after every page succeeds. An interrupted run can safely restart. All writers must be on this release before the backfill starts; rolling back to an older writer requires rebuilding the references before enabling this reader again.

Regression acceptance: more than 5,000 archived settlements do not block opening, saving, or posting a small current statement or preparing payroll. History pages expose older statements. Changes to policy terms or calculations after preview require a fresh financial review, including partially posted settlements. Live workspaces refresh across users while protecting unsaved edits. Report emails remain disabled.
