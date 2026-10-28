# Producer commission process and CRM implementation plan

Status: process accepted for implementation. Initial operational release implemented on the isolated branch; see [the implementation and rollout guide](../PRODUCER-COMMISSIONS.md) for supported behavior and remaining extensions. Not deployed.
Prepared October 28, 2026, from repository commit `8fdbf02` and the two supplied drafts.
Isolated branch: `codex/producer-commissions`.

## Confirmed requirements

- At bind, producers confirm the exact policy premium and exact agency commission percentage for each policy, including every policy within a package.
- Producer compensation is a percentage of agency commission, never a percentage of premium.
- **Confirmed by Jake:** reconciliation is restricted to the active Owner role, including server access and private source documents.
- **Confirmed by Jake:** configure rates individually for each producer; do not automatically apply either draft's rates. Maintain separate new-business and renewal rates with effective dates.
- Producer payments follow the agency's actual carrier commission receipts, whether the carrier calculates commission on written premium or pays over time.
- Reconcile CRM expectations to carrier statements and actual settlement before releasing payments.
- Track a proportional producer adjustment when the carrier reverses agency commission. Recording the adjustment and recovering money through payroll are separate operations.

The attached documents are comparison evidence, not instructions to change employment terms, set rates, send communications, or move money.

## Comparison with the supplied drafts

Sources: `Insurance_Business_Development_Agent_Job_Description_and_Commission_Plan_DRAFT.docx` (Business Development draft), and `HOA Insurance Agency Insurance Agent Job Description - EXECUTIVE DRAFT.docx` (Executive draft), supplied from Downloads.

| Topic | Business Development draft | Executive draft | Consequence for this process |
| --- | --- | --- | --- |
| Producer rates | Section 04: 16% new / 8% renewal | Compensation plan: 20% new / 10% renewal | Actual individual agreements must supply rates. Neither draft becomes a global default. |
| Commission base | Net agency commission revenue actually received; never premium | Net agency commission revenue; revenue must be received | Matches the request. Premium × agency rate is an expectation, not payable producer compensation. |
| Payout schedule | Section 05: last regular payroll of receipt month; cutoff one week before payroll processing; later receipts roll to following month | Payment after bind, receipt, and complete documentation; no equivalent detailed cutoff | Adopt only after the actual payroll calendar and cutoff interpretation are confirmed. Carrier receipt timing and payroll timing are distinct. |
| Installments | Receipt-based earnings but no explicit rules for multiple installments or carrier payment basis | Also lacks installment mechanics | Add explicit per-receipt treatment without advancing the unpaid remainder. |
| Qualifying transactions | Sections 03/07: initial bind and later renewals; excludes endorsements, midterm upsells, and added coverage during the term | New-account and renewal incentives; no equivalent explicit endorsement exclusion | Proposed initial scope follows the narrower draft. Confirm exclusions before activating a producer plan. |
| Cancellation before receipt | Sections 03/07: no commission if cancellation/rescission occurs before agency receipt | Broad cancellation/nonpayment adjustment discretion | Could differ from a pure “share every carrier receipt” approach, especially retained earned premium received after cancellation. Requires an explicit policy decision. |
| Chargebacks | Section 06 allows offsets/withholding for returned commissions, but also describes earned commissions as wages and protects earned amounts | Broad adjustment/offset discretion | Neither specifies a proportional formula, recovery cap, dispute process, or lawful deduction procedure. Do not interpret either as blanket payroll deduction authority. |
| Shared production | Written leadership split at or before bind; no split reduction after earning | Broad shared-lead discretion | Freeze agreed allocations with the policy term. |
| Eligibility | License at transaction; complete underwriting/CRM; personal contribution to new business; active management of renewals | Similar conditions, plus satisfactory performance | Record eligibility evidence and unresolved exceptions; do not quietly convert missing evidence into zero compensation. |
| Rate changes / separation | Prospective written changes; pre-separation new binds remain commissionable on later receipt; renewal terms beginning after separation excluded; special final-pay deadlines | General final-offer/policy/approval qualification | Preserve plan versions and employment dates; do not delete historical obligations when a user is disabled. |
| Other compensation | Commission additional to base salary | Salary range and quarterly performance bonus | Salary/bonus rules remain separate from this commission ledger. Their omission here does not amend an agreement. |
| Effective date | Printed as “October 1, 20226” | No matching commission effective date established | Correct the typo and confirm the intended date before using that draft as an agreement. |

### Material chargeback limitation

The proportional calculation is straightforward; recovering already-earned compensation is a separate employment-law question. The Business Development draft expressly invokes Massachusetts law. Massachusetts guidance limits deductions from pay, and its Wage Act covers commissions once definitely determined and due and payable. These sources do not establish that this proposed cancellation chargeback is lawful.

Use the CRM to calculate and document a **proposed recovery**, with actual collection disabled until the applicable agreement and recovery method have been reviewed by Massachusetts employment counsel. Owner approval or an employee signature alone should not be represented as legal authorization. Do not automatically reduce base salary, other earned wages, final pay, or future earned commissions. A separate repayment demand is not an assumed workaround.

Sources checked October 28, 2026: [Massachusetts pay and recordkeeping guidance](https://www.mass.gov/guides/pay-and-recordkeeping) and [M.G.L. c.149 §148](https://malegislature.gov/Laws/GeneralLaws/Parti/Titlexxi/Chapter149/Section148). Counsel should also reconcile the draft's receipt-based earning language, monthly cutoff, and final-pay rules; administrative reconciliation must not silently postpone legally due wages.

## Recommended operating process

### 1. Configure producer agreements and carrier payment terms

Owner manages a private commission plan for each producer: new-business percentage, renewal percentage, effective dates, agreement reference/version, qualifying transactions, and separation treatment. Blank means unresolved; explicit 0% means an agreed noncommissionable allocation. Reject overlapping effective periods. Preserve salary settings separately.

Select the agreement/rate in force for the qualifying bind or renewal event, using a defined date rule in the agreement. Freeze that version on the policy term. Do not recalculate historical earnings from today's account assignment, employment status, or current rate. Renewals create new term snapshots and can use a newly effective agreement.

Carrier configuration records separately:

- Commission calculation basis: written premium, earned premium, collected premium/installments, or a documented other arrangement. Do not assume earned premium and premium collection are synonymous.
- Remittance cadence and expected lag; these predict receipts, not earnings.
- Agency billing versus direct billing; this already exists in the CRM and is independent of commission calculation basis.
- Carrier/program/line-specific rate defaults and overrides, settlement payor (including MGA/wholesaler where applicable), and source agreement.

Copy the applicable carrier terms to each policy term. Defaults assist entry but do not substitute for confirmation of the actual agency rate. Do not infer payment terms for existing carriers.

### 2. Confirm each policy at bind

Show a bind summary with carrier/payor, policy term, transaction classification, producer attribution, exact premium, agency commission percentage, commissionable premium basis, and estimated agency commission.

- Require exact USD premium to cents and agency percentage to the supported precision; accept explicit 0% but not a missing rate. Separate taxes, fees, and financing interest from commissionable premium. Preserve additional decimal precision for carrier rates when needed rather than silently rounding them.
- Prefill from the quote but require confirmation. Changed client-facing premium/coverage terms must follow existing client reauthorization rules before binding.
- Identify NEW BUSINESS, RENEWAL, or excluded/nonstandard transaction explicitly. Use renewal-policy linkage as evidence, not the account's current LEAD/CLIENT status alone.
- Save original producer(s), their applicable agreement versions/rates, and written split evidence. Account reassignment later changes servicing access, not compensation ownership.
- Proposed shared-production convention: allocate the agency revenue between producers using written attribution weights totaling 100%, then apply each producer's own rate to their allocation. If agreements split a producer commission pool instead, record that different convention explicitly; never interpret one percentage as both kinds of split.
- A selected package has policy-level amounts and terms. Sum those records for its display; do not create an additional payable package commission. Allow different carriers, rates, and payment schedules within the package.
- A missing policy number may be resolved later through a unique internal bind reference, but block automatic statement matching until identity is unambiguous.
- Binding records expected commission only. It does not record a carrier receipt or create a payroll payment.

The server must validate the bind and snapshot together, with idempotency and a unique quote-to-policy constraint. A browser-only required field would leave direct API writes and concurrent binds unprotected. Missing producer agreement/split configuration needs owner resolution; any operational exception permitting coverage binding must remain visibly unconfigured and must not invent a pay rate or erase later entitlement.

### 3. Receive and reconcile carrier statements

An Owner initially handles reconciliation. A future delegated accounting role can be introduced explicitly; existing Admin/Staff access must not automatically expose private pay data.

1. Upload the original statement or enter a statement with its source attached. Support a mapped CSV import and reviewed manual lines first. PDF extraction may suggest values later but cannot post financial entries without review.
2. Record payor, statement identifier/period, file fingerprint, currency, control total, receipt/settlement date, settlement reference, and positive/negative line amounts. Store original values and all mapping changes.
3. Match each line to one policy **term** and transaction using payor/carrier, policy number or approved alias, effective dates, and source transaction ID. Account name alone is insufficient. Ambiguous matches stay in an exception queue.
4. Compare statement premium/base/rate, when supplied, and agency commission with the bind snapshot and applicable installment schedule. Distinguish partial receipt from a true short payment. Missing statement fields remain unknown.
5. Tie statement totals to actual settlement evidence. A statement date is not a cash receipt date. Allow multiple statements per deposit, multiple deposits per statement, withheld offsets, and a zero-net settlement made of positive and negative lines; allocated amounts must balance and cannot be reused.
6. Resolve exceptions with the original premium/rate, carrier value, variance, explanation, evidence, and reviewer. Preserve the original bind snapshot; use an adjustment or approved corrected version rather than rewriting history.
7. Post reconciled signed agency revenue entries and their producer allocations once, in the same transaction as the approval/audit event. Unmatched money remains in suspense and earns no invented allocation.

For **agency-bill** business, commission may be retained from collected premium instead of arriving as a carrier deposit. Record the validated retained commission and carrier remittance/account-current evidence as a distinct settlement type. Do not count both retained commission and a later statement of the same amount as two receipts. The agreement must define when this constitutes agency receipt.

Duplicate protection must cover file reimports, the same statement in a different format, reused line IDs, repeated approvals, and duplicate deposit allocations. Corrected statements produce linked differences/reversals, not a second copy of the original earnings. Every posted correction remains traceable to its source.

Define “net agency commission” as the agency's actual commission entitlement for the matched transaction after specifically identified carrier/MGA commission adjustments. Exclude premium itself, taxes, noncommission fees, finance income, salary, and general overhead. Do not subtract a producer share or a carrier charge already netted into the statement a second time. An aggregate net deposit is not a substitute for policy-level signed entries.

### 4. Calculate producer earnings from receipts

For each eligible producer allocation:

`producer amount = reconciled net agency commission × attribution weight × frozen producer rate`

Maintain distinct dates for binding, policy effectiveness, carrier statement, actual receipt, reconciliation approval, earning, payroll eligibility, and payment. Record actual earning facts even if reconciliation is entered later. Late reconciliation must create an overdue-pay exception when appropriate, not move the receipt date forward.

Use integer cents and scaled decimal percentages. Calculate cumulative rounded entitlement within each fixed policy-term/producer/rate allocation, then post the difference from previously recorded entitlement. This prevents repeated installments from adding rounding pennies. Use a documented allocation/remainder rule so producer, agency, and reversal totals reconcile exactly.

Written-premium example: $100,000 premium × 12% agency rate = $12,000 expected agency commission. At an illustrative 16% producer rate and 100% attribution, expected producer compensation is $1,920. If the carrier actually settles $12,000 at once and eligibility is satisfied, $1,920 becomes earned. Binding alone earns no receipt-based commission.

Installment example: on the same policy, twelve actual $1,000 agency commission receipts produce $160 producer earnings per receipt, totaling $1,920. If only three payments arrive, recognized producer earnings are $480; the remaining $1,440 stays expected, not payroll payable. These figures are examples, not configured rates or an assumed carrier schedule.

### 5. Prepare payroll and producer statements

Once the payout rule is confirmed, configure real payroll processing dates, pay dates, and an explicit cutoff timestamp in America/New_York. The Business Development draft says one week before **processing**, which may differ from the pay date. Confirm calendar versus business days and the inclusive cutoff boundary rather than guessing.

- Show each producer's expected amount, received agency revenue attributable to them, earned amount, unpaid amount, scheduled amount, paid amount, and proposed/recovered chargebacks separately.
- Create a payroll batch from eligible, reconciled, unpaid ledger allocations. Lock the included entries so two batches cannot claim the same amount. Preserve the cutoff used.
- Owner reviews and exports an itemized payroll file/statement. A draft or exported file is not evidence of payment.
- Mark paid only after payroll confirmation with pay date and reference. Handle rejected/cancelled exports and partial payment without duplicating successful payments.
- Each producer statement includes policy/account, term, transaction, agency receipt amount/date, producer rate and attribution, earnings, approved adjustments, actual recoveries, and payment details. Provide a dispute channel tied to the line.
- Keep separation/final-pay exceptions visible with their own deadlines. Disabled users' balances and future eligible receipts remain payable through the agency's process; disabling access must not cancel compensation.

Recommended payroll states: DRAFT → APPROVED → EXPORTED → PAID, with explicit failed/cancelled outcomes and recorded payment allocations. Recovery has a separate approval/status path and never silently reduces the earned subtotal.

### 6. Record cancellations and proportional reversals

Cancellation status alone does not prove a carrier chargeback. Reduce the future forecast as appropriate, but post an agency reversal only from verified carrier adjustment/settlement evidence. Keep all prior positive earnings and payments visible.

Link each reversal to the original receipt(s), policy term, producer attribution, and frozen rates. For a $2,000 reversal of agency commission originally allocated entirely to a producer at 16%, proposed producer recovery is $320; the agency's share of the reversal is $1,680. Do not charge the producer the full $2,000 or recalculate using their current rate.

- Traceable reversal of an unearned forecast removes an expectation; it is not a debt owed by the producer.
- Reversal affecting earned but unpaid compensation creates a proposed adjustment for review, not an automatic wage forfeiture.
- Reversal affecting paid compensation creates a proposed recovery, with a cap based on the original attributable paid commission less prior recoveries. Do not recover more than was paid on the affected amount or allocate unrelated carrier penalties to the producer.
- For partially paid earnings, identify the paid and unpaid portions independently. A single reversal cannot generate both a wage reduction and a duplicate recovery for the same portion.
- Additional carrier losses beyond the original attributable commission stay agency-side exceptions; they are not automatically producer debt.
- If recovery is lawfully authorized, record the exact method, schedule, amount, evidence, and approval. Track outstanding balance separately from current payable earnings. Partial recoveries and reinstatement/refunds need linked entries.
- If a carrier restores commission, link restoration to the reversal: restore any reversed entitlement and return actual recovered amounts as applicable, without paying the same original entitlement twice.

Proposed recovery states: PROPOSED → UNDER REVIEW → AUTHORIZED or WAIVED/DISPUTED → PARTIALLY RECOVERED → RECOVERED. A calculation or Owner approval alone does not authorize deduction. Approved recovery methods remain a decision before rollout.

## CRM changes grounded in the current repository

| Existing behavior | Required change |
| --- | --- |
| `crm/src/components/QuotesPanel.tsx`: bind copies quoted premium and agency rate; premium is checked but commission percentage is not required | Exact bind confirmation, required agency rate, authoritative server bind, immutable financial snapshot, safe retry/recovery |
| `crm/src/components/QuotePackages.tsx` and `shared/quotePackages.ts`: packages group quotes and estimate agency commission | Per-policy confirmation and term snapshots; package totals remain sums only |
| `crm/amplify/data/resource.ts`: Quote/Policy use optional float premium and commission fields; Policy has no compensation snapshot | Add compatible provenance fields and private financial records; retain readable legacy data and integer monetary representation in the ledger |
| Carrier stores `standardCommissionPct`; Policy stores bill type | Separate carrier commission basis, remittance schedule, payor, and policy-term overrides |
| `shared/employeeProfitability.ts` / `crm/src/pages/OwnerProfitability.tsx`: one dated producer share and salary | Separate dated new/renewal commission agreements; preserve salary history; explicitly migrate existing single-rate settings rather than assuming they mean both rates |
| Profitability uses effective dates, current salesperson assignment, and excludes cancelled policies | Preserve the existing labeled estimate; add actual receipt/earning views from historical snapshots. Never use that estimate as the payroll ledger or erase cancelled-policy receipts |
| Private compensation handler/storage already protects salaries and pay history | Reuse its active-Owner checks, version checks, and private audit conventions. Add sanitized producer self-service views that reveal only their own commission records, never salary or colleagues' rates |
| `crm/amplify/functions/crm-access/policy.ts` and related access handlers classify operations and enforce record access | Explicitly authorize new bind, statement, ledger, batch, recovery, download, and producer-self operations; prevent direct model mutation bypasses |

### Proposed records and controls

| Record | Minimum facts |
| --- | --- |
| Producer agreement version | Producer ID, new/renewal rates, effective rule/dates, eligibility, source agreement, approval, version |
| Policy commission snapshot | Policy/quote/account/package references, term, transaction type, bind time, premium/base in cents, agency rate/precision, carrier terms, producer allocations and agreement versions |
| Carrier statement and source line | Payor, statement ID/version, file hash/reference, period/control totals, original signed amounts, policy match, source transaction identity, variances, reviewer |
| Settlement and allocation | Receipt/retention/net-offset evidence, date, amount, currency, bank/remittance reference, allocation amounts and available balance |
| Commission ledger entry | Stable source identity, policy term, signed agency amount, producer earnings/allocation, receipt and earned dates, original/reversal/restoration links, audit actor/time |
| Payroll batch/payment allocation | Processing/pay dates, cutoff, included ledger IDs, immutable totals, export identity, actual payment references/amounts |
| Recovery case/collection | Original paid allocations, carrier reversal, proposed amount, actual collections, authorization evidence, outstanding balance, dispute/waiver/restoration history |

Keep financial documents and detailed compensation audit records private. Existing account-document or activity access must not leak carrier statements covering multiple producers or compensation details. General account activity may show a sanitized event reference only. Producers access their own historical compensation by producer identity even after an account is reassigned, without automatically gaining the reassigned account's other private records.

All posting, payment allocation, and recovery commands need server-side authorization, optimistic version checks, durable idempotency, and atomic ledger/audit changes. Paginated reads must either cover the full selected scope or report incomplete totals. Use indexed policy, producer, carrier, statement, and payroll lookups for reconciliation instead of scanning the whole book. Protect retention and backups consistently with existing private compensation storage.

## Implementation sequence and acceptance evidence

1. **Agreements and bind capture.** Finalize the decisions below; add dated rates and carrier terms; implement server binding and policy-level snapshots. Test exact cents/rates, missing vs zero values, renewals, mixed-carrier bundles, stale quotes, changed authorization, concurrent binds, and interrupted retries.
2. **Statements and receipts.** Build upload/manual/CSV entry, term matching, receipt allocations, exception review, private storage, and signed posting. Test duplicate/corrected statements, partial receipts, zero-net settlements, agency-bill retention, ambiguous terms, changed premiums/rates, and controls that do not balance.
3. **Producer earnings and payroll.** Add cumulative calculation, self statements, reviewed batches, exports, and payment confirmation. Test installment rounding, split producers with different rates, frozen historical ownership, cutoff boundaries, late reconciliation, separation deadlines, denied access, and duplicate/partial payroll confirmation.
4. **Reversals and recovery.** Add original-allocation matching, capped proposed recoveries, authorized collection tracking, disputes, and reinstatement. Test partial/full/repeated reversals, changed producer rates, paid vs unpaid amounts, agency-only excess losses, and restoration without duplicate earnings. Keep collection unavailable until the recovery policy is settled.
5. **Migration and staging acceptance.** Rebase against current staging and coordinate the other chat's changes before implementation. Backfill only evidenced original rates/ownership; do not infer historical payroll from current assignments. Reconcile opening balances from statements and payroll records with explicit migration entries. Legacy policies remain readable but flagged where financial setup is incomplete. Validate representative real carrier statements against payroll results in staging before enabling payout preparation.

Production activation requires a cutoff date preventing overlap with prior payroll, reconciled opening balances, completed role/access tests, and a first-period tie-out: agency settlements ↔ signed agency ledger; producer earnings ↔ unpaid/paid allocations; recoveries ↔ actual collected/refunded amounts. No live deployment or movement of money is included in this planning change.

## Decisions still required

The individual-rate approach is confirmed. These remaining choices must be settled before activating the affected behavior:

1. Implementation was authorized by Jake. Reconciliation must remain Owner-only. Actual agreements and deployment acceptance remain necessary before use.
2. Identify each producer's actual signed rates, effective dates, and eligibility terms. Confirm the date used to select a renewal's rate and correct the draft's effective-date typo.
3. Confirm payout cadence and the actual payroll calendar/cutoff. If using the Business Development draft's rule, resolve processing date versus payday and calendar versus business days.
4. Confirm whether carrier receipts for retained earned premium arriving after cancellation earn a producer share. The Business Development draft currently excludes pre-receipt cancellations. Also clarify eligibility for later installments after cancellation and post-separation renewal receipts; do not infer these outcomes from the account's current status.
5. Confirm endorsement/midterm/new-line exclusions, the definition of actively managed renewals, shared-production allocation convention, and whether any house-account exceptions apply.
6. Finalize the lawful chargeback/recovery procedure and treatment of earned-but-unpaid commissions with counsel. A proportional CRM calculation alone does not settle payroll deduction rights.
7. Supply representative statement formats and carrier payment terms for implementation acceptance. Define agency-bill retained-commission receipt treatment and any carrier-specific net-revenue adjustments.

These decisions do not prevent building data capture, expected-versus-received reporting, reconciliation, or proposed-recovery tracking. They do prevent silently inventing compensation terms or applying unapproved payroll recovery rules.
