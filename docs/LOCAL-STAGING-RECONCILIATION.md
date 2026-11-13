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
