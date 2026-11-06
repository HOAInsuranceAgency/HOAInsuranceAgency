# Observed commission preview testing — November 6, 2026

Environment: fictional, read-only preview at http://127.0.0.1:8792/?scenario=shared, controlled in Ethan's connected Chrome browser. This records observed UI checks, not real authentication, persistence, payroll processing, report archival or email delivery.

## P01 — Shared ledger
- PASS: agency received $2,500; earned $504; paid $0; unpaid $504.
- PASS: Maple Court receipt $1,000 counted once; Avery 60% × 20% = $120; Jordan 40% × 16% = $64.
- PASS: Cedar receipt $2,000 less $500 reversal gives agency cash $1,500. Original earnings $320 remain; proposed $80 adjustment is separate.
- PASS: browser CSV export downloaded as producer-commission-ledger-2026-11-06.csv (2,125 bytes; generated 2026-11-06T15:50:53.655Z). Read the downloaded artifact: transaction cash 2000 - 500 + 1000 = 2500, with separate employee allocation rows 120/64 and no duplicated agency-cash columns.
- RESOLVED during final closeout: Maple now shows Employee earnings $184.00; shared receipt amounts point to individual allocations.
- Branded printable HTML verified during final closeout; native PDF saving/pagination remains unverified.

## P02 — Payroll preview
- PASS: October and November fixture cycles each display Avery $440, Jordan $64, total $504. These are independent preview cycles; do not add them together.
- PASS: October cutoff Oct 23 inclusive; Owner review Oct 24; HR due/processing Oct 26; pay Oct 30.
- PASS: November cutoff Nov 20 inclusive; Owner review Nov 21; HR due/processing Nov 23; pay Nov 27.
- PASS: acknowledgment can be checked, but approval remains disabled because this is a fictional preview. Acknowledgment was restored unchecked.
- PASS: automatic email delivery is disabled; delivery history shows zero deliveries. This does not test real delivery.
- PASS: delivery settings, new month, off-cycle and existing-cycle date panels expand and collapse; Enter and Space operate summaries, and Tab produces visible keyboard focus.
- PASS: off-cycle draft disabled with no employee; selecting Jordan and entering "PREVIEW-P02 · Late receipt test only" enables the draft control. Fields restored; no draft submitted.
- PASS: keyboard entry of December 2026 followed by standard dates produces cutoff Dec 18, review Dec 19, HR/processing Dec 21, pay Dec 25. Holiday adjustments are outside current scope.
- TEST AUTOMATION LIMITATION: automated fill on native month input displayed December without updating the application's month state; standard dates reverted to October. Normal ArrowUp keyboard entry correctly updated state and calculated December. No application date-reset defect confirmed. Future native month/date checks should use normal keyboard input and verify resulting state.
- PASS: attempted December payroll-month save was refused with "This preview uses fictional data and cannot save or download private files." No record created. Month/date inputs restored to October.
- PASS: existing-cycle payroll month is read-only; remaining dates editable in the form.
- PASS: 1440-, 768- and 390-pixel viewport tests had no whole-page horizontal overflow (client/scroll widths 1425/1425, 753/753, 375/375). Cards, tables, date grids, approval controls and expanded mobile date inputs visually inspected.
- PENDING: true 200% browser zoom. The Control-plus attempt did not change viewport width or pixel ratio, so this was not counted as verified.
- Restored normal viewport and left the October payroll card open.
- Console contained browser messaging/connection errors. Their source was not isolated; no associated app failure observed during the checks above.

## P03 — Payment and report history
- PASS (display): ledger earned $320, paid $120, unpaid $200; proposed $80 partially paid adjustment remains separate.
- PASS (display): November approved revision 2 explicitly replaces revision 1 for the fictional corrected receipt allocation. Cycle approved total $320, recorded paid $120, outstanding $200.
- PASS (display): Avery individual payment history shows approved $320, paid $120, remaining $200; fictional payment reference FICTIONAL-PAYROLL, payment date Nov 23, recorded timestamp Nov 23 at 10 AM.
- PASS (UI safeguard): individual payment control is disabled before acknowledgment; entering PREVIEW-P03-ONLY and checking acknowledgment enables it. Restored blank reference and unchecked acknowledgment; did not submit a payment.
- PASS (UI safeguard): full-cycle payment control is disabled before acknowledgment; entering PREVIEW-P03-FULL-ONLY and checking acknowledgment enables it. Restored blank reference and unchecked acknowledgment; did not submit.
- PASS (UI safeguard): partially paid November cycle exposes no replace, reopen or cancel button and explains that recorded payments prevent replacement or cancellation. Backend enforcement remains untested here.
- PASS (display): delivery history retains one fictional HR delivery, revision 2, recipient hr@example.test, Nov 23 at 9 AM, service ID fictional-message-id, service acceptance plus Bounce feedback. No live bounce or Owner-copy workflow was triggered.
- PASS (UI safeguard): historical revisions 1 and 2 each show $320, approval timestamp and Example Owner. Both download controls are disabled until the separate historical-record acknowledgment is checked and enabled afterward. Acknowledgment restored unchecked.
- EXPECTED PREVIEW BLOCK: attempted revision 1 download showed "This preview uses fictional data and cannot save or download private files." Archived PDF bytes, hashes, and immutability are not verified.
- EXPECTED PREVIEW BLOCK: View audit history opened its panel but returned the same preview restriction. Audit entries and paging are not verified.
- DISPLAY ONLY: both report integrity references are literal fictional-report-integrity-reference placeholders, not real hashes.
- Automation note: selectOption for the scenario switch stalled without navigation; no JavaScript dialog was present. Normal ArrowDown keyboard selection successfully loaded the Payment & report history scenario.
- Left November payment summary visible; all payment acknowledgments unchecked and test references cleared. Preserved the tab for the next section.

## Actual-template PDF review samples
- Generated 12 fictional, watermarked PDFs through the existing production payroll and departure report renderers: current revision 2, historical revision 1, shared commissions, off-cycle payment, additional compensation adjustment, and departure review. Each payroll example includes its HR summary and relevant individual employee documents.
- PASS: all 12 PDFs contain TEST DATA - DO NOT PAY, all expected payroll amounts match, and individual employee files exclude the other fictional employee. Revision 2 replacement wording, off-cycle labels, and the $25 adjustment were verified in PDF content.
- PASS: current HR summary opened and rendered in connected Chrome. The actual Payroll > Download HR summary PDF button downloaded bytes identical to the generated revision 2 sample.
- PASS: preview build, targeted TypeScript check, and offline HTML packaging. The Sample PDFs panel exposes View and Download links; the offline preview embeds the same files.
- The earlier P03 PDF restriction is superseded for owner preview downloads of these November samples. Historical acknowledgment remains required through payroll controls. These synthetic samples do not verify real archive retrieval, hashes, immutability, live authorization, delivery, or payment processing. Audit-history preview restrictions remain.
- Regenerate samples from the repository root: node crm/scripts/commissions-preview/generate-report-samples.mjs. The preview launcher also regenerates before building; its PDF output folder is ignored by git.
- Delivered individual PDFs and a complete review ZIP. P04 remains next after the user reviews the documents.

## Revised templates and P04 — November 6 follow-up
- Adapted all six supplied PDF references and README formatting requirements into the existing self-contained PDF renderer: approved HOA logo/address, navy totals, gold section markers, date panels, revision/replacement/off-cycle/adjustment badges, employee tables, and departure status/balance tables. Employee earnings statements use the same design. The renderer retains its bundled Helvetica fonts; no Chromium runtime or Google Fonts request was added.
- All 12 regenerated samples retain fictional data with an explicit test-mode banner and watermark. Production rendering defaults to no test marking. The standard departure sample fits one Letter page; longer evidence and decisions flow onto continuation pages. Existing archived report retrieval continues to return its original bytes.
- PASS: 131 offline financial integration checks, including three new checks for Eastern date/DST formatting, explicit test marking with unchanged live rendering, and complete long departure evidence/decisions. PASS: 34 targeted UI tests; full backend types; preview build; offline packaging.
- P04 PASS (automated local DOM, actual packaged React preview): Avery total $440 and shared earnings $120; Jordan and $64 absent; Payroll, Reconciliation, Shared & exceptions, and Agreements & carriers tabs absent; sample gallery exposes only Avery's four employee files. No DOM runtime errors.
- P04 PASS (observed Chrome): browser connection recovered. Switched Shared commissions to Employee · Avery Brooks using the preview controls. Observed $440 earned/unpaid, the $120 shared earning (60% share × 20% rate), no Jordan/$64 row, no Owner management tabs, and exactly four Avery-only PDFs in the expanded gallery. This validates preview presentation, not real authentication or API authorization. Left employee view open for review.
- Updated the 12 individual sample PDFs, review ZIP, and offline preview in place.
- Next interactive section: P05 exception forms.

## P05 — Shared allocation, departure, and adjustment forms
- PASS (observed Chrome, shared Owner preview): selected SHARED-102, future receipt date November 1, 2026, Avery share 60%, Jordan share 40%, house share 0%, reference PREVIEW-SPLIT-01. Approval stayed disabled before acknowledgment and enabled afterward. Attempted approval returned the expected fictional-preview save restriction. Acknowledgment was restored unchecked.
- TEST PLAN CORRECTION: Avery already has an approved departure fixture and was correctly absent from the new-departure selector. Used Jordan Hayes instead and updated the canonical P05 instructions.
- PASS: entered Jordan employment end October 20, blank eligibility boundary, access disabled October 21, Owner review due October 21, HR payment due October 30, both receipt treatments Review each earning, reference PREVIEW-DEPARTURE-01, evidence Fictional review only. Save departure for review returned the expected preview restriction. The existing Avery case was not edited.
- PASS: entered SHARED-102 / Avery / Additional earnings / $25.00 / October 23 effective date / Fictional additional earning / PREVIEW-ADJUSTMENT-01. Save adjustment for review returned the expected preview restriction. No earning was created.
- PASS: after reload, agency received remained $2,500 and employee earnings remained $504. Exceptions still showed only the original Maple allocation effective January 1 (Avery 60% at 20%, Jordan 40% at 16%), only Avery's existing approved departure review, and no compensation adjustments. No test record persisted.
- These are preview UI and refusal checks, not successful server saves, approval execution, or persistence verification in staging. No production records, payments, access, or emails changed.
- Left the original approved allocation visible. Next interactive section: P06 CSV import mapping.

## P06 — CSV mapping (completed November 6, 2026)
- Initial blocker resolved: Ethan enabled the Chrome extension file permission. The supported browser file chooser then selected the sample successfully.
- FOUND AND FIXED LOCALLY: the demo rejected attachment authorization before the local parser could run. Extracted the existing production private-upload operation into its own service boundary. The isolated preview substitutes a CSV/XLSX-only local attachment with no network upload and an empty evidence key. Saving and posting remain blocked. The UI explicitly labels the file as local preview only, not uploaded or saved.
- PASS (observed Chrome): selected Harbor Mutual and preview_mapping.csv; Read attached statement became enabled and parsed the actual file. Mapped Policy / Reference / Amount / Effective / Transaction to their corresponding fields.
- PASS: source rows 2 and 3 match POL-1 / PREVIEW-MAP-1 / $600.00 and SHARED-102 / PREVIEW-MAP-2 / $400.00. Both have January 1, 2026 effective dates and receipt transaction type. Preview shows 2 draft lines, $1,000.00 agency commission, and 0 remaining rows.
- PASS: Use these draft lines was disabled before the mapping acknowledgment, enabled after checking it, and reset to disabled/unchecked after applying. Both editable lines contain the correct policy, reference, and amount, and both start Pending review - cannot post. Optional premium/rate fields remain blank rather than invented.
- LIMITATION: a supplementary attempted save did not reach submission because automated native-date entry left the required receipt date blank. No save-refusal result is claimed for that attempt. Additional test references/control total were cleared; imported draft lines remain open for review. Server persistence, private storage, posting, and eligibility enforcement require staging.
- PASS: 21 targeted tests (15 existing commission UI, 3 workbook, 3 upload-boundary checks) and preview build. Upload checks verify conditional PUT completion before returning evidence, failure propagation, and no file transmission after authorization denial.
- Screenshot: commission-test-evidence/P06_CSV_Mapping.png.
- No record saved, earnings created, payment recorded, or email sent.

## P07 — Departure display and PDF (completed November 6, 2026)
- PASS (observed Chrome, shared Owner preview): expanded Avery Brooks approved departure case. Employment ended September 30, 2026; Owner review due November 5; HR payment due November 6. Later receipts and renewals both require review; the interface explains that receipts remain visible after access ends.
- PASS: POL-1 original earnings $320.00 and SHARED-102 shared earnings $120.00, both dated October 1, both REVIEW and UNALLOCATED. Combined amount under review is $440.00. No eligibility decisions or payment instructions were submitted.
- PASS: pending carrier section shows Cedar/POL-1 expected agency $12,000.00 versus received $1,500.00, and Maple/SHARED-102 expected $12,000.00 versus received $1,000.00. It explicitly identifies these as agency estimates, not payable employee earnings. Derived remaining estimates are $10,500.00 and $11,000.00.
- PASS (actual rendered sample PDF in Chrome): opened the gallery's Avery departure review, case version 1, and visually verified the one-page branded report. It retains TEST DATA - DO NOT PAY; $320/$120 and $440 total under review; REVIEW/UNALLOCATED statuses; employment end Sep 30; HR due Nov 6; terms approved Nov 5 by Example Owner; Nov 6 snapshot. Carrier table shows $10,500/$11,000 outstanding and 12.5%/8.3% received to date. The report states that payment requires a separately approved payroll report.
- The local server had exited between turns; restarted it hidden and reloaded the PDF successfully. Left the actual sample PDF open at fit-page size and retained the departure view.
- LIMITATION: the gallery PDF is a watermarked sample generated by the production renderer, not evidence of successful live archive retrieval, immutability, or authorization. The payroll and departure fixtures remain independent display examples; real cross-workflow approval holds require writable staging. Disabling login access was not executed or verified.
- Evidence: commission-test-evidence/P07_Departure_PDF.png.
- No records, eligibility decisions, payments, access permissions, or emails changed.


## Final local closeout — November 6, 2026

### P01 summary correction and branded print layout
- FIXED AND OBSERVED: Maple Court policy summary now includes payable shared employee earnings: $120 + $64 = $184. Cedar remains $320; overall earnings remain $504. REVIEW and REPLACED earnings are excluded from the policy total.
- Shared receipt rows direct readers to employee allocations instead of displaying a misleading $0 producer amount. The shared transaction's export rate and amount are blank; frozen individual rates stay in the allocation rows.
- UPDATED at Ethan's request: the producer ledger printout now shares the approved payroll/departure logo and navy/gold palette. It includes the approved address, date/scope panels, navy financial summary, separate proposed-adjustment callout, readable grouped columns, source references, Letter print styling, and continuation-page branding.
- PASS (observed Chrome HTML): $2,500 agency receipts; $504 recorded earnings; $0 paid; $504 unpaid; $80 proposed unpaid adjustment remains separate. Three transaction rows and two allocation groups retained. Avery $120 at 60% × 20%; Jordan $64 at 40% × 16%. Shared agency cash appears only in transactions.
- PASS: the preview copy is visibly marked TEST DATA — DO NOT PAY; live rendering is unmarked by default. Both embedded logos loaded; page client and scroll width were both 1,440 pixels. Timestamp displayed Nov 6, 2026, 1:54 PM EST with America/New_York.
- PASS: exact rendered HTML and full-page screenshot saved as commission-test-evidence/P01_Branded_Ledger.html and P01_Branded_Ledger.png.
- NOT VERIFIED: native Save as PDF output, actual printed pagination, and true 200% Chrome zoom. The earlier native print attempt blocked page interaction and was dismissed; no completed PDF save is claimed. Browser shortcut attempts did not change the observed zoom. Responsive viewport checks above remain valid.
- Automation note: programmatic export selection was popup-blocked; native End-key selection successfully opened the printout. No popup/security setting was changed.

### Final local validation
- PASS: 131 financial integration checks, including payroll, correction/reversal behavior, sharing, departures, archive logic, and production-renderer PDF checks.
- PASS: 166 targeted tests across 15 files: commission UI, payroll and exception controls, import and upload boundaries, access, account history, binding, house-account treatment, service/store behavior, report export, payroll infrastructure, and SES infrastructure.
- The infrastructure synthesis check initially exceeded its default five-second timeout. It passed with a 30-second allowance; that test now declares the longer timeout. No assertion was removed.
- PASS: backend TypeScript check before the final print-only changes; targeted report/layout/shared-brand TypeScript check after those changes.
- PASS: final isolated preview build and offline packaging. Packaged employee smoke check confirms $440 total, $120 shared, no Jordan/$64, no Owner controls, and four Avery-only sample PDFs.
- BLOCKED: full frontend type/build acceptance. TypeScript reports only two missing-module errors for crm/amplify_outputs.json (configureAmplify.ts and backfill-lead-expansion.ts). No fake cloud configuration was added.
- PASS: git diff --check. Build warnings concern the intentionally embedded sample PDF bundle size and an empty-stack infrastructure test fixture; they are not test failures.
- Reproducible test output retained in commission-test-evidence/LOCAL_CHECKS_2026-11-06.txt.

### Writable staging status
- Read-only AWS inspection confirmed the HOA account 917680434255 in us-east-1, CRM Amplify app d1nuh9rw1hcuxo.
- The migration-staging alias points to branch codex-hoa-staging-migration. Latest inspected deployment: job 29, SUCCEED, revision 7194baf0b4aad51f8c319aef4e8486836fd61b53.
- Correction to earlier assumptions: this branch is no longer held in migration-preview mode. Its preview flag is false and migration worker/schedule flags are enabled. This is not evidence that the new commission implementation is deployed or that its dataset is isolated for acceptance testing.
- The deployed revision does not contain crm/amplify/functions/commissions/payroll.ts. The new commission workflow remains in the local working tree.
- Before T01–T20 / E01–E08 / O01–O07: integrate and deploy the reviewed local implementation to an isolated staging target, generate its cloud configuration, provision authorized fictional test identities/data and checkpoints, and keep automatic report email disabled. Existing production-only payroll-mail guards remain in place.
- The staging URL is https://migration-staging.d1nuh9rw1hcuxo.amplifyapp.com. Visiting that URL alone does not exercise these local changes.

## Remaining
The P01–P07 preview walkthrough and available local regression checks are complete, with the native PDF-save/pagination and 200% zoom limitations listed above. Successful server saves, real authentication, private archives/audit history, concurrency, and controlled delivery/bounce acceptance still require the newly implemented workflow in writable staging. No deployment, commit, push, live record, payment, access change, or email was performed.

## Commission styling consistency pass — November 6, 2026

At Ethan's request, reviewed all five commission tabs and their conditional/expanded components.

- Replaced the remaining raw disclosure menus in the ledger policy-number editor, review-item editor, statement importer, and legacy batch history. Payroll and exception disclosures now use the same CommissionPanel component, including nested sections, keyboard focus, open-state treatment, body padding and danger styling.
- Grouped commission plans, producer assignments, carrier terms and account classifications into matching CRM cards. Standardized field labels, dropdown indicators, form spacing, action footers, empty states, retry buttons, file pickers, confirmations, errors, notices, table containers and navigation.
- Added consistent date/status/amount panels for statement and departure records and legacy payment history. Audit changes show record identity and version transitions, with the complete stored value retained inside a styled detail panel.
- PASS: 35 existing commission UI tests (ledger/settings/reconciliation, payroll, and exceptions).
- PASS: isolated preview build, offline packaging, shared-panel TypeScript check, and git diff --check.
- PASS: packaged React preview structural/spacing checks across 11 view states and 45 panel appearances, including selected plans/assignments/carrier terms, GIM rate fields, open/approved payroll, partial payments, history, nested departure forms, CSV import shell, and employee presentation. Confirmations were checked for consistent label containers. Original sample earnings remain $504 Owner / $440 Avery; other-employee information remains absent from Avery's view.
- Evidence: commission-test-evidence/STYLE_REVIEW_2026-11-06.json. These are local DOM and computed-spacing checks, not screenshots or actual browser layout measurements.
- LIMITATION: Chrome control was unavailable in this connection, and desktop control could not initialize. Fresh browser visual, responsive geometry and native disclosure-marker acceptance are still pending. The local DOM engine's native details styles were not used to claim browser marker verification.
- Rebuilt the current preview and its self-contained offline HTML. Local HTTP preview returned 200 after restart. Changes remain local; no cloud deployment, live records, or email actions.
