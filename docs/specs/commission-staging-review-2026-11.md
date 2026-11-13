# Commission staging review — November 2026

## Changes
- Owners can void an unposted statement with a reason and explicit confirmation. The source file, original lines, and private audit remain. Posted and voided statements cannot be edited or reposted. An identical retry is safe. Voiding updates the reconciliation version in the same transaction so concurrent payroll approval must refresh.
- Reconciliation separates active drafts from searchable, collapsed history. Setup, tab changes, and statement-editor changes use the existing unsaved-change protection.
- Off-cycle drafts can include all eligible earnings or specific receipts/adjustments. Exact selections are preserved on edits/revisions. Stale or unavailable selections block approval rather than silently reducing the total.
- Reports use compact calculation rows and readable receipt references. Ledger exports include recorded payments; employee exports omit internal payroll references. Complete source IDs remain in CSV/private records. Existing approved PDF bytes stay archived unchanged.
- Newly generated staging payroll/departure reports and ledger printouts carry TEST DATA markings.
- Carrier reversal reviews are visible in Shared & exceptions. Proposed recoveries remain separate from payable earnings; no automatic deduction is introduced.
- Review notes accept 2,000 characters with explicit length validation. Zero policy shares are treated as unused participants. Assignment controls explain when an active Producer role is required.

## Retest on staging
1. Void the retained duplicate draft with a TEST reason. Confirm it remains in history and the payroll blocker clears; ledger totals must not change.
2. Edit the existing off-cycle draft: select only the approved $50 additional earning. Keep valid actual test dates. Approve only after the inclusive cutoff has ended.
3. Download the new HR and employee PDFs, verify $50 and test markings, and inspect page breaks. Confirm monthly preview excludes the reserved $50 once.
4. Record simulated partial/full off-cycle payment with TEST references on valid dates. Confirm payment history, no duplicate pay, and no monthly reallocation.
5. Test leaving a dirty reconciliation through tabs, setup, and browser navigation. Saved drafts must remain available after reopening.
6. Confirm each Producer view still exposes only that employee's data and reports.
7. Review the November cycle after the November 20 cutoff. Do not move the regular cutoff to force an early approval.

## Items requiring separate verification
- Browser/mobile and actual PDF visual verification after deployment.
- Controlled report delivery, bounce/retry, and all-Owner fallback; automatic delivery stays off in staging.
- New receipts/renewals after a departure review and access-disable variants.
- Resolve any CRM-versus-commission bind date discrepancy using source evidence before changing either record. Policy effective dates are separate from bind dates.
- Historical carrier statements predating an employee assignment require historical eligibility evidence; do not backdate agreements to force eligibility.
- Production has not been authorized for changes.

## Environment
Repository changes use the staging migration branch. Local Windows command execution was unavailable; the local checkout requires reconciliation before further local development. Staging builds run the targeted UI/service checks, financial integration suite, TypeScript, and synthesis checks before deployment.
