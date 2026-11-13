# Carrier statement inbox and payroll readiness

## Workflow

1. Open **Commissions → Reconciliation → Log carrier statement**. Choose the carrier, original file, statement reference and date the document arrived. Save immediately; policy matches, source totals and payment details can remain incomplete.
2. Open the saved statement. Enter its **agency commission total**. Import CSV/XLSX rows or request PDF/image extraction. Check the original, select the table and header, and map columns. **Remember carrier format** stores column headings for subsequent statements; reordered columns are matched by heading. Extraction produces suggestions for human review, never approved earnings.
3. Review the compact source rows. Exact carrier/policy/term matches are suggested. Ambiguous renewals remain unmatched. **Find in CRM / add tracking** reuses the account, policy dates, premium and agency rate, then asks for the original producer and transaction. Complete missing classification or employee plan inline. Confirm historical facts before adopting a policy.
4. Save incomplete rows as pending. Select routine rows for bulk eligibility review. Review reversals, restorations and excluded rows individually, with evidence. Reconcile every source amount to the control total before allocating a payment.
5. Record the **actual** agency commission settlement, date, unique reference and evidence. A statement arrival or invoice due date is not payment evidence. For retained agency-bill commission, record collection/remittance evidence. Allocate a partial payment only to the amounts actually received. Positive receipts and negative offsets can form a net settlement.
6. Confirm the allocation and post. The system validates the complete plan before posting it in bounded transactions. If interrupted, reopen the statement and **Resume posting**. Completed rows are retained and repeated requests cannot create duplicate earnings. Assigned source rows lock; use linked corrections for posted mistakes.
7. Open **Payroll**. Choose the cycle in **Payroll readiness** to see the receipt cutoff, source work outstanding, settlements still to post, eligible preview amount, delivery state and approved payment balance. Review the detailed cycle, approve as an Owner, inspect archived PDFs, then confirm actual employee payments through the existing controls.

Earlier reconciliation records remain available in their own panel. No migration of old statements is required. Carrier payment forecasting is unchanged.

## Staging acceptance exercise

Use simulated transactions only, with `TEST-INBOX-` references. Do not mistake a real carrier statement for evidence that the agency received money. Keep automatic report delivery disabled.

Select a tracked policy whose **saved producer rate is 10%** and verify that its producer/eligibility terms cover the simulated receipt dates. The dollar results below assume that rate and no shared allocation, departure restriction or prior adjustment. Use the policy's actual carrier, number and effective date.

| Step | Enter / do | Expected result |
| --- | --- | --- |
| Arrival | Log an original test CSV/PDF with reference `TEST-INBOX-20261113`, received November 12, 2026. Leave rows and payment blank. | Saved inbox record; no new ledger earnings; no payroll blocker solely for an unpaid statement. |
| Source rows | Row A: unique reference `TEST-INBOX-A`, agency commission **$1,000.00**. Row B: `TEST-INBOX-B`, **$500.00**. Both matched to the selected policy term. Set source control total **$1,500.00**. | Two rows retained, total reconciles. Producer amounts are not yet payable. |
| Incomplete / incorrect source | Save Row B pending or temporarily unmatched. Try allocation with a wrong source total. | Draft saves; posting is prevented until selected rows are matched/reviewed and the source total reconciles. Restore the correct values. |
| Review | Mark both routine rows eligible and confirm the source review. | Saved review decisions; still no earnings before a verified payment posts. |
| First partial payment | Reference `TEST-INBOX-PAY-1`, November 12, 2026, **$750.00**, evidence `SIMULATED STAGING BANK RECEIPT`. Allocate A **$500.00**, B **$250.00**. Confirm and post. | Agency receipt **$750.00**; producer earned **$75.00** ($50 + $25). Remaining source balance **$750.00**. |
| Retry | Refresh/reopen after posting. Attempt the same payment reference again. | Existing payment is retained; no duplicate receipt or earnings. Original file/reference re-upload and duplicate transaction references are also blocked. |
| Remaining payment | Reference `TEST-INBOX-PAY-2`, November 13, 2026, **$750.00**. Allocate the remaining A **$500.00**, B **$250.00**. | Combined agency receipts **$1,500.00**, combined producer earnings **$150.00**, source balance zero. |
| Cutoff | Compare a cycle with cutoff November 12 against one with cutoff November 13 or later. | The first includes **$75.00** of these new earnings; the second includes both receipts if neither is already reserved/paid. Document arrival date never substitutes for actual payment dates. |
| Off-cycle isolation | If testing approval before the monthly cutoff ends, create an off-cycle run and select only these new earnings. Use an elapsed receipt cutoff and valid review/processing/pay dates. | Existing staging earnings remain separate; expected selected commission is **$150.00** for both receipts. A monthly cycle cannot be approved before its inclusive cutoff ends. |
| Reports | Approve the selected test cycle, download the HR and employee PDFs, then inspect report history. | Same approved dollars, employee, receipt dates and revision across preview, ledger and PDF. No email unless separately enabled and authorized. |
| Privacy | Open as an employee, then as an Owner using Admin view. | No carrier inbox, payment evidence or another employee's commission data. Active Owner role is required for financial mutations. |

For import reuse, read a second fictional CSV with the same headings in a different order and a new source/reference. Confirm the remembered columns map correctly. Change a column to an unreadable amount and verify the row stays visible for correction. For PDF extraction, check every page/table, policy number, decimal, negative sign and total against the original before confirming.

For large-statement interruption testing, use seven or more distinct transaction rows with a reconciled total, then interrupt after the first posting response. The settlement must remain blocked for affected payroll cutoffs until all rows finish; resume must retain the exact original total without duplicate receipts.

## Boundaries and recovery

- Original source files are private, limited to 10 MB for intake, and hashed on the server. CSV/XLSX parser limits still apply. Up to 1,000 source rows remain under one statement; saves occur in groups of 20 and posting in groups of five. Existing policy history and payroll transaction limits remain enforced.
- If a multi-save import fails, the error states how many rows were saved. Reopen the statement, inspect the retained rows and complete the remainder. Version checks reject stale edits.
- An incorrectly recorded, entirely unposted settlement can be voided with a reason and confirmation. References and audit history are retained. Posted corrections require the established linked reversal/restoration workflow.
- A recorded but unfinished settlement blocks payroll when its actual receipt date is on/before cutoff. Merely awaiting payment does not. Previously posted earnings continue to use the existing cent-rounding, agreement, shared-commission, departure and approval rules.
- Staging is required to verify actual private-file upload, AWS PDF extraction, authenticated CRM lookup and end-to-end persistence. The isolated fictional preview is read-only and cannot establish those integration results.

## Guided review and working-copy recovery

The next-work list puts received, unfinished settlements ahead of source review
and statements awaiting payment. Open a statement to follow Read source, Match &
review, Confirm payment, Post settlement and Complete. Source loading and
extraction checks run automatically; an extraction error or timeout retains the
source and allows a deliberate retry.

Use **Save working draft** within a section to keep a private server copy before
leaving. Reopen the statement and choose **Restore saved draft** to resume. This
does not approve eligibility, record payment or create earnings. Review
confirmations must be made again. If the statement changed, inspect the saved
values and compare them with current records; direct restore is disabled. Use
**Reload saved draft** after a conflict or uncertain save response. Each Owner has
their own working copies, limited to 100 KB per section; use normal pending-row
saves to retain large, valid row sets.

After actual payment is recorded and the allocation balances, **Confirm allocation
& post settlement** validates and posts in resumable groups. If interrupted, use
**Refresh statement**, then **Resume posting** (or **Post verified settlement** if
the first group never posted). The recorded allocation remains; do not record the
same deposit again.

Payroll uses one cycle selector for both readiness and employee totals. The oldest
open cutoff is shown first. Earlier cycles remain selectable, and approval,
cancellation, report history and payment safeguards retain their existing rules.
