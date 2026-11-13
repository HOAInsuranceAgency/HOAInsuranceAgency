# HOA commission workflow — staging acceptance plan
Updated November 13, 2026 for the completed workflow simplifications. Use the release commit and staging deployment identified in the release message. This plan supersedes the earlier November 13 plan's pending-feature list and the older acceptance plan's navigation/deployment instructions.

Staging: https://migration-staging.d1nuh9rw1hcuxo.amplifyapp.com

Use authenticated staging accounts and fictional records with unique TEST references. Keep report emails disabled. Do not change production or initiate actual HR/bank payments. The fictional local preview proves presentation only; live upload, extraction, cross-session recovery, posting and archived reports require the controlled staging exercise below.

## Current workflow
**Work queue → Statements → source and eligibility review → carrier payment → Confirm allocation & post earnings → selected payroll review → reports → recorded employee payment.**

- Work queue is the default for a first visit. Reopening restores the last workspace in the same browser for the same Owner. Received money affecting payroll comes first, followed by cutoff/review work. Use direct review links to open the relevant record.
- Tabs are Work queue, Statements, Payroll, Ledger, Reviews & exceptions, and Setup. Employees retain their restricted personal view.
- Opening a statement focuses on its workspace. The guide provides the next action; preparation and payment have separate badges. Source, recorded, allocated, posted, employee and remaining totals stay visible; desktop totals remain pinned during review.
- CSV/XLSX reading and PDF/image extraction checks run automatically. The original document appears beside review on larger screens. Import rows & remember format combines the reviewed mapping actions.
- Unresolved rows are shown first. All rows remains available. Repeated missing-policy issues are grouped; routine rows can be selected as a review group. Mobile and narrow review columns show one focused source row.
- Working edits save privately after a short pause, with Saving, Saved and Needs retry feedback. Save working draft remains available. Recovered values require Restore saved draft; review confirmations are reset. Navigation preferences are browser-specific; working drafts are server-saved and Owner-private.
- A full verified payment matching all remaining reviewed amounts receives a proposed allocation. Partial payments require evidence-supported allocations. The final action displays server-calculated employee amounts and posts in resumable groups.
- Payroll shows one cycle with matching readiness and approval checks, including the inclusive cutoff. Employee calculations link to sources. Review issues link to the relevant statement, policy or exception case.
- Payroll history is searchable; report versions and delivery evidence follow the selected cycle. Approval, delivery and employee payment remain separate. Cancel cycle… opens a reason/confirmation dialog.
- Prepare off-cycle payment starts a draft from a selected ledger earning, adjustment or payroll calculation, carrying only that selection forward. It does not approve or pay it.

## Prepare once
Use a unique run prefix, for example TEST-SIMPLE-20261113-02, in file contents and references. Repeated sources/references are deliberately detected as duplicates.

Use a fictional tracked policy with a saved **10% employee commission rate**, valid for November 10–11, 2026. This is the employee's rate on agency receipts, not the policy's premium commission rate. Use one employee with no shared allocation, departure hold, adjustment or prior payroll reservation for the main exercise.

Prepare a CSV using the policy's exact carrier, policy number and effective date:

| Row | Unique transaction reference | Agency commission |
| --- | --- | ---: |
| A | TEST-SIMPLE-20261113-02-A | $1,000.00 |
| B | TEST-SIMPLE-20261113-02-B | $500.00 |
| Total | | $1,500.00 |

Suggested columns: Policy, Reference, Amount, Effective, Transaction. Use receipt transactions. If these dates are outside the chosen policy's saved eligibility period, prepare a suitable fictional policy first.

Fictional dates, Eastern time: statement arrived November 12; carrier payment November 11; payroll cutoff November 11; Owner review, HR due and processing November 12; employee pay date November 13, 2026. Document arrival intentionally differs from receipt date.

Check pre-existing staging blockers before payroll. Resolve only identified test records through normal controls; do not change unrelated records to force approval. Complete the main run before adding deliberate exception cases.

## Main walkthrough

### 1. Start with the work queue and log the statement
Open Commissions. On a first visit, Work queue should be selected. Open Statements and choose Log carrier statement. Select the carrier and original CSV; enter the run reference and November 12 arrival date; Save to inbox.

**Pass:** The original and inbox record survive refresh. Matching and payment were not required to log it. The focused workspace opens, with a next action and separate preparation/payment badges. No employee earnings exist, and an unpaid statement alone does not block payroll.

### 2. Read, compare and import once
Confirm the spreadsheet loads automatically. Expand Statement details & control total; enter $1,500 and Save statement details. On desktop, compare the original beside the review. Verify the table/header and map every source column. Check the mapping acknowledgement, then Import rows & remember format.

**Pass:** Two rows totaling $1,500 are saved for review. The carrier format is remembered. Import does not approve eligibility or create money. A second fictional source with reordered headings reuses the mapping correctly. A failed row import explains what was saved; retry after checking retained rows.

### 3. Review only the work that needs attention
Confirm Rows to review starts with Unresolved rows. Switch to All rows and back. Check the policy terms, amounts and eligibility. For eligible routine receipts, Select routine review group, inspect the reason they qualify, and Mark selected routine rows eligible. Check the source-review acknowledgement and Save source rows.

**Pass:** Incomplete rows can be saved. Reviewed financial changes require renewed acknowledgement. Routine grouping does not approve reversals, ambiguous renewals, unreadable amounts or missing historical facts. Once complete, preparation says Matches complete; payment still says Awaiting payment. Earnings remain $0.

### 4. Record the actual payment and review the complete posting summary
Record a settlement: unique TEST payment reference, November 11 actual receipt date, $1,500, Carrier deposit, evidence SIMULATED STAGING RECEIPT — NO REAL PAYMENT. Confirm and Save settlement for allocation.

The full payment should propose A $1,000 and B $500. Check allocated/received totals, source remaining, saved employee rate and server-calculated earnings. Temporarily reduce an allocation by $1; the difference must prevent submission. Restore the amounts and wait for the current financial review. Acknowledge and choose Confirm allocation & post earnings once.

**Pass:** Final posting stays unavailable while the preview is loading, invalid, stale or unbalanced. Posting completes automatically. Agency receipts increase $1,500, employee earnings $150 ($100 + $50), and source remaining becomes zero. Completion shows those totals and Continue to payroll. No employee payment or email occurs.

### 5. Reopen and check duplicate protection
Refresh/reopen the statement and ledger. Try the same source file, carrier statement reference and payment reference again. Use a separate test source to check repeated transaction-reference protection.

**Pass:** No retry or duplicate creates additional receipts/earnings. Posted source values stay locked; corrections use the established linked workflow. The original source and audit history remain.

### 6. Carry only selected earnings into payroll
Continue to payroll should open a relevant cycle. In Ledger, use Prepare off-cycle payment for the $100 earning. Verify only that earning is preselected. Add the other test $50 earning deliberately, or create a separate off-cycle draft from Payroll using Choose specific earnings.

Use the test employee, dates above and a TEST reason. Save the draft. Review payroll cycle must show that selected cycle, matching readiness dates and totals.

**Pass:** The draft totals $150 only after both test earnings are selected. Other staging earnings remain excluded. Creating it does not approve or pay it. Changing employees/cutoff invalidates unavailable selections instead of silently broadening them.

### 7. Resolve, approve and inspect reports
Expand Employee calculations & source statements. Verify $100 and $50 and open their source. Any Resolve control should open the exact linked record. Return to the same payroll cycle. Confirm the cutoff has ended, resolve applicable blockers, review dates/totals, acknowledge and Approve payroll cycle.

Download the HR summary and employee earnings PDF.

**Pass:** Both readiness and approval show the same blocking conditions. The approved cycle is $150, with $0 paid / $150 outstanding. Selected ledger earnings and PDFs agree on employee, amounts, actual receipt dates, cycle and revision. Agency cash remains $1,500. Approval does not send email or record payment. These earnings cannot be reserved again.

### 8. Record fictional payments and review history
Under Record individual employee payments, record $60 with a unique TEST reference and the November 13 date. Refresh. Record the remaining $90 with another TEST reference. Find the completed cycle through Search payroll history.

**Pass:** Paid/outstanding is $60/$90 after the first record, then $150/$0. Both records remain. Overpayments fail; retrying a submitted payment does not duplicate it. Report delivery remains Not sent. A partly paid report cannot be cancelled or replaced.

| Checkpoint | Agency receipts posted | Employee earned | Employee paid | Employee unpaid |
| --- | ---: | ---: | ---: | ---: |
| Reviewed source, before posting | $0 | $0 | $0 | $0 |
| Posted / approved | $1,500 | $150 | $0 | $150 |
| First employee payment | $1,500 | $150 | $60 | $90 |
| Completed employee payment | $1,500 | $150 | $150 | $0 |

These are this run's changes, not the entire staging account's totals.

## Required recovery and exception checks
Use distinct sources/references and keep these earnings separate from the main run.

| ID | Exercise | Pass condition |
| --- | --- | --- |
| R1 — Autosave and recovery | Edit each supported section: statement details, import mapping, source rows, payment details and allocation. Pause until Saved. Refresh/reopen and Restore saved draft before changing the underlying statement. | Saving/Saved are visible. Values return for review, with confirmations cleared. Draft operations do not approve eligibility, record a receipt or post earnings. Normal section submission remains required. |
| R2 — Reopen the same work | Choose a statement, filter, focused row and opened work panel; close/reopen the app in the same browser as the same Owner. Repeat for a selected payroll cycle. | The workspace, statement, filters, panel/focused row and payroll selection return. A freshly clicked destination is not replaced by a late preference load. Do not expect browser preferences to roam to a different browser. |
| R3 — Conflict, retry and privacy | Load one section in two tabs as the same Owner; make conflicting saves. Separately save a draft, then change its statement. Sign in as another Owner. Simulate a failed save. | Conflicts are explicit; no silent retry overwrites a newer copy. Needs retry appears. Reload saved draft retrieves the saved version. Stale values can be compared but cannot be restored over changed records. Another Owner cannot read/restore the draft. |
| R4 — Partial carrier payment | Separate $1,500 source, A $1,000/B $500. Receive $750 November 10; allocate A $500/B $250 from evidence and post. Receive the remaining $750 November 11 and allocate the remaining $500/$250. | No partial allocation is guessed. After payment 1: agency $750, employee $75, source remaining $750. Final totals: $1,500/$150/$0. Before reserving either earning, cutoff-November-10 versus cutoff-November-11 previews include $75 versus $150 of these earnings. |
| R5 — Payment before matching | Record an evidenced payment while a row is unmatched. Inspect Work queue and payroll through that receipt date. Finish matching, then post the same settlement. | Received money rises above unpaid work, ordered by affected payroll cutoff. It remains unresolved and blocks affected approval until posting finishes. No deposit is recorded twice. |
| R6 — Interrupted posting | Engineer-assisted: seven $100 receipt rows at a saved 10% rate. Interrupt after the first confirmed posting group. Reopen; Refresh statement, then Resume posting, or Post verified settlement if no group finished. | Allocation and completed rows survive. Affected payroll remains blocked while unfinished. Final amounts are exactly $700 agency / $70 employee after retries. If timing cannot be controlled, mark Not run. |
| R7 — PDF/image extraction | Upload a fictional PDF/image; reopen during extraction. Compare pages/tables, policy numbers, decimals, signs and totals. Exercise an error/timeout. | Automatic progress checks stop appropriately. Source is retained; deliberate retry is available. Extracted suggestions never approve eligibility. Original viewing remains available if an embedded preview cannot render. |
| R8 — Repeated missing policy / ambiguous renewal | Use multiple rows for one missing policy term. Complete tracking once. Separately use a policy number with multiple terms and omit its effective date. | Matching rows receive suggestions without losing typed values; they still require review. Ambiguous terms remain unresolved. Missing historical/GIM information explains the remedy; no current rate substitutes for missing history. |
| R9 — Reversal/restoration | Separate policy: post $1,000 at 10%, then an evidenced linked −$200 reversal; test restoration separately. | Net agency cash is $800 after reversal. Original $100 employee earning/history remains; a review item appears instead of an automatic $20 payroll deduction. Restoration does not create duplicate positive employee earnings. |
| R10 — Cutoff and exact off-cycle selection | Attempt approval before the inclusive cutoff ends. Then prepare an off-cycle draft from one eligible $50 adjustment/earning while other earnings exist for that employee. | Readiness and approval both block early approval. The draft includes only $50 unless the Owner explicitly adds other earnings. The server rechecks eligibility/version at approval. |
| R11 — Shared credit and frozen rates | Separate $1,000 receipt: shares 60%/40%, saved rates 20%/16%. Change future plan terms and revisit it. | Earnings remain $120 and $64, total $184; agency cash counted once. Financial preview, posted history and approved PDFs retain saved historical rates and cent rounding. |
| R12 — Departure/adjustment decisions | Create separate evidenced departure and adjustment cases. Follow queue/Resolve links. Review source, affected amount, decision and history; resolve/approve explicitly. | Applicable holds block approval. Drafts do not change payable money. Paid history remains. Resolution history is retained alongside the case; proposed recoveries never become automatic deductions. |
| R13 — Unpaid cancellation and revision | On a separate unpaid cycle, open Cancel cycle… and close with Escape. Reopen, enter reason and acknowledgement, then cancel. On a different wholly unpaid approved cycle, exercise Correct an unpaid report. | Opening/closing the dialog changes nothing. Confirmation cancels only that cycle and retains history. Correction preserves prior PDFs as historical revisions. Any recorded employee payment prevents cancellation/replacement. |

## Access, presentation and evidence
- Use two authenticated employee accounts and a non-Owner staff account. Each employee sees only their permitted data. Carrier inbox/files, payment evidence, other employees and Owner drafts stay private. Repeat as an Owner in restricted Admin view. Engineer-assisted direct-request checks must enforce the same boundaries.
- Test approximately 1440, 768 and 390 pixels, 200% zoom, keyboard Tab/Space/Enter and Escape. Confirm visible focus, readable acknowledgements, compact consistent buttons and no page-wide sideways scrolling. At mobile width and in a narrow desktop column beside the original, switch focused source rows and verify values survive; the row editor should not require horizontal form navigation.
- Inspect the original beside review on desktop. Unresolved/All filters must retain edits. Check source, allocated and remaining totals while scrolling.
- Search completed payroll history; confirm readiness, details, report versions and delivery evidence all identify the selected cycle. Employee calculation/source links must preserve context.
- Check actor/time/reference/amount for statement, settlement, approval, exception decisions and payments. Historical downloads remain distinguishable from current payment authorization.
- Keep report delivery off throughout and verify it remains off at the end. Resolve/void eligible unposted test records using normal controls; retain posted and paid history.

Record **Pass / Fail / Blocked / Not run**, test reference, expected versus observed amounts/messages and evidence for every main step and R-case. Automated tests and fictional previews support the release but do not replace authenticated staging acceptance.

| Test | Result | Reference | Expected / observed / evidence |
| --- | --- | --- | --- |
| Main 1–8; R1–R13; access/layout | | | |
