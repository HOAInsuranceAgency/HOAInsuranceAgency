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

This document records a local reconciliation, not a successful deployment.
GitHub branch creation and AWS deployment-status inspection were rejected by this
session's approval policy. The deployed staging revision therefore remains unverified.

Before publishing, re-read the staging branch head, incorporate concurrent changes,
run the affected checks, publish the reconciled source, and verify the successful
Amplify job's commit matches the local revision. Do not change production or enable
commission report emails as part of this synchronization.

## Approved commission work still to implement

The further visual/workflow pass is not part of this reconciliation: compact
approval/cancellation actions, the prioritized work queue, guided statement progress,
automatic source loading and extraction polling, consolidated settlement posting,
focused payroll review, and recoverable server-saved working drafts remain the
next implementation work. Existing staging functionality is retained in full.
