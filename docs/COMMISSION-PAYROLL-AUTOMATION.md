# Commission payroll and HR handoff

Local implementation updated November 5, 2026. Nothing has been deployed or activated by this work. Actual employee assignments, rates, receipts, payments, and calendar records are not seeded.

## Confirmed operating setup

- HR inbox: **hr@cobaltemployment.com**.
- Approval: **all three active CRM Owners** retain authority. Review and overdue notices default to **jake@protectmyhoa.com**. No Jake-only restriction, new HR permission, or acknowledgement step.
- All employees share weekly Friday payday and **Monday morning** payroll processing. Monthly commissions target the last regular Friday payroll of the month.
- Carrier receipts must arrive by **EOD the preceding Friday**, inclusive in America/New_York. Owner approval opens after that cutoff ends. HR delivery targets **Monday at 8 AM Eastern**, conditional on approval.
- Start with **October 2026**. This controls the first calendar month; it does not silently erase older unpaid earnings or assume historical commissions were paid.
- HR receives a summary PDF and a separate itemized earnings PDF per employee for personal pay files, then enters the dollar totals manually. No payroll employee IDs, earnings codes, or payroll import file are required.

| Commission month | Carrier receipt cutoff (EOD Eastern) | HR report / Monday processing | Friday payday |
| --- | --- | --- | --- |
| October 2026 | October 23 | October 26 (report at 8 AM) | October 30 |
| November 2026 | November 20 | November 23 (report at 8 AM) | November 27 |

The November 5 clarification replaces the older Monday-afternoon processing and proposed Monday-cutoff/Friday-report examples. These dates follow the explicit Friday-EOD rule. Holiday exceptions remain editable; existing saved calendars and recipients are preserved. Delivery is off by default.

## Reusable plans and producer assignments

Under **Commissions > Agreements & carriers**, create named plans independently of producers. Each plan contains standard new-business and renewal percentages, its source reference, and optional separate GIM house-account rates/reference. Rates are percentages of agency commission received, not premium. Blank rates are not zero; explicit zero is valid.

Assign a plan version to each producer with an inclusive start date, optional inclusive end date, individual agreement reference, optional account first-bind cutoff, optional receipt eligibility start, and notes. The server rejects all overlapping assignments, including two plans sharing an endpoint date. End the previous assignment the day before its replacement starts. Gaps are permitted but a commission-bearing policy needs an assignment covering its applicable date.

New business uses the bind date; renewal uses the policy effective date. Each assignment keeps its selected plan version and rates. Editing or archiving the reusable definition does not rewrite existing assignments or policy earnings. Assign a new version with a dated transition when compensation changes. Archiving prevents new assignments but retains existing ones. Policy snapshots freeze assignment identity, dates, rates, classification, and eligibility. Existing individual agreements remain readable and can transition to reusable plans without discarding their historical rates or references.

## Approval, reports, and delivery

- Monthly calendars store explicit receipt cutoff, review, HR delivery, processing, and pay dates. **Create calendars from October 2026** initializes missing months through the following month without changing saved cycles. It does not activate delivery. Review October payments already made before approval.
- Approval uses the exact reconciled preview and settings version reviewed by the Owner. Changed amounts, draft statements through the cutoff, pending eligibility, and unresolved policy reviews prevent approval. A reconciliation version prevents concurrent statements/reviews from slipping past even a zero-commission approval.
- Approval atomically creates producer batches, reserves included earnings, and archives the approved cycle and exact revisioned PDF bytes with integrity hashes. It does not pay money. After-cutoff receipts remain available for a later month. Proposed recoveries never reduce payroll automatically.
- HR gets the approved summary and separate employee PDFs with account/policy, receipt date, agency commission, employee rate, earnings, total, cutoff, approval, and scheduled pay date. Each personal file contains only that employee. Reports can also be downloaded individually in the Owner payroll workspace.
- The production worker checks hourly from 8 AM through 5 PM Eastern. Review notices begin after the cutoff; approved reports send at the first check on or after the HR due date. If Monday approval is missing, Jake receives an overdue notice and HR receives no unapproved amounts. Late approval sends at the next check; it cannot guarantee entry into an already processed payroll. Past-processing-date reports call out the need to verify prior payments.
- Private delivery records distinguish accepted, failed, and uncertain sends. Email and download attachments use the archived original PDF bytes; retries remain byte-identical even if the report template later changes. Provider delivery/bounce feedback appears separately from acceptance. Bounced/rejected commission emails are copied individually to every active CRM Owner, with independent tracking and no recursive forwarding of failed Owner copies. Duplicate scheduled invocations do not cause another send. Email acceptance is not proof of HR receipt or payment.
- Before any delivery attempt, cancelling an unpaid cycle releases its allocations. **Correct an unpaid report** preserves the original PDFs and approval, requires a reason, and opens a fresh revision. After email acceptance, the Owner must attest that HR has held the original and nobody has been paid. Recorded partial/full payments or uncertain/in-flight sends block replacement. A new policy review holds affected outstanding cycles until resolved and freshly approved. Revised reports identify the superseded version; accepted emails are never claimed to be recalled.
- Confirm actual payment afterward, either the remaining full cycle balance or individual full/partial employee payments. Every payment retains its amount, date, reference, recorder, and idempotency ID. Balances remain open until fully paid. Payment history cannot be replaced by a corrected report. Partial-batch adjustments are separately flagged for review rather than guessed to be paid or unpaid.
- Employees retain access only to their own commission records and exports. Server projections omit other employees, reusable plan setup, agreement evidence, source files, review notes, and internal payment references. Current ownership is rechecked after index reads. Authorization loss clears loaded financial views.

## Carrier import and eligibility review

The statement editor reads CSV/XLSX sources, maps columns, and imports up to twenty lines per settlement allocation. It preserves source rows, matches exact carrier/policy/effective-date combinations, and leaves ambiguous matches for manual selection. Duplicate carrier references are checked against the source file and posted transactions. Original files remain private; importing creates reviewed draft work, not posted earnings.

Imported lines begin **Pending review** and must be explicitly reviewed before posting. Enter an independently verified settlement total. Link reversals/restorations to original entries. Unsupported transactions need separate treatment. Missing representative carrier files does not block local implementation; real-file acceptance testing remains deferred until samples are available.

CSV bounds: 1,000 data rows, 64 columns, 2,000 characters per cell, 2 MB. XLSX bounds: 5 MB compressed, bounded expanded content, twenty worksheets. Formula cells, external worksheet references, invalid dates, and duplicate worksheet rows/cells are rejected. Use values-only exports. PDFs/images remain attachments for manual reconciliation; no OCR or unattended carrier feed is included.

Owner review items cover licensing, documentation, splits, separation, cancellations, disputes, late receipts, and other issues. Open reviews block relevant approval; due reviews also block zero reports. Resolution requires evidence. Categories do not themselves decide entitlement or implement split/final-pay arithmetic.

## Setup after staging validation

1. Create reusable plans from the applicable agreements; assign each producer their correct plan version, dates, and eligibility settings. Configure account classifications and carrier terms. No business rates are automatically selected.
2. Save **Report delivery settings** with the HR and review inboxes. Automatic delivery stays off during setup.
3. Initialize calendars from October 2026 or add individual months. Review cutoff/holiday dates. Existing calendars are not rewritten by initialization; edit any open calendar still using earlier assumptions.
4. Reconcile actual carrier receipts and eligibility. Reconcile historical commissions already paid before approving October; the system cannot infer missing payroll history or detect carrier statements never entered.
5. Review and approve the monthly totals after the cutoff. An Owner must approve before Monday's 8 AM check for the scheduled report to arrive then.
6. Verify production sender/recipients and delivery, then enable automation. Staging cannot activate it.
7. HR saves each employee PDF in their personal pay file and manually enters the approved total in payroll. No CRM acknowledgement or import template is needed.
8. Record payment only after it occurs, with actual date and payroll reference.

## Delivery recovery

- `SENT`: accepted by the mail service; inspect durable mail records for delivery evidence.
- `FAILED`: no acceptance established, or validation failed before send. The Owner may request retry of the saved operation/envelope. Original recipient, subject, text, and approved attachments are reused.
- `UNKNOWN` or stale `SENDING`: inspect the mail ledger and inbox before any replacement; blind retries are blocked.
- Pause delivery without discarding approvals, balances, or delivery history. Existing communication-operations alert subscriptions receive worker/scheduler errors after deployment.

## Verification and release gates

`npm run test:commission-payroll` runs the actual calculation, import mapping, handler, plan/assignment service, payroll service, worker, and **real pdf-lib generation**. Storage, roster/authentication infrastructure, signing, and transport use in-memory boundaries. No AWS credentials, email, or payroll writes are used. Requires Node 22.15+ and installed `pdf-lib`; an existing dependency directory can be supplied with `COMMISSION_TEST_NODE_MODULES` for an offline run.

All **128 focused integration checks passed November 5, 2026**: calculations, assignment overlap/version/concurrency rules, legacy transitions, October initialization, Friday cutoff/Monday delivery, authorization and employee privacy, approval holds, retry behavior, zero reports, and payment outcomes. Fictional summary/employee PDFs were rendered and inspected, including a multi-page report. Set `COMMISSION_REPORT_PREVIEW_DIR` to a temporary directory to generate fictional PDF fixtures for layout review; they are not payroll records.

Earlier validation: both the CRM and website dependency installations completed successfully from Ethan's terminal on November 5 (npm exit 0 confirmed in each log). That revalidation passed the backend TypeScript check, all **150 targeted commission/UI/workbook/mail-infrastructure tests across 12 files**, and all **103 native payroll checks** using the installed PDF library. The targeted command was `node node_modules/vitest/vitest.mjs run --configLoader runner --maxWorkers 2 --testTimeout 15000 src/test/commission src/pages/Commissions.test.tsx src/components/CommissionPayroll.test.tsx src/lib/commissionWorkbook.test.ts src/test/sesMailInfrastructure.test.ts`. The timeout permits slower initial CDK construction on this machine; assertions were not weakened. No further package installation is required for these checks.

The earlier broad run, before the latest shared-allocation/departure implementation, completed **244 files / 4,428 tests: 4,414 passed and 14 failed**. That run found 14 configuration/Windows-portability failures; no commission failure appeared in that run. The full suite was not rerun for this final local pass. That earlier targeted rerun included the additional legacy-audit pagination check. Recorded broad-suite failures:

| Count | Location | Verified cause |
| --- | --- | --- |
| 4 | `configureAmplify.test.ts` | Generated `crm/amplify_outputs.json` is absent; Vite cannot resolve the import even with the test mock. |
| 4 | `migrationDeploymentGuard.test.ts` | The test installs a Unix shebang `aws` fixture and colon-delimited PATH; Windows cannot execute it (`spawnSync aws ENOENT`). Installing a live AWS CLI is not the correct fix for this test double. |
| 3 | `webLeadFields.test.ts` | Source-matching regex assumes LF; the identical expression matches after in-memory CRLF normalization. |
| 1 | `uploadQuota.test.ts` | LF-only model-block delimiter scans past the intended model on CRLF. In-memory normalization confirms both actual model rules remain scoped to ADMIN/OWNER. |
| 1 | `premiumFinanceFlag.test.ts` | Splitting a Windows filename on `/functions/` returns undefined. |
| 1 | `premiumFinance/jurisdictions.test.ts` | Checkout CRLF changes the signed YAML byte hash. Its LF-normalized hash matches the existing generated hash; compensation and finance configuration were not regenerated. |

The run used the runner config loader with four workers. Its JSON and text diagnostics are temporary local validation logs. These findings do not constitute a green full suite. Generated cloud configuration was not fabricated; the connected AWS read required approval unavailable in this session, so it could not supply the missing outputs.

The isolated commission preview now **builds successfully** with Vite's runner config loader and has been checked in a real browser using fictional records. An overly broad mock alias was replaced with exact service-module resolution so shared commission calculations load normally. The fixtures now include a reusable plan, dated assignment, and October/November payroll calendars. Browser checks covered the Owner ledger, payroll dates/settings, disabled nonproduction delivery, plan rates and assignment fields, reconciliation and pending eligibility, and the employee view without management controls. See `crm/scripts/commissions-preview/README.md` for the reproducible build/serve commands. This is a component preview, not an authenticated staging end-to-end test.

The full frontend TypeScript/build checks stop at missing `amplify_outputs.json`; no other frontend type errors were reported. Backend synthesis and the development dependency scanner still encounter an execution-environment directory-access denial when esbuild scans parent folders. Full production build, full-suite acceptance, backend synthesis, authenticated staging checks, and HR inbox delivery validation remain release gates. Node 24 installed the packages successfully, with an AWS package warning that it expects Node 22; deployment already selects Node 22 in `amplify.yml`. Once configuration is available and Windows test portability is addressed, run `npm run test:run`, `npm run typecheck`, `npm run build`, and `npm run synth:check` from `crm` in the appropriate build environment.

Remaining business configuration is actual plan assignments/agreement references, historical paid/unpaid balances, and representative carrier files. Ethan confirmed the previously pending agreement terms. Shared allocations, explicit departure reviews, and compensation adjustments are implemented locally; see `COMMISSION-EXCEPTIONS-AND-SHARED-CREDIT.md`. Account/house ownership transitions remain future scope. No special holiday automation or payroll import configuration is required.

Operational limits: 500 receipt entries and 90 policy/employee-earning changes plus twice the employee-batch count per approval (reserving transaction space for archived PDFs); 5 MB combined PDF attachments; existing storage transaction size limits; 5,000 records per category with incomplete reads rejected. Larger histories need partitioning or archival. The standard PDF font supports Western names/text; unsupported characters fail generation before sending rather than being silently removed.

## Local exception update — November 5, 2026

The payroll workspace includes off-cycle drafts with an employee scope and reason, partial-payment amounts and balances, unpaid-report correction/reapproval, archived report downloads, and an Owner-only paged audit history. New direct manual batch approval/payment is disabled so it cannot bypass approval and HR reporting. Legacy unpaid batches can be cancelled to release their receipts. Any recorded payment prevents report replacement.

`report-history.ts` stores immutable snapshots and compressed exact PDF bytes in the private ledger, with per-file integrity checks. `payroll-feedback.ts` validates SES receipt bindings and sends separate, tracked copies to the current active Owner group. Recipient access is checked again before sending, and disabled-user checks participate in the delivery reservation. Old/closed cycles remain eligible for bounce follow-up.

See [Commission exceptions, shared credit, and departures](COMMISSION-EXCEPTIONS-AND-SHARED-CREDIT.md) for the confirmed formula, implemented policy-level shared allocations, departure cases, explicit adjustments, and acceptance scenarios. This work is local and has not activated production.

Earlier exception-workflow validation: **103/103 native integration checks and 150/150 targeted Vitest checks passed**. The isolated Vite preview builds. Browser checks verified partial-payment balances, disabled replacement after payment, off-cycle draft fields, historical-download acknowledgement, bounce status, and the employee view without management controls. Backend TypeScript passes. Full frontend type checking still reports only the two missing `amplify_outputs.json` imports. Full synthesis still stops at esbuild's denied parent-directory read; the new focused CDK permissions test passes. No deployment or real email delivery was performed.

## Confirmed terms and visual update — November 5, 2026

The shared commission formula is confirmed: eligible agency cash × employee policy share × the employee’s own frozen plan rate. Shared receipts create separate employee earnings while preserving one agency cash entry. Approved additional earnings, unpaid corrections, and proposed paid recoveries have explicit case records. Departure cases preserve access/eligibility separation, later-receipt rules, review/payment dates, decisions, pending-carrier resolutions, and archived review statements. Recovery collection is still manual outside this system; no automatic payroll deduction is introduced.

The payroll page now matches the CRM typography, navy/blue colors, cards, status badges, and spacing. Settings, calendar creation, and off-cycle tools use styled expandable panels. Monthly cards group dates, totals, review notices, and approval controls; forms and exception screens share responsive layouts.

Final verification after this update: **128/128 native financial integration checks and 156/156 targeted Vitest checks across 13 files passed**. Backend TypeScript passed. The targeted run used one worker and a 60-second test timeout to avoid concurrent CDK startup contention; it completed in 44.5 seconds without weakened assertions. Frontend TypeScript reports only the two missing `amplify_outputs.json` imports. The isolated preview build passes. `git diff --check` passes.

The redesigned payroll page was visually inspected on desktop before the connection interruption. After reconnection, browser automation still failed to initialize (sandbox helper error), so a fresh visual check of the latest exception forms and narrow layouts remains pending. Component coverage includes the rendered forms, approval confirmation, authorization loss, and separate earnings exports. Production build/synthesis, the broad-suite configuration/portability issues above, authenticated staging acceptance, and controlled inbox delivery checks remain release gates. Nothing was deployed or emailed.
