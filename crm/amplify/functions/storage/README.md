# Backend storage mechanics

These helpers execute reads or validate transaction envelopes. Callers still
own authorization, projections, table/index IAM, optimistic conditions, domain
validation, idempotency, recovery, audits and notification audiences.

`batchGetComplete` retries only DynamoDB **unprocessed read keys**, never a
financial write or an external payment/email command. It deduplicates keys,
chunks at 100, retains consistency/projection settings on retries, waits for
every read in a concurrent wave, and throws rather than returning partial rows.

| Existing caller | Maximum keys | Attempts per batch | Concurrent batches |
| --- | ---: | ---: | ---: |
| Communications `batchGet` | 100 | 4 | 1 |
| Assignment migration `readPage` | 100 | 4 | 1 |
| Relationship `relationshipBatch` | 100 | 4 | 1 |
| AccountAccess `prefetch` | Existing caller scope; chunks of 100 | 4 | 1 |
| Dashboard `reportBatchGet` | 500 | 4 | 4 |
| Commission `getMany` | 5,000 | 5 | 1 |
| Broker-fee `accountAgreements` | 5,000 | 5 | 1 |

Assignment migration catches `ReadDeadlineExceeded` and leaves its checkpoint
unchanged. Missing rows are legitimate; unprocessed keys are not missing rows.
Domain wrappers continue verifying returned agreement/account/quote identity.

`collectCompletePages` follows empty filtered pages, detects repeated cursors
including reordered composite keys, and throws on exhaustion. Its limits remain
explicit at each caller:

| Existing complete read | Pages | Other existing limits |
| --- | ---: | --- |
| Broker-fee account models | 100 | 5,000 rows |
| Broker-fee account fees | 100 | 5,000 fee rows |
| Broker-fee agreement discovery | 100 | 5,000 distinct agreement IDs |
| Commission history | 100 | 5,000 rows |
| Commission bind policy history | 100 | Existing policy/quote checks |
| Legacy commission policy history | 100 | Existing first-bind calculation |
| Owner report collection | 200 | 25,000 rows per collection |
| Marketing report collection | 2,000 shared | 100,000 rows, 48 MiB and 180 seconds across sources |
| Original invoice premium-line discovery | 20 | 500 candidate line IDs |
| Manual invoice-payment line discovery | 100 | 70 current verified lines |

The manual-payment read previously had a row bound but no page/cursor bound;
it now fails after 100 pages or a cycle instead of allowing an endless empty
index traversal. All discovered lines still receive the same strong reread.
Existing messages, early duplicate-policy rejection and strong-read conditions
remain at the domain boundary.

Do not use this complete-list contract for intentionally paginated endpoints,
existence probes that stop at the first match, resumable workers/migrations,
deadline-limited recovery sweeps, or Front/Stripe/Cognito provider pagination.
Those APIs deliberately retain their continuation/recovery contracts.

`assertTransactionEnvelope` checks the existing per-store item/byte budgets and
duplicate keyed targets before sending. Put keys are checked only when the
caller supplies that table's known key fields. It does not construct business
writes, split a financial transaction, select an audience or retry anything.
Commission envelope size now uses UTF-8 bytes, matching the existing byte-based
item guard and broker-fee envelope guard.

`conditionalConflict` and `retryableStorageFailure` preserve the existing
communications classifications. They distinguish a lost condition from
throttling/service failure; callers still decide whether to recover or retry.
Financial rules depending on a specific cancellation-reason position remain in
their domain modules.

`resolveModelTable` reads trusted deployment configuration, preserving each
caller's environment/table-map precedence and retained API namespace. Private
Communication storage requires its explicit table. `modelKeyName` preserves
the schema's `accountId` identifiers for GL/D&O singleton applications; other
models retain `id`. None of these helpers authorizes a caller or broadens IAM.

`model-indexes.ts` describes generated model-index keys using the existing model
classification and authoritative list-parent partitions. The deployment producer
and runtime readers use these keys, including the two-entry invoice projection.
It is loaded at synth time: keep every dependency within `amplify/`, SDK-free, and
free of runtime initialization. Private domain indexes keep their own contracts.

`index-config.ts` parses `ACCESS_INDEXES` and validates the selected index name.
Callers provide their own error and explicitly opt into any existing nested map
or physical-name fallback. Do not pass browser-supplied configuration or enable a
fallback for a reader whose missing configuration must fail closed.
