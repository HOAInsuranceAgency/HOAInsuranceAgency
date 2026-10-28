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
2. For each producer period, optionally enable **GIM Property Management** rates
   and enter both percentages plus the GIM agreement reference. An unchecked GIM
   section means terms are pending, never standard-rate fallback. Explicit zero
   is allowed; blank is not zero. Both schedules use the period's dates; add a
   new period when either schedule changes.
3. In **Account commission classification**, search for the insured account.
   Only the selected classification is loaded; a failed read offers a retry,
   never an empty replacement form. Record dated **Standard** or **GIM Property
   Management · house account** periods and the source/reference supporting the
   decision. GIM is the only house-account program. Every account needs an
   explicit Owner classification before binding. Dates are inclusive; gaps and
   overlapping periods cannot silently pick a rate. A relationship or account
   name alone never determines compensation. When GIM management changes, the
   Owner must update classification periods before the next bind/renewal.
4. Configure each carrier's written/earned/collected-premium basis, remittance
   schedule, and contract reference. These forecast timing; they do not generate
   payable earnings.
5. At bind, confirm the exact commissionable policy premium and agency percentage.
   These must match the accepted quote. Edit the quote first if necessary and
   obtain renewed client authorization when client-facing terms change.
6. The server atomically saves the policy, private commission snapshot, bound quote
   status, and lead conversion. Retries return the same policy. Direct model
   creation and direct transitions to BOUND cannot bypass the workflow.

The assigned producer at bind receives the snapshot. New business selects the
agreement by bind date in America/New_York; renewals select it by effective date.
Renewals require the existing renewal-policy link. Missing agreements or carrier
terms, missing account classification on the commission date, or missing GIM
rates for a GIM account block a new bind with an actionable message. Historical
adoption uses the same selector on the original commission date. Policy snapshots
freeze the classification period/reference/version and selected agreement/rate.
The transaction checks classification and agreement versions against concurrent
Owner edits. Existing snapshots are never recalculated; older snapshots remain
valid and display “Legacy snapshot” in the Owner ledger. No business rates,
classification dates, or GIM membership are seeded by this release. There is no
schema migration; classifications use the existing private, audited ledger.
Direct financial changes to bound policies are rejected; unchanged values can accompany normal service edits.
The Owner can update the carrier policy number from the commission ledger. The
regular policy editor directs tracked-policy corrections there; the server rejects
direct number changes that would leave the commission snapshot out of sync.
Historical policies with missing financial fields still permit ordinary note edits.

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

Payroll discovers policies within the selected producer's index partition and
loads current records in consistent batches of up to 100. Producer self-service
uses the same bounded batch reads; a throttled read fails rather than returning
partial totals.

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
premium/rate and term dates confirmed in the migration form. Missing or incorrect historical term dates can be repaired here by the active Owner; the original dates and supporting evidence remain in the private audit, and the shared policy and commission snapshot update atomically. Current assignment is not used to guess historical ownership.
Search by policy number to select an untracked policy. The search sends its filters
to the backend and reads one page at a time, including continuation through empty
pages. Add a missing number in the existing policy editor before searching.
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

Verification for this implementation: 3,449 tests across 198 files passed; frontend
and backend type checks, the production build, backend synthesis, and whitespace
checks passed. Focused bind/service tests also passed after the final retry guard.
The existing frontend bundle-size advisory remains. The Owner reconciliation and
Producer statement views were visually checked using fictional data. No live
carrier receipt, payroll payment, recovery, or cloud deployment was performed.

## Account-first-bind eligibility cutoff

A producer agreement may set an inclusive **Account first-bind cutoff** and an
independent **Agency receipt eligibility begins** date. An account originally
bound before the cutoff earns zero producer commission on new business and all
later renewals, regardless of its current Standard/GIM classification. This does
not block placing coverage or recording agency receipts: record receipts on an
excluded account as ineligible. The server rejects an attempt to mark them
eligible at both draft validation and posting. Adjustments retain the original
receipt's producer amount. Existing snapshots are not recalculated.

In account classification, the Owner confirms either the original first bind
date (including history outside this CRM) with supporting evidence, or that the
account has never been bound with this agency. Missing history blocks a bind
under a cutoff agreement. A new account's first successful bind records the
agency-local date in the private account record in the same version-guarded
transaction as its policy. It cannot subsequently be reset to never bound.
Existing policy history prevents treating an older account as new; a confirmed
date later than a known policy's bind is rejected. Historical adoption also
requires confirmed first-bind history and checks known policy dates. Pre-cutoff
historical policies can use the cutoff agreement to record explicit zero
entitlement while still tracking agency receipts. Snapshot eligibility includes
the original first-bind date, cutoff, and outcome; later changes do not change it.

For Brian Cole, Jake confirmed on October 28, 2026: agreement and receipt
eligibility begin October 1, 2026; Standard rates are 20% new / 10% renewal; GIM
rates are 10% new / 5% renewal; accounts originally bound before October 1 remain
excluded from commissions on all later renewals. October 1 itself is eligible.
These are configuration requirements, not seeded global defaults. Other
producers' agreements remain independently configurable.
