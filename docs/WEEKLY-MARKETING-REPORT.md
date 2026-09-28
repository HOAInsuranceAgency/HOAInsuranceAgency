# Weekly marketing report

Settings → Marketing reports lets an administrator choose the recipient, enable Friday delivery, and send a current report manually. The schedule is Friday at 8:00 a.m. in `America/New_York`, including daylight saving changes. Pausing weekly delivery does not prevent an intentional manual send.

The attachment is an Excel workbook with the 52 columns from `HOA_LEAD_UPDATE.xlsx`, in the original order, on `PMH Leads - Final`. `Report Notes` records the snapshot time and interpretation rules. No customer records from the supplied example are committed to the application.

## What the report contains

- One row for every CRM account at LEAD or CLIENT stage, including lost/disqualified leads. Converted clients remain visible. This is a cumulative snapshot, not only the previous week's new leads.
- Stable CRM account IDs. The example workbook's manually assigned PMH numbers are not substituted for CRM identities.
- Recorded acquisition source, workflow outcome, verified prospect communication, received documents, presented quotes, and separately identified premium information.
- Blank numeric/date cells and `Not recorded` labels when evidence is missing. Missing information is never reported as zero or a negative answer.

The example contains historical research and editorial judgments that cannot be recovered from structured CRM fields alone. These include exclusions, detailed association classifications, unverified policy terms, competitor-loss reasons, and eligibility for an incumbent-premium average. The scheduled report does not silently copy those old judgments into current data. Its notes describe these limitations.

Quote presentation is distinct from a carrier returning a quote. Human client communication is distinct from an automated welcome, draft, failed message, carrier conversation, or internal note. Premiums from different policies or coverage types are not added into a market average. The workbook includes its exact mapping conventions.

## Delivery

Both the query and mutation require an administrator, with a second identity check inside the handler. The manual action queues a separate worker, so a large report does not depend on a browser remaining open. Data collection must finish completely before any email is attempted.

Each scheduled edition is reserved once for its Eastern Friday date. Manual requests carry a stable request identifier across retries. A conditional transition claims the send, and the email client does not retry an ambiguous send. Recent reports display preparing, sending, sent, failed, or delivery-needs-review states. `Sent` means SES accepted the message, not proof of inbox placement.

If delivery needs review, inspect the original SES send and recipient inbox before sending another copy. A failed collection or workbook generation sends no partial report. Lambda errors feed the existing communications operations alert topic. The alert topic's existing confirmed subscriptions determine who receives operational alerts.

## Environments and activation

New deployments default to weekly delivery off and no recipient. Only production can enable the weekly schedule. Non-production manual sending is restricted to the approved test recipients already configured for communications.

After staging verification and production deployment, open Settings → Marketing reports, save the intended recipient, and enable automatic Friday delivery. The Settings page is also the normal manual-send entry point. No immediate email is necessary to enable the Friday schedule.
