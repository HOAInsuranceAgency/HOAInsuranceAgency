# Producer commissions

The **Commissions** page separates policy forecasts, actual agency receipts,
producer earnings, payroll allocations, and proposed adjustments. All ledger
amounts are USD cents. No producer rates are seeded.

## Access

Only the **active Owner role** can configure agreements/carrier terms, upload or
download original statements, enter reconciliation lines, post statements,
prepare/confirm payroll, or add historical policies. An Owner using a separately
assigned Admin view has no reconciliation authority in that view. The schema,
request guards, and service handler enforce this independently of the interface.
Disabled/revoked sessions are checked before financial access.

Other roles can read/export their own commission records. The authenticated user
ID controls that scope; a caller cannot select another producer. Their response
excludes agreements, source statement files, owner review notes, and carrier
contract evidence. Historical commission ownership survives account reassignment.

The ledger and statement files use separate private storage, encryption,
retention, and backups/versioning. Shared policies contain only the snapshot ID.
Private statement uploads are immutable and download links last sixty seconds.

## Setup and binding

1. In **Agreements & carriers**, choose a teammate and enter dated new-business
   and renewal rates and an agreement reference. Periods cannot overlap; explicit
   zero is permitted. Salary remains in the existing owner pay settings.
2. Configure each carrier's written/earned/collected-premium basis, remittance
   schedule, and contract reference. These forecast timing; they do not generate
   payable earnings.
3. At bind, confirm the exact commissionable policy premium and agency percentage.
   These must match the accepted quote. Edit the quote first if necessary and
   obtain renewed client authorization when client-facing terms change.
4. The server atomically saves the policy, private commission snapshot, bound quote
   status, and lead conversion. Retries return the same policy. Direct model
   creation and direct transitions to BOUND cannot bypass the workflow.

The assigned producer at bind receives the snapshot. New business selects the
agreement by bind date in America/New_York; renewals select it by effective date.
Renewals require the existing renewal-policy link. Missing agreements or carrier
terms block a new bind with an actionable message. Direct financial changes to
bound policies are rejected; unchanged values can accompany normal service edits.
The Owner can update the carrier policy number from the commission ledger.

Each package policy binds separately and retains its own carrier/rate snapshot.
There is no additional package-level payable amount. Existing profitability charts
remain clearly labeled estimates and do not drive payroll.

## Reconciliation

An Owner uploads the original PDF/CSV/XLSX/image and enters reviewed statement
lines. Uploads preserve the source; this release does not automatically extract
or map carrier files. Each reconciliation batch supports up to twenty lines.

Each line identifies a specific policy term, unique carrier transaction reference,
signed agency commission, transaction type, and eligibility/variance evidence.
Optional carrier premium basis and commission percentage show their calculated
commission and difference from the line amount. Compare installment bases with
the carrier's payment terms; a partial payment is not automatically a shortfall.

The Owner records actual receipt date, verified settlement allocation total,
unique settlement/allocation reference, and whether it is a deposit, retained
agency-bill commission, or net settlement/offset. Line amounts must equal the
control total, including negative and zero-net settlements. Large statements may
use separately identified, non-overlapping allocations with their own verified
control totals. Bank evidence is reviewed by the Owner; there is no bank feed or
automatic aggregate bank-deposit allocation in this release.

Saving creates a draft. Posting requires explicit confirmation and atomically
writes every affected policy, statement status, source-transaction locks,
settlement lock, and private audit. Concurrent edits or duplicate references fail
without partial posting. Posted statements cannot be edited. Corrected carrier
transactions use new references and linked adjustments, never overwritten history.

Eligibility is reviewed against the applicable agreement, including licensing,
documentation, cancellations, separation, and transaction exclusions. No draft's
eligibility language or global rate is silently applied. An ineligible receipt
still records agency revenue and zero producer earnings with an explanation.

## Earnings and payroll

Eligible actual agency commission is multiplied by the frozen producer rate.
Cumulative integer arithmetic prevents installment rounding drift. Binding alone
creates no earnings. Agency-bill retained commission is recorded once as its own
settlement type; a later statement describing it is not another receipt.

An Owner selects the inclusive receipt-date cutoff and pay date using the actual
agreement/payroll calendar. The app does not guess a monthly payroll date or
calculate the draft's ambiguous “one week before processing” cutoff. Late
reconciliation retains the original receipt date; review any overdue obligations.

Approving a batch reserves positive, unpaid earnings. Export its itemized CSV/PDF
for payroll. Export is not payment. Record the actual pay date and confirmation
reference only after the full batch has been paid. An unpaid/rejected batch can
be cancelled to release its allocations. Duplicate confirmations do not pay an
entry again. Partial payroll payment tracking is not available in this release;
use batches that payroll will settle in full.

Reads verify that payment allocations and policy entries agree; a concurrent
write or incomplete source fails the view rather than showing misleading totals.
Views are bounded at 5,000 records per category and policy histories at 500 entries;
exceeding those limits requires archival/report partitioning rather than partial
totals. Normal policy terms should remain well below those limits.

## Reversals and recovery

A carrier reversal must link to an original receipt on the same policy, remain
within its unreversed amount, and use the original producer earnings allocation.
A restoration links to the original reversal, restoring agency revenue and
reducing proposed recovery without earning the same producer commission twice.
A restored commission can itself be reversed if the carrier reverses it again.

The UI separates proposed recoveries of **paid** commissions from adjustments
requiring review of **unpaid** earnings. Neither is deducted automatically. The
proposed recovery cannot exceed the producer earnings attributable to the reversed
receipt. Carrier losses beyond the original amount require separate treatment.

**Collection remains disabled.** There is no payroll deduction or external money
movement. Finalize the applicable lawful recovery policy before adding collection,
repayment, waiver, and dispute administration. This preserves the compensation
issue identified in the supplied drafts instead of turning it into an automatic
salary or wage deduction.

## Historical policies and rollout

Owners can add an existing policy using documented original producer attribution,
original bind date, transaction classification, agreement history, and policy
premium/rate confirmed in the migration form. Current assignment is not used to guess historical ownership.
Then reconcile original receipts and previously paid payroll with their actual
dates/references. Establish a cutover date to avoid paying historical earnings
again. This is an explicit migration, not an automatic backfill.

Before deploying, confirm actual producer agreements, carrier terms, payroll
cutoffs, and opening balances. Stage representative written-premium,
installment, retained-commission, reversal, and restoration statements. Verify
both Owner and Producer sessions. Backend deployment requires the new private
ledger, private statement bucket, function, and API operations before the new
frontend can use them. Refresh existing browser sessions after release.

The initial release supports one producer per policy. Written multi-producer
splits, carrier-program-specific overrides, automatic statement extraction/import,
automatic payroll-calendar scheduling, partial payroll settlements, and authorized
recovery collection remain separate extensions from the broader process design.

## Local verification

Run `npm run test:run`, `npm run typecheck`, `npm run build`, and
`npm run synth:check` from `crm`. When reusing dependencies through a worktree
symlink, run synthesis with `NODE_OPTIONS=--preserve-symlinks` so Amplify resolves
its build assets inside the worktree project root.

The [fictional-data preview](../crm/scripts/commissions-preview/README.md) renders
the production components without authentication, CRM requests, or money movement.
See [the design and draft comparison](specs/producer-commission-process.md) for
business decisions and the original document differences.

Verification for this implementation: 3,434 tests across 198 files passed; frontend
and backend type checks, the production build, backend synthesis, and whitespace
checks passed. Focused bind/service tests also passed after the final retry guard.
The existing frontend bundle-size advisory remains. The Owner reconciliation and
Producer statement views were visually checked using fictional data. No live
carrier receipt, payroll payment, recovery, or cloud deployment was performed.
