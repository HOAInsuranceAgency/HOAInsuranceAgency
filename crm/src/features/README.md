# CRM feature ownership

These folders own multi-step screen behavior. The existing route/component paths remain stable entrypoints for callers and previews; reusable visual controls stay in `components/ui`.

| Feature | Ownership |
| --- | --- |
| `commissions` | Private commission snapshots, ledger/expected-receipt review, producer agreements, account classifications, carrier terms, reconciliation, payroll, and historical policy adoption. |
| `extraction` | Extracted-value decoding and payloads, candidate matching against saved rows, review rendering, polling, and the explicitly reviewed apply operation. |
| `invoicing` | Draft line reconciliation, queued edits and financial actions, and invoice line/details/delivery rendering. |

Commission role changes still key the whole private view, and its stale-report context disables financial forms and downloads. The feature's `ActionForm` owns draft baselines and single-flight submission; reset callbacks acknowledge their saved draft.

Extraction review and writes consume the same candidate payloads. Applying first records the extraction identity, then performs matching child writes and reports partial failures. Matching-resource refreshes and account-switch cleanup remain part of that operation.

Invoice actions share one controller and queue. Blur saves, raw amount drafts, acknowledged edits, send identity, voids, and manual receipts must remain in that lifecycle. The line-loading hook intentionally reconciles draft source rows and is not a background/live reader. Presentation components receive a typed subset of the controller and do not call billing APIs.

New work should extend the feature that owns the decision. Move a helper to `lib` or `shared` only when another feature or runtime needs the same behavior; avoid creating parallel save queues, matching rules, or financial eligibility checks in presentation components.
