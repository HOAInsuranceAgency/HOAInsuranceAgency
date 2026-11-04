# CRM list, roster and account-detail performance

This change implements the first three latency-audit recommendations against
`e9c1081`: paged Leads/Clients, inexpensive directory display reads, and indexed
account-detail reads for Owner/Admin as well as Producer/Staff. Public-site code
and public intake behavior are unchanged.

## List behavior

`accountListPage` returns 25 compact rows by default. Filtering and all existing
sort options execute against a private materialized index, before the browser
receives rows. Null sort values remain last in either direction. Text keys use
case/accent-normalized UTF-8 ordering; punctuation and ligatures can differ from
the browser's former locale collation.

Primary contact, renewal date, current salesperson, follow-up, opportunity and
pending commission are included. Partially bound Clients remain in Leads until
their selected package is finished. Saved views, inline edits, role-scoped
preferences and the previously loaded row window are retained. Load more appends
another page. CSV and print exports fetch the complete filtered result on demand,
including rows the user has not loaded; repeated IDs during concurrent changes
are deduplicated. Background totals do not delay first rows.

The authenticated shell owns a bounded in-memory Admin list cache. Producer and
Staff route entries still wait for a fresh server response. Role/user remounts
discard snapshots; access failures purge data and invalidate pending pages,
totals and exports. No CRM records are saved in browser storage.

## Projection and authorization

The new DynamoDB table is server-only, outside the public/generated model API.
Only the reader and dedicated projector receive IAM access. Each source change
rebuilds compact summaries and publishes all new sort entries plus their snapshot
in one transaction. Old keys have a retry-safe cleanup journal. Agency and
salesperson partitions are discovery indexes, never authorization.

Every returned row is checked against consistent current source metadata and
canonical child account IDs. Current workflow assignment and deletion markers
are checked for every page; the existing AppSync post-guard checks assignment
again before returning scoped results. Session deactivation, active-role
validation, financial write controls and file-signing limits remain intact.

Account, Contact, Quote, Policy, UserProfile and relevant communication changes
drive six source streams. Profile-name changes queue bounded fan-out jobs. The
single projector uses four-account checkpoints, restarts partial pages and
reconciles periodically without re-reading the entire book every minute. A new
agency day triggers a complete, checkpointed rebuild for date-sensitive forecasts.

The fast path is enabled only after the readiness marker confirms a complete
build for the current Eastern agency day. An unready index, stale existing
dependency or excessive dependency budget falls back to the existing authorized
loader rather than returning a partial projection as complete. Explicit/return
refreshes probe the fast path again. New inserts become visible after stream
projection; this is an eventual read model, not an atomic view of every business
table. Accounts with more than 256 dependencies or pages requiring more than
2,000 source keys use the safe fallback instead of unbounded verification.

## Roster and detail reads

Routine directory reads join narrow profiles with existing materialized
eligibility snapshots, avoiding per-person Cognito and access-status requests.
Those values are display hints. Assignment/settings writes still verify current
roles and availability, including the transaction-time deactivation condition.
Missing eligibility is nonassignable until the existing producer reconciliation
materializes it. Compact communication polls omit the directory entirely and
retain scoped display names; explicit reads and write refreshes reload it.

For Owner/Admin, recognized exact-account/parent filters now use existing
partition indexes. Broad administrator lists retain their prior native path.
Indirect records follow current canonical parents. Producer/Staff authorization,
filters, cursor binding and consistent candidate revalidation remain unchanged.

## Verification and comparison

Reproduction commands, raw fixtures and full results are in
[`crm/scripts/performance-audit-results/`](../crm/scripts/performance-audit-results/README.md).
The fixture executes the actual React screens with the same 600 records and
10 virtual milliseconds per mocked GraphQL request on both revisions.

| Same flow | Before requests | After requests | JSON bytes before / after |
| --- | ---: | ---: | ---: |
| Cold Leads, 25 initial rows | 43 | 4 | 498,584 / 20,944 |
| Cold Clients, 25 initial rows | 40 | 4 | 476,000 / 20,965 |
| Entire 300-row matching list | 43 / 40 | 15 | See raw results |
| Cold entry plus complete export | 43 / 40 | 10 | See raw results |

Two requests start before the first rows; two bounded totals requests finish
afterward. Modeled first content improves from 130 to 10 virtual milliseconds.
Admin warm content remains immediate. These are controlled dependency/request
measurements, not measured production AWS/browser latency or p50/p95 claims.

Overview, Policies, Documents and communication-context frontend request counts
remain unchanged. Their backend savings have separate evidence: exact-account
detail reads replace modeled three-page/230-candidate scans with an actual
one-page indexed traversal of 30 candidates plus consistent current-record
checks. Fourteen real AppSync mapping-template evaluations verify role/filter
bypass behavior with synthetic contexts. Roster tests verify zero per-person
Cognito calls and unchanged live write checks.

The actual source reader, projector, transaction writer and endpoint are also
tested together for all 15 sorts, both directions, pagination, views, dates,
filters, counts beyond 200 rows, and all four roles. Security regressions cover
forged roles/cursors, changed assignments, moved/deleted children, deactivation,
late responses and source-read failures.

## Release and live measurement

Deploy the backend before the frontend in the current-account staging
environment. The projector initializes automatically; wait for `CONTROL/READY`
to report `version: 1`, `complete: true`, and today's Eastern `day` before timing
the fast path. Do not disable the existing migration, stateful-resource, session
or role guards to run this check. The additive release allowance pins the one
new private table, six source mappings and one schedule while retaining every
original stateful identity, cursor and schedule check.

Repeat the same cold Leads/Clients reload, warm return, list-to-Overview,
Policies/Documents tab opening, and Front context refresh under the same user,
active role, records, browser, network and cache conditions. Record first useful
content separately from background completion, request/payload counts, API
durations and errors. Use repeated samples and report p50/p95 only with a stated
sample size. Check a scoped Producer/Staff view as well as Owner/Admin, and
confirm reassignment/deactivation still rejects the next request.

On November 4, 2026, the `hoa-crm` AWS profile authenticated to the current CRM
account `917680434255` through its existing organization access role. The default
profile was left unchanged. Amplify staging job **24** successfully deployed
`b3de7a81ffad93fd2be0cb243ef09e6fed4bd7fd` to the retained
`codex-hoa-staging-migration` branch. The normal strict postdeployment guard
passed, all six projection mappings were healthy, and `CONTROL/READY` reported
today's complete 33-account build. The original 57 stateful identities, 22 stream
cursors and eight schedules remain protected. Production and the public site
were not deployed.

The live baseline uses the actual stable staging state before this release:
frontend job 19 (`205bf8f`, `index-BWEoqmE0.js`) with backend job 21 (`01980f0`).
Job 21's backend succeeded while its frontend build exhausted memory. Job 24
therefore also delivers the pending upstream broker-fee UI. The comparison is
an observed staging release comparison, not an isolated causal experiment for
the latency changes alone. The matched browser protocol uses the same Admin,
22 Leads, 11 Clients, fixed synthetic W8 Client, browser and 19 navigations.
First visits (one observation) and same-document returns (two observations)
remain separate; neither supports a p95 or production performance claim.

The [live comparison](../crm/scripts/performance-audit-results/live-comparison.md)
records all 19 matched successful navigations, separately from the preserved
first network-failed after attempt. First-visit Leads improved 4,290 → 1,186 ms,
Clients 1,611 → 717 ms, and Activity 1,168 → 805 ms. Browser requests fell
93 → 66 and response JSON bytes 1,044,080 → 232,758. Detail results were mixed:
Policies rose 270 → 536 ms and Documents 195 → 527 ms. Their repeated returns
were also slower. Indexed-detail scaling tests do not establish a live speedup
on this small staging book; the next investigation should time query and
canonical-validation stages separately while retaining all authorization checks.
