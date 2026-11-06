# HOA Insurance CRM — Commission acceptance test plan

Prepared November 5, 2026. All dates below are Eastern time. All names, policies, references, and amounts are fictional.

## Start here: what the current preview can prove

The localhost preview is a read-only component demonstration. It has no authenticated users or writable commission database. You can inspect screens, type into forms, exercise local CSV mapping, and export the displayed ledger through its Download menu. Saves, posting, payroll approval/payment, and actual private archive retrieval are blocked. The Sample PDFs gallery and supported payroll controls provide fictional, watermarked reports generated with the production renderer. Reloading resets unsaved form values.

A rejected save in this demo does NOT prove that the backend validated a split, a date, or an amount. The fixture rejects all writes. The role=producer URL only changes the sample view; it is NOT an authorization test.

The sections below deliberately separate:
- P01–P07: checks you can perform at the current link.
- T01–T20: a complete sequential financial test in a writable, isolated staging environment.
- E01–E08: independent edge-case tests in clean test snapshots.
- O01–O07: access, audit, concurrency, and delivery acceptance.

Do not enter actual employees' earnings or treat sample payment confirmations as payroll instructions. The staging tests only record fictional outcomes; they do not require ADP entry or a bank transfer.

## Current preview walkthrough

### P01 — Shared ledger amounts

Open http://127.0.0.1:8792/?scenario=shared and select Ledger.

| Check | Expected |
| --- | ---: |
| Cedar HOA / POL-1 positive agency receipt | $2,000.00 |
| Cedar carrier reversal | −$500.00 |
| Cedar net agency cash | $1,500.00 |
| Cedar original employee earning, at 16% | $320.00 |
| Cedar proposed unpaid adjustment | $80.00 |
| Maple Court / SHARED-102 agency receipt | $1,000.00 |
| Maple: Avery, 60% share × 20% plan rate | $120.00 |
| Maple: Jordan, 40% share × 16% plan rate | $64.00 |
| Overall agency received | $2,500.00 |
| Overall employee earnings | $504.00 |
| Paid / unpaid | $0.00 / $504.00 |

The reversal must not automatically reduce the $320 original earning. Shared earnings total $184, not $1,000 and not a common 20% pool. The sample combines a legacy solo rate of 16% with a separately frozen shared allocation at 20% for Avery; do not use the current plan dropdown to recalculate a historical line.

Use the ledger Download menu: CSV spreadsheet, then Print / save PDF. The printout uses the same HOA branding as payroll PDFs, grouped columns for Letter paper, source references, a ledger-only financial summary, and a test-data marking in the fictional preview. The transaction section records agency cash once; the employee-allocation section separately lists $120 and $64 and has no additional agency-cash amount column. These are display exports, not approved payroll PDFs.

### P02 — Payroll layout and calendar

Select Payroll. Both open sample months show Avery $440, Jordan $64, total $504. They are independent previews of the same unallocated fixture, not two approved obligations; do not add them together.

| Field | October 2026 | November 2026 |
| --- | --- | --- |
| Receipt cutoff, inclusive | October 23 | November 20 |
| Owner review | October 24 | November 21 |
| HR due / processing | October 26 | November 23 |
| Pay date | October 30 | November 27 |

Expand Report delivery settings, Add a payroll month, Add an off-cycle payment, and Edit payroll dates. Check that labels, fields, buttons, totals, and confirmation controls are readable and aligned. Automatic delivery must be unavailable in this local environment. Checking the review acknowledgement must not overcome the fictional-preview approval blocker.

Resize the browser to approximately 1440, 768, and 390 pixels wide. Panels and form fields should stack; table content may scroll inside its own container. Check long policy/employee names, keyboard Tab focus, Space/Enter on expandable panels, and 200% browser zoom. Record clipped labels, overlapping buttons, or page-wide horizontal scrolling.

### P03 — Partial payment and report history display

Open http://127.0.0.1:8792/?scenario=exceptions and select Payroll.

- November: APPROVED, revision 2, replaces revision 1.
- Total $320; recorded paid $120; remaining $200.
- Individual Avery payment panel also shows $200 remaining.
- The report-replacement/cancellation controls must not allow replacing a partly paid report.
- Approved report versions includes revisions 1 and 2. Historical download requires its acknowledgement; supported November sample downloads return the corresponding watermarked sample. This does not verify private archive retrieval.
- Delivery history shows acceptance status SENT and separate Bounce feedback. SENT is not proof of delivery or payment.
- These are prebuilt display states. You cannot complete the remaining $200 or cause a new bounce/Owner copy here.

### P04 — Employee view

Open http://127.0.0.1:8792/?scenario=shared&role=producer.

- Avery's own total is $440 and the visible shared earning is $120.
- Jordan's $64 earning and Owner management tabs must not appear in the rendered employee view.
- This checks presentation only. Real cross-user/API privacy is O01 below.

### P05 — Test exception forms in the read-only preview

Return to the shared Owner preview and select Shared & exceptions.

| Form | Values to type |
| --- | --- |
| Approve a policy commission allocation | Policy SHARED-102; Apply to receipts from 2026-11-01; Avery share 60; Jordan share 40; retained house 0; reference PREVIEW-SPLIT-01 |
| Create a departure review | Jordan; employment end 2026-10-20; eligibility boundary blank; access disabled 2026-10-21; Owner review due 2026-10-21; HR payment due 2026-10-30; both receipt treatments Review each earning; reference PREVIEW-DEPARTURE-01; evidence Fictional review only |
| Create a compensation adjustment | Policy SHARED-102; Avery; Additional earnings; 25.00; effective 2026-10-23; reason Fictional additional earning; evidence PREVIEW-ADJUSTMENT-01 |

Leave the allocation acknowledgement unchecked first: approval should be disabled. Check it and attempt to save each completed test form only to confirm the preview's expected refusal. No new allocation, case, or earning should persist after reload. Jordan is used for the new departure draft because Avery already has an approved fixture case and is correctly excluded from the selector. Use new fictional cases, not the already approved fixture departure, when doing the writable tests.

### P06 — Preview CSV mapping

On Reconciliation, create a new reconciliation form, choose Harbor Mutual, and attach preview_mapping.csv from the acceptance-data folder. Expand Import CSV / XLSX rows and click Read attached statement.

Map Policy, Reference, Amount, Effective, Transaction to their corresponding fields. Expected: two draft lines, matching POL-1 and SHARED-102, agency total $1,000. Confirm the mapping and use the draft lines. They must start Pending review, not posted earnings.

The preview reads this CSV/XLSX locally and labels it “Local preview only — not uploaded or saved.” It supplies no private-storage evidence key, so saving/posting cannot complete. This exercise tests file parsing, mapping acknowledgment, and draft screen behavior only.

### P07 — Sample departure display

On Shared & exceptions, expand Avery's approved departure case.

Expected: employment end September 30; later receipts and renewals set to review; original earnings $320 and shared earnings $120 held for eligibility review. Expected agency receipts are estimates: Cedar $12,000 expected versus $1,500 received; Maple $12,000 expected versus $1,000 received. They are not additional employee earnings.

The payroll fixture and departure fixture are independent display samples; the demo does not run the complete server approval-blocker workflow between them.

## Writable staging prerequisites

The full test below requires an isolated, writable staging deployment of this implementation, generated cloud configuration, private ledger/storage, and real test authentication. It cannot run at the current demo link. A migration preview that intentionally blocks business actions is also unsuitable.

As of November 6, the existing migration-staging branch has been released from migration-preview mode, but its inspected deployment (7194baf0) does not contain the new payroll module. The local commission implementation still needs integration and deployment; the existing staging URL is not sufficient.

The developer should:
1. Prepare a clean test dataset and a repeatable reset/checkpoint procedure. Never reset production or edit/delete paid records to manufacture a test reset.
2. Provide three active Owner test logins, two producer logins named QA Avery and QA Jordan, and one non-Owner administrative/staff login. Names here are placeholders for isolated test identities.
3. Create the fictional CRM accounts, carrier, and policies listed below through the normal CRM setup. Make their policy numbers and carrier exact. No real customer records are needed.
4. Keep automatic report delivery disabled. Use hr@example.test and owner@example.test as non-delivery placeholders during form/calculation tests. They are not working inboxes.
5. Confirm saved records survive browser reload and the test URL is distinct from production.
6. Record environment/build, tester, Eastern date/time, and starting checkpoint in the test-results file.

Existing AWS staging deliberately cannot enable the production-only payroll email worker. Real delivery/bounce acceptance is a separate engineer-assisted gate, O07. Do not remove production guards just to make these tests send mail.

## Test data setup

All percentage inputs below are entered as 20, 16, 10, etc., not 0.20 or basis points. Dollar inputs are ordinary dollars, not cents.

### T01 — Plans and assignments

In Commissions > Agreements & carriers, create:

| Plan name | Standard new | Standard renewal | GIM new | GIM renewal | Document reference |
| --- | ---: | ---: | ---: | ---: | --- |
| QA Sales v1 | 20% | 10% | 10% | 5% | QA-PLAN-SALES-01 |
| QA Development v1 | 16% | 8% | 8% | 4% | QA-PLAN-BD-01 |

Assign QA Sales v1 to QA Avery; QA Development v1 to QA Jordan. Assignment starts 2026-01-01, ends blank. Employee references QA-AVERY-AGREEMENT-01 and QA-JORDAN-AGREEMENT-01. Leave account-first-bind cutoff and receipt eligibility date blank for this baseline.

Check Include GIM house-account rates on both plan forms and enter the GIM percentages above. Use QA-PLAN-SALES-GIM-01 and QA-PLAN-BD-GIM-01 as their GIM plan document references.

Save and reload. Both assignments must remain. Do not seed plan versions by changing the database directly.

### T02 — Carrier, accounts, and historical policy snapshots

Carrier: QA Harbor Mutual. Basis: as collected; schedule Monthly as collected; agreement QA-CARRIER-01.

Classifications begin 2026-01-01; classification evidence QA-CLASSIFICATION-01. Record actual fictional first-bind history with reference QA-HISTORY-01: October 1, 2026 for new test accounts; October 1, 2025 for the renewal account.

Create these CRM policies. Under Add an existing policy to commission tracking, search by policy number and adopt using the values below, original bind date 2026-10-01, effective date 2026-10-01, expiration 2027-10-01, and evidence QA-HISTORICAL-SETUP. This uses the explicit historical-adoption route so tests do not depend on today's new-bind timestamp.

| Policy | Account | Class | Transaction | Producer | Premium | Agency rate | Expected agency revenue |
| --- | --- | --- | --- | --- | ---: | ---: | ---: |
| QA-N001 | QA Cedar New | Standard | New | QA Avery | $10,000 | 10% | $1,000 |
| QA-R001 | QA Cedar Renewal | Standard | Renewal | QA Avery | $20,000 | 10% | $2,000 |
| QA-G001 | QA GIM House | GIM | New | QA Avery | $10,000 | 10% | $1,000 |
| QA-S001 | QA Maple Shared | Standard | New | QA Avery | $10,000 | 10% | $1,000 |
| QA-H001 | QA Oak Shared House | Standard | New | QA Avery | $10,000 | 10% | $1,000 |
| QA-L001 | QA Pine Late | Standard | New | QA Jordan | $10,000 | 10% | $1,000 |

Expected before receipts: agency forecast $7,000; actual agency cash $0; employee earned $0; paid $0. Binding/adopting a policy must not create payable commission.

### T03 — Approve shared allocations BEFORE posting receipts

In Shared & exceptions > Approve a policy commission allocation:

| Policy | From | Avery share | Jordan share | House | Reference |
| --- | --- | ---: | ---: | ---: | --- |
| QA-S001 | 2026-10-01 | 60 | 40 | 0 | QA-SPLIT-S001 |
| QA-H001 | 2026-10-01 | 50 | 40 | 10 | QA-SPLIT-H001 |

Confirm and approve each. Frozen participant rates must be Avery 20%, Jordan 16%. For a $1,000 receipt, expected employee totals are $184 and $164 respectively. The house share produces no employee earning.

## Sequential reconciliation and payroll test

Run T04–T20 in this order. Do not mix in the independent E-series cases until the baseline is complete.

### T04 — Import October 15 receipts

New reconciliation: carrier QA Harbor Mutual; statement QA-OCT15; actual receipt date 2026-10-15; settlement type Carrier deposit; verified allocation 4600.00; unique settlement reference QA-DEP-1015. Attach receipts_2026-10-15.csv.

Map Policy / Reference / Amount / Effective / Transaction. First data row 1; select all five rows (the default maximum 20 is sufficient).

| Policy | Transaction reference | Agency received | Avery earning | Jordan earning |
| --- | --- | ---: | ---: | ---: |
| QA-N001 | QA-N001-R1 | $600 | $120 | $0 |
| QA-R001 | QA-R001-R1 | $1,000 | $100 | $0 |
| QA-G001 | QA-G001-R1 | $1,000 | $100 | $0 |
| QA-S001 | QA-S001-R1 | $1,000 | $120 | $64 |
| QA-H001 | QA-H001-R1 | $1,000 | $100 | $64 |
| TOTAL | | $4,600 | $540 | $128 |

Import must produce drafts only. Leave one line Pending review and verify posting is unavailable/rejected. Review every line as eligible with note QA: agreement, policy, licensing and fictional settlement verified. Confirm settlement review, save the reviewed draft as required, and post once.

Expected ledger: agency cash $4,600; employee earned $668; no payment. Reload and verify the same totals. The shared receipts each appear only once in agency cash.

### T05 — Inclusive cutoff-day receipts

Create QA-OCT23 dated 2026-10-23; settlement reference QA-DEP-1023; total 650.00. Import receipts_2026-10-23.csv, review every line, and post.

| Policy | Reference | Agency received | Employee |
| --- | --- | ---: | ---: |
| QA-N001 | QA-N001-R2 | $400 | Avery $80 |
| QA-L001 | QA-L001-R1 | $250 | Jordan $40 |

Expected cumulative cash $5,250; Avery $620; Jordan $168; total earned $788. QA-N001 now has $1,000 agency receipts and $200 employee earnings across two installments.

### T06 — Late receipt retains its real date

Create QA-OCT24 dated 2026-10-24; settlement reference QA-DEP-1024; total 750.00. Import receipts_2026-10-24.csv and post the reviewed QA-L001-R2 receipt.

Expected cumulative cash $6,000; Avery $620; Jordan $288; total earned $908. The extra $120 is earned but outside October's October 23 cutoff. Do not move this receipt date to force it into October.

### T07 — October calendar and approval blockers

Create October 2026 (or initialize missing calendars without overwriting saved ones). Verify cutoff 10/23, review 10/24, HR due 10/26, processing 10/26, pay 10/30.

Expected payroll preview: Avery $620; Jordan $168; total $788. The ledger's $908 includes the $120 late receipt; this is an expected difference.

Before approval, add a temporary DOCUMENTATION review to QA-N001, due 2026-10-24, note QA-HOLD: verify source. Approval must be blocked. Resolve with QA-HOLD-RESOLVED: source checked. Refresh and verify the blocker clears. Unresolved reconciliation drafts through cutoff must also block; don't leave failed-test drafts behind.

### T08 — Approve and inspect revision 1

As Owner 1, check the review acknowledgement and approve the exact preview. Expected APPROVED, revision 1, total $788. Approval must not mark anything paid or send email while delivery is off.

Download HR summary and each employee earnings PDF. Verify:
- Summary Avery $620, Jordan $168, total $788.
- Avery's PDF contains only Avery's own lines; Jordan's only Jordan's.
- Shared lines show the policy share and individual rate.
- Dates, cutoff, cycle/revision, approval actor/time, and policy/receipt references match.
- Late QA-L001-R2 is absent.
- Another open cycle must not reserve these same $788 again.

Save the original revision-1 files as evidence.

### T09 — Reopen an unpaid report

Before recording any payments, use Correct an unpaid report. Reason QA-CORRECTION-01: revise fictional unpaid compensation.

Expected: cycle OPEN, revision 2; previous approval/PDFs remain in Approved report versions; included earnings are released for new review. Revision 1 is historical and must not authorize another payment. As delivery is off and no report was sent, no sent-report HR-hold scenario is involved yet.

### T10 — Correct $80 to $60, preserving the source

Shared & exceptions > Create a compensation adjustment:
- Policy QA-N001; employee QA Avery.
- Type Correct unpaid earnings.
- Original employee earning: QA-N001-R2, $80.
- Corrected total earnings 60.00 — this is the replacement total, NOT a −20 input.
- Effective date 2026-10-23.
- Reason QA-FIX-01: corrected unpaid allocation.
- Evidence QA-SIGNED-CORRECTION-01.

Save draft. October approval must be blocked while the correction is pending. Review original $80, corrected $60, change −$20; then approve explicitly.

Expected original receipt remains $400 agency cash and original calculated $80 in history, marked replaced. New payable earning is $60. Agency cash remains $6,000. Revised October preview: Avery $600, Jordan $168, total $768.

### T11 — Add $25 of approved compensation

Create Additional earnings: policy QA-N001; QA Avery; Additional earnings 25.00; effective 2026-10-23; reason QA-EXTRA-01; evidence QA-ADDENDUM-01.

Saving the draft must not add money. After explicit approval, October preview becomes Avery $625, Jordan $168, total $793. Agency cash remains $6,000. Ledger employee earned becomes $913 including Jordan's unallocated late $120.

### T12 — Approve revision 2 and verify archives

Owner 2 approves the refreshed $793 preview. Verify revision 2 replaces revision 1 and preserves the correction reason.

Download new PDFs: Avery $625; Jordan $168; total $793. The replacement $60 and extra $25 must appear as compensation adjustments, not fabricated carrier receipts. Download historical revision 1 with acknowledgement: its amounts and PDF bytes must remain unchanged ($788), including after later payment updates.

### T13 — Partial payment and overpayment protection

In Record individual employee payments:
- Avery amount 250.00.
- Actual date 2026-10-30.
- Reference QA-PAY-AVERY-PART1.
- Confirm the fictional payment.

Expected cycle still APPROVED. Avery paid $250 / remaining $375. Jordan paid $0 / remaining $168. Cycle paid $250 / remaining $543. Correction/cancellation must now be unavailable/rejected.

Attempt Avery payment 375.01: reject without creating a payment record. Attempt tomorrow's date: reject. Leave no invalid record. Double submission of the same pending operation must not create two payments; exact request-ID replay is also tested in O04. Merely reusing a human-readable reference is not a reliable duplicate-payment test.

### T14 — Complete only the remainder

Use Confirm completed payroll payment. Actual date 2026-10-30; reference QA-PAY-COMPLETE; confirm.

Expected new recorded payments total $543, not $793. Cycle PAID $793; Avery cumulative $625; Jordan $168; all cycle balances zero. The original $250 record remains. Overall ledger unpaid remains $120 for the late receipt.

### T15 — Pay the late $120 once through an off-cycle run

Add an off-cycle payment:
- Month 2026-11.
- Reason QA-LATE-01: receipt arrived after October cutoff.
- Select QA Jordan only.
- Receipt cutoff 2026-11-01; review 2026-11-02; HR due 2026-11-02; processing 2026-11-02; pay date 2026-11-05.

Review expected $120 for QA-L001-R2 only. Owner 3 approves. Download and verify the $120 report, then record fictional payment dated 2026-11-05, reference QA-PAY-LATE-01.

Expected overall paid $913; unpaid $0; agency cash $6,000. Opening another cycle must not include the same late receipt again. All three Owners have now exercised approval authority.

### T16 — Proposed recovery does not deduct wages

Create Proposed recovery after payment:
- Policy QA-N001; QA Avery.
- Original earning QA-N001-R1, $120.
- Corrected total earnings 100.00.
- Effective 2026-11-05.
- Reason QA-RECOVERY-01; evidence QA-RECOVERY-REVIEW-01.

Approve explicitly. Expected proposed amount −$20, REVIEW status, references to the original batch/payment records. Paid totals stay $913, cash $6,000, and no negative payroll item is created. A normal future payroll draft must not silently net this amount.

### T17 — Shared carrier reversal uses the original split

New reconciliation QA-REV-S001, received 2026-11-01, settlement type Net settlement / offset, allocation −200.00, unique reference QA-REV-DEP-01.

Line: QA-S001; carrier reference QA-S001-REV1; type Carrier reversal; agency −200.00; select original QA-S001-R1. Review original allocation and supply QA: original shared allocation verified. Post.

Expected cash $5,800. Separate proposed reviews Avery −$24; Jordan −$12.80. The original $120/$64 earnings and prior payments are unchanged. Inspect these shared review rows; do not rely solely on the legacy aggregate recovery tiles for shared-adjustment classification.

Before restoring, attempt another reversal of −801 against the same original $1,000 receipt: reject because $200 has already been reversed and only $800 remains available against that source.

### T18 — Restoration does not pay the same earnings again

New reconciliation QA-RESTORE-S001, date 2026-11-02, verified allocation 100.00, unique reference QA-RESTORE-DEP-01. Line reference QA-S001-RESTORE1; type Restore reversed commission; amount 100.00; original = QA-S001-REV1.

Expected agency cash $5,900; proposed restoration reviews Avery +$12 and Jordan +$6.40. These must not create new payable payroll earnings. Paid remains $913. Resolve a review with evidence QA: reviewed externally, no payroll collection; that resolution must itself change neither cash nor pay.

### T19 — Audit and export reconciliation

Review Audit history and download the final ledger. Record actors/timestamps, original and new values, case/receipt/payment IDs, report revisions, and recorded reasons. Changes must be attributable to the Owner who performed them. The cash transaction section and separate earnings section must not double count shared receipts or compensation adjustments.

Baseline end state after T18: agency cash $5,900, employee earned/paid $913, no unpaid positive earnings. Recovery/restoration proposals remain separate review records unless explicitly resolved. Reports retain their originally approved $788, $793, and $120 values.

### T20 — Reconfirm after reload and separate login

Reload, sign out/in, and verify stored amounts, report versions, and payment history. Reopen in another Owner session. The test passes only if the persisted values match, not just the immediate success toast.

## Independent edge-case tests

Run each E case in a clean isolated snapshot or with the separately scoped test employees described here. Do not change baseline expectations by silently mixing extra earnings into its monthly payroll. Resets are developer-controlled test-data resets, never production cleanup.

### E01 — Plan boundaries, zero, missing terms, and frozen rates

1. Attempt overlapping assignments, including one ending 2026-10-01 and the next starting 2026-10-01: reject. Change the first end to 2026-09-30: valid.
2. Create an assignment gap covering a test policy's commission date: binding/adoption must require Owner correction rather than invent a rate.
3. Save a plan with blank new-business percentage: reject. Save explicit 0%: valid; a $1,000 eligible receipt earns $0.
4. Use a GIM-classified policy with a plan lacking GIM rates: reject rather than fall back to Standard.
5. Change QA Sales definition from 20% to 25%. Existing assignments, snapshots, $120 shared earnings, and PDFs must remain unchanged. Assign the new version prospectively and use a NEW test policy: $1,000 should earn $250.
6. Renewal test: old bound date 2026-09-01, effective date 2026-10-01; assignment changes renewal rate from 8% through September 30 to 10% from October 1. A $1,000 receipt earns $100. New-business selection uses bind date instead.

### E02 — Account-first-bind and receipt-eligibility boundaries

Use a separate producer QA Taylor, 20% new / 10% renewal, assignment from 2026-01-01, account-first-bind cutoff 2026-10-01, receipt eligibility begins 2026-10-10.

| Case | Account first bind | Receipt date | Transaction | Expected on $1,000 agency cash |
| --- | --- | --- | --- | ---: |
| Older account | 2026-09-30 | 2026-10-10 | New or renewal | $0 |
| Inclusive account/receipt boundary | 2026-10-01 | 2026-10-10 | New | $200 |
| Before receipt boundary | 2026-10-01 | 2026-10-09 | New | $0 |
| Eligible renewal | 2026-10-01 | 2026-10-10 | Renewal | $100 |

An attempt to mark an excluded single-producer receipt eligible must reject. Post it as ineligible with evidence to retain actual agency cash. Missing first-bind history must block configuration-dependent binding/adoption. Disabling a login or changing account assignment must not rewrite historical earnings.

### E03 — Fractional shares and installment rounding

Separate test employees QA Riley (20%) and QA Morgan (16%). Policy QA-ROUND-001, premium $10.10, agency rate 10%, Standard/New, dates 2026-10-01 through 2027-10-01.

Approve allocation from 2026-10-01: Riley 33.33%, Morgan 56.67%, house 10%. Import rounding_101_receipts.csv as six settlement allocations, first data rows 1/21/41/61/81/101, row counts 20/20/20/20/20/1, same receipt date 2026-10-15, unique settlement refs QA-ROUND-DEP-1 through 6. Verified totals are $0.20 for the first five and $0.01 for the last.

After all 101 receipts: agency $1.01; Riley $0.07; Morgan $0.09; total employee $0.16. The system must calculate cumulative entitlement, not round each penny installment to zero permanently.

### E04 — Shared allocation validation and history

Reject shares 60 + 50 + house 0; reject 60 + 30 + house 0; reject a negative share; reject a duplicate participant (engineer/API check); reject an employee without applicable plan terms.

Avery 60 + Jordan 30 + house 10 is valid: $1,000 produces $120 and $48. After posting, attempt to change allocation effective on or before a posted receipt: reject. A future allocation version must not reallocate previous receipts. Undo any unused draft through normal controls; approved allocations remain historical.

### E05 — Departing employee with pre/post-departure receipts

Use separate QA Casey on 20% new / 10% renewal, and two policies:
- QA-D001: Standard/New, bound/effective 2026-10-01, expiration 2027-10-01, premium $10,000, agency 10%.
- QA-D002: Standard/Renewal, original bind 2026-10-01, effective 2026-10-25, expiration 2027-10-25, premium $4,000, agency 10%.

Create departure: employment end 2026-10-20; eligibility boundary blank; access-disabled date 2026-10-21; Owner review due 2026-10-21; HR payment due 2026-10-30; later receipts and renewals Require review; agreement QA-DEPARTURE-01; evidence QA: documented departure terms.

Save draft: relevant payroll must be blocked pending terms approval. Approve. Merely entering the access-disabled date must not disable the login; actual disabling is a separate identity-management test.

Post:
| Policy/reference | Receipt date | Agency cash | Calculated employee | Expected treatment |
| --- | --- | ---: | ---: | --- |
| QA-D001 / QA-D001-R1 | 2026-10-15 | $500 | $100 | Pay under approved rules |
| QA-D001 / QA-D001-R2 | 2026-10-25 | $500 | $100 | Review required |
| QA-D002 / QA-D002-R1 | 2026-10-26 | $400 | $40 | Review required |

Approve PAY on D001-R2 with evidence QA: pre-departure new business remains eligible. Approve EXCLUDE on D002-R1 with evidence QA: documented renewal exclusion. Cash remains $1,400; original calculated $40 remains in history; payable total is $200.

Create a Casey-only off-cycle run using the November 1/2/5 dates from T15. Approve/pay fictional $200. Download archived departure statement; it must show terms, decisions, cash estimates, and batch payment status, and explicitly be a review document rather than independent payment instructions. Case closure must be blocked before required payments/reviews are resolved and allowed afterward.

Revise terms: case returns to draft and requires approval. Disabling Casey's test login must prevent Casey signing in, while Owners retain the case/history and can process later eligible obligations.

### E06 — Pending carrier balance, closure, and later receipts

Separate Casey policy QA-D003: premium $10,000, agency 10%, $500 received so far. Worklist shows $1,000 expected / $500 received; closure remains blocked.

Record Final carrier settlement evidence: QA-CARRIER-FINAL-01: carrier confirms no more receipts. This resolves the estimate without changing cash. Post a later $100 receipt with unique reference QA-D003-LATE. Pending balance must reappear because the receipt history changed. The case must remain visible even if previously closed; review/revise it for the new obligation. Do not assume the CLOSED label automatically changes itself solely from receipt posting.

### E07 — Adjustment lifecycle and limits

- Draft additional $25: no earnings until approved. Try approval before a future effective date: reject.
- Draft unpaid correction: payroll hold appears. Cancel with reason QA: original amount confirmed; hold clears and no replacement earning exists.
- Already allocated original: unpaid correction cannot approve until the unpaid report is reopened.
- Already excluded/superseded original: correction cannot silently restore it.
- Original paid earning $120: recovery corrected total $100 creates proposal −$20. Cumulative proposals beyond $120 must reject.
- Resolve a proposed restoration/recovery with evidence: review closes without creating a payment, deduction, or new positive earning.
- Approved adjustment cannot be edited in place. A later correction must preserve the original record.

### E08 — Import, reconciliation, and empty-month controls

Use a clean test snapshot for each failure so failed drafts do not block the baseline.

| Attempt | Expected |
| --- | --- |
| Verify $4,599 against a $4,600 source allocation | Save/post rejects imbalance; no earnings |
| Import duplicate_reference.csv | Duplicate transaction reference error |
| Re-import a previously posted carrier reference | Reject duplicate; no extra cash/earnings |
| Import unmatched_policy.csv | Requires manual match; no account-name guessing or automatic posting |
| Use wrong carrier / ambiguous same policy number across terms | Unresolved match; choose the exact term |
| Blank amount, invalid date, negative RECEIPT, positive REVERSAL | Validation rejection |
| Pending eligibility or missing review evidence | Posting blocked |
| Reverse more than original or restore more than reversal | Reject; original history unchanged |
| Review a zero-commission month with an unresolved due review | Approval blocked |
| Resolve all reviews in a genuinely empty month | Explicit Owner approval can generate $0 summary, no invented employee batch |

For XLSX, use a values-only version of a valid CSV: same totals/matches. A workbook with a formula cell or external reference must reject. The importer permits up to 20 reviewed rows per settlement allocation; select subsequent ranges explicitly rather than silently dropping rows.

## Operational acceptance

### O01 — Real authentication and privacy

Using actual staging identities, not URL role switches:
1. Each active Owner can read/configure/approve and view audit/history.
2. Producer Avery sees only Avery's earnings/payments; Jordan sees only Jordan's.
3. Non-Owner ADMIN/STAFF cannot approve or read private commission management data.
4. An employee cannot request another employee's earning/batch/source/report by guessing an ID (engineer/API check).
5. Source statements, agreement evidence, internal payment references, approval details, and other employees' personal data are not returned in employee projections.
6. Revoking access and refreshing clears already loaded financial screens.
7. Disabled Owners cannot approve or receive automatic Owner bounce copies.

### O02 — Report versions and sent-report correction

Before any payment, approved report version 1 must remain downloadable and byte-identical after reopening and approving version 2. A sent original requires recorded HR-hold/no-payment acknowledgement before reopening. A definite unsent failure is different from an uncertain send.

Once any employee payment is recorded, reopening/cancelling must reject. UNKNOWN or in-flight delivery must also block report replacement even if an Owner checks HR hold. These sent/uncertain states require controlled mail fixtures or engineer-assisted tests, not hand-editing production records.

### O03 — Cutoff, timezone, and late approval

October 23 is included; October 24 is excluded from October. Approval on the cutoff day itself must reject; it opens after EOD Eastern. Changing the browser clock must not bypass server time.

November defaults remain cutoff November 20, HR/processing November 23, payday November 27. Before November 21, approval should reject under the server's real clock. Use an isolated server-clock test to verify exact midnight/Eastern daylight-saving boundaries instead of waiting or changing a production clock.

An overdue unapproved report must not reach HR. After late approval, the worker sends on its next permitted check; it cannot guarantee inclusion in payroll already processed.

### O04 — Concurrent changes and duplicate actions

Open the same cycle in two Owner sessions. Owner 1 changes the calendar/records while Owner 2 retains an old preview. Owner 2's old approval must reject and require refresh. After one valid approval, another attempt must not create a second set of earnings/batches/reports.

Engineer checks: replay the identical payment ID/request after an interrupted response; simulate a concurrent receipt/review/adjustment during approval; simulate two approvals of the same adjustment. Each must produce one valid outcome or a conflict, never double cash/pay.

### O05 — Audit completeness

For allocation, receipt, correction, approval, payment, exclusion, report download, and delivery retry, inspect actor, timestamp, identity, prior/new versions, and reason/evidence where applicable. Report history must retain revision/hash/approval context. Payment history must retain individual amounts, actual dates, references, and remaining balance.

Load additional audit pages and confirm older-format records remain reachable. Record any missing field rather than inferring success from a toast.

### O06 — Layout, navigation, and recovery

Repeat desktop/tablet/mobile/200%-zoom checks with long real-format test names and multiple rows. Use keyboard-only controls. Navigate away from edited forms and check unsaved-change behavior. Refresh during a pending save: recover from persisted records without duplicated writes. Disconnect/reconnect during read: avoid showing stale totals as a successful fresh read.

### O07 — Controlled email and bounce acceptance

This is engineer-assisted and separate from the current preview/writable staging calculations. The production worker is disabled outside its designated environment. Use an approved isolated delivery arrangement and controlled test inboxes; keep production employee recipients out of this exercise.

1. Confirm configured recipient and frozen report revision/hash before sending.
2. Deliver one approved report to a controlled HR inbox: one summary plus each employee PDF, correct revision/totals, correct subject/correction labeling.
3. Verify mail acceptance and provider delivery feedback are recorded separately.
4. Induce a verified bounce on a test report bound to its actual provider message/operation/recipient. All three active test Owners must each receive one copy with the original archived attachments.
5. Disable one test Owner: that user receives no copy; other active Owners still receive theirs.
6. Make one Owner copy fail: the other copies still proceed. A bounced Owner copy must not recursively forward.
7. Duplicate the scheduled invocation/feedback: no duplicate original or Owner copy.
8. Definite failure: an explicit permitted retry uses the same envelope and archived bytes. Unknown/in-flight acceptance: no blind resend; reconcile the durable provider result.
9. Verify a late bounce after the cycle is PAID still creates the appropriate Owner copies without reopening payment.
10. Verify reminders/overdue notices do not send unapproved payroll to HR. Scheduler checks run hourly 8 AM–5 PM Eastern; HR target is Monday 8 AM after approval.
11. Confirm no actual payroll transfer occurs from email acceptance or a CRM payment-record operation.

## Pass/fail and release decision

For every case, record test ID, environment/build, tester, actual result, expected result, PASS/FAIL/BLOCKED, record/report reference, and evidence. A blocked action in the read-only demonstration is BLOCKED for the corresponding writable transaction test, not a pass.

A full pass requires:
- Exact cents reconcile for baseline, shared allocation, correction, partial payment, off-cycle, departure, and rounding cases.
- No double-counted agency cash, reused payable allocation, or automatic recovery deduction.
- Correct behavior after refresh and actual authenticated role checks.
- Original reports and payment history remain immutable.
- Controlled delivery and bounce behavior pass separately before automatic delivery is enabled.

The existing 128 financial integration checks and 156 targeted component/service/infrastructure checks are useful developer evidence. They do not replace this authenticated user-acceptance run. Full build/configuration, broader-suite portability issues, and deployment acceptance remain separate release gates.
