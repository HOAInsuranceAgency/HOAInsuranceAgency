# CRM latency validation

## Live staging observations

The live browser measurements are separate from the deterministic fixtures below.
`live-before.json` records the authenticated Admin baseline on the retained CRM
staging origin: 22 Leads, 11 Clients and the synthetic W8 Client. Its actual
release state was frontend job 19 with backend job 21; the latter's frontend
build failed before publication. `live-before-job19.json` preserves the earlier
baseline and is not the primary comparison input. Staging job 24 publishes
`b3de7a81ffad93fd2be0cb243ef09e6fed4bd7fd`, including the latency work and pending
upstream broker-fee UI. This is a whole-release staging comparison.

The observer source is `../live-flow-observer.mjs`. It records next-frame useful
DOM, GraphQL response completion, request counts and response-body byte counts
without retaining credentials, queries, request variables or response contents.
The matched suite has 19 navigations: Leads, Clients, the same Client Overview,
Policies, Documents and Activity over three rounds, plus a final warm Leads
return. First suite visits (N=1), repeated same-document returns (N=2), and final
warm return (N=1) must remain separate. The browser and service caches are not
controlled; no p95 or production latency inference is appropriate.

The completed comparison is in [`live-comparison.md`](live-comparison.md), with
full redacted samples in [`live-before.json`](live-before.json) and
[`live-after.json`](live-after.json). All 19 matched successful navigations kept
the same DOM row counts with no HTTP/GraphQL errors or visible alerts. Requests
fell **93 → 66** (29%) and response JSON bytes **1,044,080 → 232,758** (78%).
These totals cover the successful suites only. Reproduce the report from `crm/`:

```sh
node scripts/live-performance-compare.mjs scripts/performance-audit-results/live-before.json scripts/performance-audit-results/live-after.json scripts/performance-audit-results/live-comparison.md
```

| First suite visit (N=1 each) | Useful content before → after | Observed change |
| --- | ---: | ---: |
| Leads | 4,290 → 1,186 ms | 72% faster |
| Clients | 1,611 → 717 ms | 55% faster |
| Overview | 555 → 528 ms | 5% faster |
| Policies | 270 → 536 ms | 98% slower |
| Documents | 195 → 527 ms | 170% slower |
| Activity | 1,168 → 805 ms | 31% faster |

The initial baseline Leads visit actually made 12 requests, including a repeated
legacy load cycle; the other baseline list entries made six. That observation
is retained without treating the 72% improvement as a repeatable cold-cache
estimate. Every after list entry made three requests; warm list payloads fell
80% for Leads and 91% for Clients. Admin cached list content was already quick:
the two-return median moved from 13 → 25 ms for Leads and 13 → 17 ms for Clients.
Final warm Leads background completion was slower, 1,760 → 2,490 ms, despite
fewer requests; first content remained 24 ms.

The Activity two-return median improved **1,436 → 750 ms**. Its context request
median improved **1,429 → 739 ms**. Roster display requests on warm Leads improved
**930 → 557 ms**, while warm Clients roster requests were essentially unchanged
**1,168 → 1,153 ms**. These are small descriptive samples, not service-level
guarantees.

The common Carriers document reload also became slower in its single
observation: FCP **464 → 676 ms**, load event **433 → 661 ms**, and last initial
GraphQL response **2,155 → 2,882 ms**, with five resources in each. These setup
measurements are separate from the 19 route entries and do not prove a cold
cache or attribute the difference to the latency changes.

The detail-index recommendation has **not demonstrated a wall-clock speedup**
on this 33-account staging book. Repeated Overview, Policies and Documents also
became slower; request counts stayed 4, 2 and 7 respectively. Source tests prove
bounded indexed traversal and unchanged canonical authorization checks, but
cannot substitute for live latency. Follow-up should time the server query and
canonical-validation stages separately, compare equivalent representative data
volumes, and repeat the browser protocol on a stable network. Keep all current
record/session checks during that work. The mixed upstream release, small
sample, cache state and network failure prevent assigning these changes to one
cause.

The first job-24 attempt is retained in
`live-after-job24-attempt1-failed.json`: both initial Leads requests remained
pending beyond the 20-second bound and later rejected as network errors without
HTTP responses. Correlated Lambda calls finished normally; that does not prove
the location of the network failure. A successful retry must be reported
alongside this failure, not used to erase it.

The separate [Producer access observation](live-after-producer-access.json)
confirmed owned lists and account reads, then restored Admin. Its generated-forms
subpanel showed a redundant-parentheses DynamoDB filter warning in unchanged
baseline source; the main Documents list still rendered. This known limitation
is outside the clean Admin timing suite. See
[`producer-generated-forms-finding.md`](producer-generated-forms-finding.md).

Sanitized rollout evidence is in
[`staging-job24-deployment.json`](staging-job24-deployment.json),
[`staging-job24-iam.json`](staging-job24-iam.json) and
[`staging-job24-runtime-diagnostics.json`](staging-job24-runtime-diagnostics.json).
The post-run normal strict guard passed, current-day readiness was complete for
33 accounts, and all six mappings remained healthy. Two empty, protected derived
cache tables retained from rolled-back attempts remain outside the current stack
and were left untouched; the deployment evidence records them. No production or
public-site release was performed.

## Deterministic request-waterfall fixtures

These results exercise the actual React CRM screens and data-loading hooks against deterministic synthetic records. Every mocked GraphQL request takes **10 virtual milliseconds**, with no random jitter, retries or real AWS traffic. They quantify request count, payload volume, dependency ordering and time to first content under that model. They are **not production latency measurements**, browser CPU measurements or performance guarantees.

The same fixture contains 600 authorized association accounts: 300 Leads and 300 Clients, one contact per account, two quotes per Lead, one active policy per Client, one carrier and 12 documents on the selected account. Each document has 24,000 characters of synthetic OCR text. Default legacy model-list pages contain 100 records. Revised visible list pages contain 25 records; the export loader requests 50 per page. The selected account is a Client. List tests load the default unfiltered view and revisit it with the same provider. Separate tests traverse all 300 matching rows and export all 300 without first traversing the list. Detail tests open Overview, Policies and Documents directly. The communications test opens its real panel.

Run from `crm/` after installing locked dependencies:

```sh
node scripts/performance-audit.mjs --baseline e9c1081 scripts/performance-audit-results/before.json
node scripts/performance-audit.mjs scripts/performance-audit-results/after.json
node scripts/performance-audit-compare.mjs scripts/performance-audit-results/before.json scripts/performance-audit-results/after.json scripts/performance-audit-results/comparison.md
```

The baseline command archives the supplied Git revision into a temporary directory, copies the same harness into it, uses the existing dependency installation and deletes the temporary directory on exit. It does not switch branches or modify the baseline revision. The harness is skipped by normal test runs unless `CRM_PERF_AUDIT=1` is set.

Raw JSON records each request's start/end, returned row count and UTF-8 JSON bytes. `waterfallMs` is the last request completion relative to route entry; `firstContentMs` samples actual rendered content every five virtual milliseconds. Warm route revalidation and immediately available cached content are reported separately. The frontend boundary model cannot measure backend savings from replacing a scan with a query or removing per-teammate Cognito calls; those require the separate backend regression evidence and live measurements.

Counts use the real endpoint's response bound: four queries of at most 50 candidates, so each 300-row stage needs two count requests. Initial list entry therefore starts page and roster requests in parallel, displays rows, then finishes two background count requests: four eventual GraphQL requests in total. `requestsStartedBeforeFirstContent` records the two requests already started before the first rows, rather than confusing background totals with the row-display dependency. Full traversal requests the next visible page as soon as the previous page's rows appear, without waiting for background totals or adding simulated user think time.

The revised backend is assumed ready in the frontend fixture. During deployment initialization, the real UI retains the legacy loader until the materialized list reports ready. The fixture does not measure projection build duration or prove the projected endpoint's filtering, sorting and permissions; those are verified by backend tests. Admin warm navigation retains the existing immediate in-memory cache while revalidating; Producer and Staff views still require fresh authorization before showing prior records. User/role remounts discard the cache.

To change scale or the injected delay, set `CRM_PERF_ACCOUNTS` or `CRM_PERF_DELAY_MS` consistently for both commands. Timing values from different fixture settings must not be compared.

## Deployment admission and production naming context

The existing deployment guard still checks the exact original **57 stateful physical identities**, **22 migrated cursor UUIDs and stream generations**, and **eight schedule identities/targets/times** against the unchanged environment-specific `amplify/steady-state-main.json` or `amplify/steady-state-staging.json` contract. `scripts/steady-state-account-list.mjs` separately admits only the complete, exactly named account-list extension, with fixed allowlists for the two exact retained roots: one rebuildable private table, six source mappings and one minute schedule in its own worker stack. Before the first deployment, the extension must be absent; afterward all additions must be present. Unexpected tables, mappings, schedules, swapped main/staging scope or partial additions are rejected. Staging's backend namespace remains dormant, and its original disabled weekly marketing schedule remains disabled.

The extension checks its exact worker/role inventory, private table schema, six original source-table identities and current stream ARNs, mapping target/batch/retry settings, and schedule timing/target/retry settings using read-only AWS calls. The four source streams already covered by the original cursor contract retain their pinned generations; UserProfile and Communication streams are checked against their original table identities and current `describe-table` results. This allowance does not relax or rehash the original inventory. The new derived table is intentionally rebuildable; its exact logical identity and owned schema are checked rather than inventing a predeployment physical ID.

The earlier offline synth used the actual destination app/main naming context; its largest CloudFormation template was **972,324 bytes** against the existing 1,000,000-byte gate (`production-synth.json`). After integrating retained staging's broker fees and analytics fence at `2e99253a` into the latency candidate `5332901`, the final offline preflight used the exact retained staging naming and permanent migration controls. It passed at **984,943 bytes**, with 59 stateful resources (the original 57, broker-fee ledger and account-list projection), 28 source mappings, nine Scheduler schedules and one broker-fee EventBridge rule. All 12 staging extension logical IDs match that assembly (`staging-synth.json`). Identical additive fee/list grants are attached as managed policies to preserve the roles' aggregate inline policy budgets. These results validate synthesis and naming; they do not admit a live rolled-back root for deployment.


The deployment guard remains strict after a rollback. An explicitly reviewed retry of the exact retained staging backend can run `node scripts/assert-migration-destination.mjs --staging-only --recover-staging-rollback` in the verified steady-state staging environment. This permits only `UPDATE_ROLLBACK_COMPLETE` on that pinned root and nested CloudFormation stack resources; all original identities, current mapping/schedule health, namespace fences, and separately protected additions are still verified. Other resource rollback states, incomplete rollbacks, production and other roots are rejected. The command prints a receipt with actual observed statuses and the validated inventory counts for the deployment record; normal automated deployments do not opt into recovery.


The communications reader reuses its existing `ACCESS_API_ID` and `COMMUNICATION_TABLE` values to derive the source names. Only the projection worker receives `ACCOUNT_LIST_SOURCE_TABLES`. Six redundant dashboard/deletion table aliases are also derived from the existing API ID; explicit legacy overrides remain supported, and every index remains required. Lambda measured the earlier proposal at **4,234 serialized environment bytes**. The corrected measurement counts the compact `Environment.Variables` JSON, including quotes, delimiters and escaping; after removing the six aliases it is **3,811/4,096 bytes**, leaving **285 bytes**. The prior raw key/value sum understated this limit. `communications-env-quota.json` contains the corrected size-only proof, validated against the service's exact rejected size. Synthesis verifies the aliases are absent and the canonical API ID is unchanged; read and deletion tests prove equivalent tables, indexes, results and retention checks. The private table, grants and authorization are unchanged.
