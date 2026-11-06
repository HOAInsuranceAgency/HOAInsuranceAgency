# Commission exceptions, shared credit, and departures

Decisions confirmed by Ethan on November 5, 2026. This is local project work; delivery and production activation remain separate release steps.

## Confirmed scope

All active CRM Owners may approve. Jake remains the default review/reminder recipient, not the only approver. Ethan will assign plans and verify carrier examples in the test environment. Existing CRM policy, carrier, account, receipt, and employee records supply the available data. Account transfers and transitions to house accounts are future enhancements. No special holiday automation is required.

## Implemented exception workflow

| Situation | Workflow and controls |
| --- | --- |
| Unapproved monthly or off-cycle run | Draft includes only reconciled, eligible, unallocated receipts through its inclusive cutoff. Off-cycle drafts require a reason and explicitly selected employees. Review the exact preview, resolve blockers, and obtain Owner approval. |
| Late carrier receipt | Preserve the actual receipt date. Include eligible unallocated earnings in the next month or a separately approved off-cycle run. Do not move the receipt date to force inclusion. |
| Unpaid approved report correction | Use **Correct an unpaid report**, supply a reason, and reopen as a new revision. The original approval and exact PDF bytes remain archived. Earnings are released for review; new approval is mandatory. |
| Original report already accepted by email | Owner must record that HR has held the original and no employee has been paid before reopening. The new subject/PDF identifies the revision it replaces. This is a recorded attestation, not a claim the CRM recalled the email. |
| Send in progress or uncertain | Replacement and blind retries are blocked. Reconcile the existing durable mail operation before resolving its status. No automatic assumption of failure. |
| Partial payment | Record actual amount, date, reference, and confirmation. Records retain a stable payment ID, recorder, timestamp, and remaining balance. Duplicate IDs cannot create a second payment. Amounts cannot exceed the remaining balance. Full-cycle confirmation pays only the remainder in the records. |
| Any recorded payment | The cycle cannot be cancelled or replaced. Preserve that history. Unpaid eligible receipts can enter a supplemental cycle; already allocated earnings cannot enter it again. |
| Proposed reversal, recovery, or dispute | Keep a policy review open until resolved with evidence. Proposed recoveries do not reduce payroll automatically. Adjustments against a partly paid batch are shown separately because the system cannot infer which receipt the partial payment covered. |
| Legacy manual batch | New manual approval/payment endpoints are retired. Cancel only an actually unpaid legacy batch, then review its released receipts in a monthly/off-cycle draft. Previously paid records remain readable. |
| Bounced/rejected commission email | At the next scheduled 8 AM–5 PM Eastern check, feedback is bound to the original provider message, operation, environment, mail kind, and recipient. Send individual copies to the current enabled Owner group, excluding disabled users. Original payroll attachments come from the approved archive. Copy failures do not prevent attempts to the other Owners. |
| Failed Owner copy | Show its own delivery record and alert through the existing operational alarm. A definite failure requires an explicit retry; an uncertain send is held. A bounced Owner copy never recursively creates more copies. |

**Calculation corrections are not arbitrary payroll overrides.** An off-cycle run pays available eligible ledger earnings. It cannot invent an extra carrier receipt, rewrite a frozen historical rate, automatically net a reversal, or recover an overpayment. Use the explicit compensation adjustment workflow below when the correction is not represented by existing eligible receipts.

## Immutable reporting and audit

Approval commits the cycle, receipt allocations, employee batches, report snapshot, compressed original PDFs, and audit record atomically. PDFs have revisioned filenames and SHA-256 digests. Downloads and email attachments use the archived bytes, not later rendering of changed records. Snapshot hashes use canonical field ordering so database map ordering does not change the result.

Owners can view report versions and download historical files with an acknowledgement that they do not authorize another payment. A historical download is marked in its filename and logged. Current financial actions check record versions; conflicting changes fail rather than overwrite another Owner's work. Payment references and audit details remain private to Owners. Employees receive only their own aggregate paid/unpaid amounts and sanitized policy/batch data.

Audit records retain actor, time, record identity, previous/new version, and recorded changes. Report records preserve approved amounts, approver, dates, receipts, and hashes; delivery records preserve recipients, message IDs, report revision/hash, source escalation, acceptance status, provider feedback, and retry state. Payment records retain each individual amount/date/reference. The audit viewer pages through new date-keyed events, then earlier-format records in their original stored order. Older records are not deleted or hidden.

## Confirmed policy-level shared commissions — implemented locally

Ethan confirmed the previously pending agreement terms on November 5, 2026. The approved calculation is **eligible agency cash × employee policy share × that employee’s applicable plan rate**. For a $1,000 receipt, 60% at 20% produces $120; 40% at 16% produces $64. A common commission-pool method is not part of this implementation.

In **Commissions > Shared & exceptions > Approve a shared policy allocation**, select the policy, effective date, employees and shares, retained house share, and agreement evidence. Employee shares plus the explicit house share must total 100%. Each employee needs a configured plan covering the policy’s original commission date: Eastern bind day for new business, policy effective date for renewal. Approval freezes each participant’s plan version, rate, eligibility, and reference. All active Owners may approve; no mandatory second approver is imposed.

The agency receipt is posted once. Separate private employee earnings reference that receipt and approved allocation version. Installment earnings use cumulative integer-cent entitlement for each employee, including fractional shares and differing rates. Agency cash is never multiplied by the number of participants. Employees see only their own earnings; Owner payroll and exports include all participants. Shared-only employees can be selected for off-cycle runs.

Allocation changes must be dated after all posted receipts and the last allocation version. They cannot rewrite historical cash or paid earnings. Reversals and restorations retain their original allocation and appear as review items, never automatic payroll deductions or duplicate positive earnings. Existing single-producer records retain their original amounts, payment history, IDs, and PDFs; no migration rewrites them.

The approved business formula is confirmed. Actual employee plan assignments, policy participants, dates, percentages, and supporting references remain explicit CRM configuration for Ethan to enter and test.

## Departing employees — implemented local review workflow

Create a private departure case in **Shared & exceptions**. Record employment end, optional eligibility boundary and access-disable date, governing agreement/evidence, Owner review date, HR payment due date, and explicit rules for later receipts and renewals. The case starts as a draft and requires Owner approval. Revising terms returns it to draft and places affected outstanding approved payroll reports on review hold. No login is disabled by this form; disabling access elsewhere never forfeits commissions.

The worklist shows original or replacement earnings, eligibility review, employee-batch paid status, estimated outstanding carrier receipts, and unresolved adjustment reviews. Partial batch payments are shown as batch totals because the system cannot infer which individual receipt they paid. Review a held earning with an evidenced **PAY** or **EXCLUDE** decision. Exclusions preserve original cash and calculated earnings in history. Allocated earnings require reopening an unpaid payroll report before an eligibility change; paid history cannot be excluded.

Carrier estimates derive from the policy premium/rate and posted cash. An Owner can document that a carrier balance is final; a later receipt invalidates that resolution and returns the policy to the worklist. Close the case only after pending carrier balances, eligibility decisions, adjustment reviews, and payable amounts are resolved. Cases can be revised if further obligations arise.

An approved case can produce an archived departure review PDF containing its terms, decisions, pending items, and payment status. Identical snapshots reuse the same PDF bytes and hash even if database field ordering changes. Downloads are audited. This document is explicitly a **review statement**; monthly or off-cycle payroll still requires its own approval and payment record. HR enters payment deadlines; the software does not infer statutory deadlines or final-pay entitlement.

## Explicit compensation adjustments — implemented locally

| Type | Result after explicit Owner approval |
| --- | --- |
| Additional earnings | Creates one separate payable earning tied to the policy/employee, reason, evidence, and effective date. It adds no carrier cash and can be paid once through the normal monthly/off-cycle approval. |
| Unpaid correction | Links to an eligible original receipt or employee earning, retains the original value, and replaces its payable allocation with the corrected amount. Allocated amounts require reopening the unpaid report first. A pending correction blocks relevant payroll approval; a draft can be revised or cancelled with a reason. |
| Proposed paid recovery | Links to original earnings and recorded employee payment IDs. The negative amount remains in review and does not reduce payroll or change payment history. Cumulative approved recovery proposals cannot exceed the original employee earnings. |

Drafts preserve original/corrected amounts and evidence; approval requires confirmation and cannot occur before the effective date. Approved records are immutable. Source changes, exclusions, and concurrent modifications are checked again at approval. Additional corrections use linked new records rather than editing historical amounts.

Review items for carrier reversals/restorations or paid recoveries can be resolved with documented agreement and external-resolution evidence. Resolution closes the review only: it does not move money, generate positive payroll earnings, or deduct wages. Any separately approved extra earnings use the additional-earnings workflow. Automatic recovery collection remains outside this release.

## Payroll visual design

The payroll page now uses the existing CRM’s navy/blue palette, spacing, typography, borders, and status badges. Settings and creation tools are styled expandable panels; cycles have a calendar strip, aligned currency totals, a clear review notice, and separate approval/correction areas. Forms, delivery records, report history, and exception workflows share the same components. Layout rules stack fields and date groups on narrower screens.

## Acceptance and release sequence

1. Complete local service, component, PDF, privacy, and concurrency checks with fictional data. Exercise both definitive and uncertain delivery failures without sending real emails.
2. Restore the generated AWS configuration and pass full build/synthesis gates; deploy only to the separately authorized test environment with delivery disabled.
3. Ethan assigns actual plans and checks representative statements, historical paid/unpaid balances, policy/account matches, pending reviews, and payroll dates. Confirm a second and third Owner can approve using their own accounts; employees cannot read any other person's records.
4. Test a partial payment followed by completion; a sent report held by HR and replaced; a late receipt paid off-cycle; an employee whose login is disabled; a bounce copied to all three Owners; and one failed Owner copy without duplication or recursion.
5. Validate the real delivery provider's feedback and the archived summary/employee PDFs in controlled recipient inboxes. Then separately authorize production rollout and enable the existing delivery setting.

Shared allocations, explicit departure reviews, and compensation adjustments are implemented locally under the confirmed terms. Account transfers/house ownership transitions, automatic recovery collection, and automatic final-pay deadline determination remain future scope. No deployment, actual payroll payment, or real email send is included in this local work.
