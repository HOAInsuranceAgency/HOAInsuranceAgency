# Local and staging reconciliation — November 13, 2026

## Source baseline

The reconciliation starts from `codex-hoa-staging-migration` at
`764d200c0f9976218d779d33a2583a3a34812ba1`, verified against GitHub.
The earlier local working copy was based on `25894cd1b2b116cd472fbd79b72a9735f05b8162`.

The original working copy was preserved separately, including uncommitted code,
offline previews, and test evidence. Its older commission files must not be copied
over the current staging implementation: doing so would remove statement intake,
broker-fee accounting, payroll, report, and monitoring fixes.

## Reconciled changes

- Retain the current staging commission implementation and regression coverage.
- Carry forward local California branding for initial lead replies, invoice emails,
  and invoice PDFs, selected using the insured property's state.
- Preserve verified personal signature details and avoid duplicate Front signatures.
- Preserve staging credit/zero-balance invoice safeguards and financing broker fees.
- Include California regression tests and a reproducible offline preview script.
  The script uses a fictional recipient and does not send email.
- Retain staging dependency versions; add the existing local HTML-to-text dependency
  and its 15 lockfile records. Generated preview messages stay out of Git.

## Validation

- Frontend/scripts TypeScript check and backend TypeScript check passed.
- CRM production build passed.
- Backend infrastructure synthesis passed using `NODE_OPTIONS=--preserve-symlinks`
  for the locally linked dependency directories.
- Targeted commission, invoice, and branding suite: 19 files, 431 tests passed.
- Invoice integration, email infrastructure, and remaining staging gates: 14 files,
  379 tests passed.
- Financial payroll suite: 134 tests passed.
- Initial email/invoice suite: 5 files, 452 tests passed (overlaps the targeted suite).
- Clean offline dependency installation could not be verified because the local cache
  lacks a bundled dependency's registry metadata. Checks used installed dependencies.

## Publication status

On November 13, 2026, the remote staging branch was re-read and still matched
the baseline `764d200c0f9976218d779d33a2583a3a34812ba1`. There were no newer
staging changes to reconcile. Local commit
`cbb40bdb4aaf587907f8095652c8b790d0be25f2` was fast-forwarded to
`codex-hoa-staging-migration`.

CRM Amplify app `d1nuh9rw1hcuxo`, staging deployment **48**, completed with
BUILD, DEPLOY and VERIFY all **SUCCEED**. Its reported commit matches the local
reconciliation commit exactly. Automatic builds remain off; this was an explicit
staging release. The original working copy remains separate and untouched.

Before the release, the staging payroll schedule was verified **DISABLED** and
the saved payroll report setting was `enabled: false`. No production branch,
production deployment, payroll report setting or email schedule was changed.

## Approved commission workflow implementation

The subsequent workflow pass adds:

- A statement work queue that prioritizes received, unfinished settlements before
  matching/review and awaiting-payment work, with oldest arrivals first.
- A five-step statement guide and automatically opened next-work panels.
- Automatic reading of saved spreadsheets, automatic PDF/image extraction for new
  statements, and bounded extraction polling that stops on errors or when closed.
- One explicit allocation-and-post action, retaining server review, amount,
  evidence, eligibility, version and idempotency checks. Interrupted posting remains
  resumable and continues to block affected payroll cutoffs.
- One selected payroll cycle shared by readiness and review, defaulting to the
  oldest open cutoff, with compact approval and unpaid-cancellation controls.
- Explicit server-saved working copies for statement details, import mapping,
  source rows, payment details and settlement allocations. Each Owner's copies
  are private, versioned and separate from reviewed financial records. Recovery
  resets confirmations; stale copies remain available for comparison without
  directly restoring them over changed statements. Conflicts can reload the saved
  copy. Saves are bounded to 100 KB; ordinary pending-row saves remain available.
- Desktop and 390-pixel mobile preview checks. Wide source tables scroll within
  their container; the mobile statement document width was verified at 390 pixels.

Local validation includes 1,045 regression/recovery tests, 134 financial payroll
checks, backend/frontend type checks and a CRM build. One infrastructure test exceeded its five-second timeout
during the parallel regression run; its complete file passed when rerun with one
worker. Additional recovery tests verify interrupted posting and conflicting draft
reloads. Local infrastructure synthesis passed. The final workflow staging release
must also complete successfully at its exact source commit.

Live authenticated file extraction, cross-session draft recovery, and financial
posting acceptance still require controlled staging records. Fictional browser
previews and service tests do not establish that business-data acceptance.

## Remaining simplifications release
The prior workflow commit e3726325c3fb96322eea5735bfba091f5d40c2f4 was verified as staging deployment 49. Before this pass, GitHub staging still matched that commit; production main remained 0bf1db926dcd77fbdf1346eea4590904d696a445. The original working copy still had its 93 pre-existing modified/untracked entries and remains outside this work.

This pass completes the remaining requested workflow surfaces: default work queue and renamed navigation; focused statements with separate preparation/payment states and next actions; source comparison; unresolved-first and grouped review; combined format/import; full-payment proposals and server-calculated financial summaries; private draft autosave and browser navigation recovery; selected-cycle readiness, linked review/calculations and searchable history; contextual off-cycle selection; confirmed payroll cancellation; and contextual exception evidence/history.

The read-only settlement preview reuses the existing posting-plan validator. Financial posting and payroll mutations retain their existing authorization, version, duplicate, historical-rate and approval controls. No infrastructure, production setting, email schedule or report-enable setting is intentionally changed.

See COMMISSION-SIMPLIFIED-WORKFLOW-TEST-PLAN.md for the current acceptance exercise. Live financial acceptance requires controlled staging records and is distinct from automated regression and fictional browser checks. Publish this release only to codex-hoa-staging-migration; verify the successful Amplify job and served frontend identify the exact release commit.

Release validation: 24 staging gate files / 517 tests passed, plus all 134 financial payroll checks. Frontend and backend TypeScript checks, the CRM/sidebar build, and local backend synthesis passed. Desktop 1440-pixel and mobile 390-pixel fictional previews checked focused source rows, side-by-side originals, acknowledgements, approval controls and cancellation dialogs. The final remote staging check still matched e3726325c3fb96322eea5735bfba091f5d40c2f4, so no additional staging merge was needed. Automatic builds remain off; payroll scheduling was DISABLED and saved report settings remained enabled=false (version 1) before publication.

## November 16 statement import guidance

Continued from the live staging commit dcdd00c882a6371b3a8c1ae27f545941e78a1cdf (deployment 51), preserving the newer form-filler bounds fix. Work uses the separate C:/workspace/hoa-guided-workflow-20261113 checkout; the original working copy is unchanged.

The main test upload exposed an unclear import transition. The statement now explains that upload precedes row import, suggests only unambiguous recognizable columns for new carriers, preserves saved carrier mappings, makes confirmation explicit, and focuses policy review after the initial import. Worksheet/header controls are secondary. The next-action button opens only the relevant panel and focuses the column choices rather than expanding every saved-draft disclosure.

Statement totals and saved header drafts display USD currency without changing the raw editable amount or integer-cent conversion. Invalid precision is retained for correction; signed values are preserved. Before any rows are imported, the total comparison explains the pending import rather than showing an unexplained mismatch. Saved mapping comparisons show worksheet/column names and one-based header numbering. Draft restoration, confirmation resets, duplicate detection, and financial mutations retain their existing controls.

Validation: all 529 tests in the 25-file staging gate and all 134 financial payroll tests passed. After final layout refinements, the targeted 26 tests passed again. The fictional browser preview was inspected at desktop and 390-pixel mobile widths; source-table overflow remains inside its scroll container. The user's uploaded staging statement, working drafts, receipts and earnings were not modified during this UI work. Live import/posting acceptance remains for the user.

Publish only to codex-hoa-staging-migration and verify the deployed commit against this checkout. Immediately before publication, automatic builds were off, report delivery was enabled=false (version 1), and the payroll schedule was DISABLED. No production or report-email setting change is part of this release.


## November 17 guided statement workspace

Started from local/live staging commit 81a6a82730b534b54627264e5be59a7c52b7f33e (deployment 52). The remote staging branch still matched at the start; production main was 0bf1db926dcd77fbdf1346eea4590904d696a445. Work is isolated on codex/commission-guided-steps-20261117 in C:/workspace/hoa-guided-workflow-20261113. The original worktree remains at 25894cd1b2b116cd472fbd79b72a9735f05b8162 with its 93 pre-existing status entries and unchanged status digest.

Authenticated read-only inspection confirmed the main test upload and source review are complete: two rows, $1,500 control total reconciled, no carrier payment or earnings recorded. The prior screen left completed import controls and an empty unresolved-row form visible. The new statement workspace presents one active step, keeps completed steps accessible, advances after successful review/payment saves, and preserves in-memory edits while inspecting earlier steps. Review uses compact rows/cards with policy, reference, money, employee rate and decision together; detailed corrections and bulk tools are secondary. Edited decisions remain visible until saved. Completed review has an explicit completion message and the payment form opens directly.

Currency presentation now covers source-row editing, recognized spreadsheet source amounts, payment/allocation inputs and saved comparisons. Valid signed cents remain exact; invalid precision and ambiguous source columns remain unchanged. The original source file is untouched. Working-draft controls are secondary disclosures, with save errors visible outside. Payment-field edits reset the receipt acknowledgement. Server-side financial, version, eligibility, authorization and idempotency checks are unchanged. The existing early-payment exception remains available without completing source review or posting.

Desktop and 390-pixel phone fictional previews were checked; phone document width was 375 pixels inside the 390-pixel viewport. The test guide identifies the user's completed upload/review and the next fictional carrier payment. Live posting acceptance remains for the user; no test receipt, earnings or employee payment was created during this UI pass.

Before publication, staging automatic builds remained off, payroll report settings were enabled=false (version 1), and the payroll scheduler was DISABLED. Publish only to codex-hoa-staging-migration, verify the successful Amplify job and served frontend against the exact local commit, and record the final deployment receipt with the test pack.

Local validation: the 26-file staging gate passed 535 tests with one infrastructure synthesis test exceeding its five-second limit; that complete 19-test infrastructure file passed separately with a 20-second test timeout. After the final early-payment and currency refinements, all 34 focused UI/guidance/draft tests and all 134 financial payroll checks passed. Frontend and backend TypeScript checks and the CRM/sidebar build passed. The staging deployment repeats the full updated 537-test gate and deployment checks. These checks do not post the user's fictional payment.


## November 17 unified statement-to-payroll workflow

Continued from local and deployed staging commit 7ddbfed40afaf0bd5ef7711a151f6dd74b72460b (Amplify job 54). Remote staging still matched before publication work; production main remained 0bf1db926dcd77fbdf1346eea4590904d696a445. Changes are isolated on codex/commission-assisted-workflow-20261117 in C:/workspace/hoa-guided-workflow-20261113. The original working copy is preserved.

The user's main fictional statement has now been posted: $1,500 carrier receipts, $150 employee earnings for Brian Cole at the saved 10% rate, $0 source remaining. Read-only audit found competing Statements/Payroll navigation, an employee-wide older payroll run proposed at handoff, and a false unsaved-changes prompt from hidden posted-settlement allocations.

The release merges Statements and Payroll into Guided workflow with a shared seven-stage guide. Source identity follows payroll review and back-navigation. Exact linked receipt/shared-earning keys, saved rates and actual receipt dates carry forward; unrelated earnings and adjustments are not selected. Existing exact drafts/current reservations are shown for review. Creating a statement-scoped off-cycle draft requires an explicit action and human-reviewed schedule; regular monthly payroll remains an alternative with its broader total disclosed. No draft approval or employee payment is automated.

Unique recognizable worksheet/header candidates are suggested before mapping confirmation; saved carrier formats retain priority. Receipt amounts propose only the unrecorded source balance. Dates, reference and evidence remain user-entered. Completed receipts show saved evidence/history before offering another receipt. Statement steps mount when first visited and preserve edits thereafter. Generated suggestions and posted allocations do not trigger unsaved warnings; actual changed allocations remain protected.

Financial server-side approval, eligibility, cutoff, version, idempotency and posting rules are unchanged. The audit's unrelated TEST-PH-4175414-DUP-SETTLEMENT blocker is not modified. Live approval and employee-payment acceptance remain with the tester. Report settings remain enabled=false (version 1), the scheduler DISABLED, and staging automatic builds off. Publish only to codex-hoa-staging-migration with an explicit commitId, then verify the successful deployment and served asset against the local commit.

Validation: all 544 tests in the 27-file staging gate and all 134 financial payroll checks passed. Frontend/backend type checks and the CRM/sidebar build passed. Desktop and 390-pixel phone fictional previews verified the merged navigation, carried $150 selection and exact source return; phone document width is 375 pixels with table scrolling contained inside the form. Local synthesis requires Node preserve-symlinks because this isolated checkout shares dependencies through a directory junction. The deployment repeats synthesis with its own installed dependencies.
