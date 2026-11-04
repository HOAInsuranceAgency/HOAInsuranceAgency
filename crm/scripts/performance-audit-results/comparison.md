# CRM performance fixture comparison

**These are deterministic fixture measurements, not production AWS or browser timings.** The same actual React screens/hooks use the same synthetic data and injected per-request delay in both runs. Backend service counts are reported separately.

Before source: `e9c1081`. After source: `working-tree`.

| Flow | Requests before → after | JSON bytes before → after | First content, virtual ms before → after | Last request, virtual ms before → after |
| --- | ---: | ---: | ---: | ---: |
| lead-list-cold (ADMIN) | 43 → 4 | 498,584 → 20,944 | 130 → 10 | 130 → 30 |
| lead-list-warm-return (ADMIN) | 43 → 4 | 498,584 → 20,944 | 0 → 0 | 130 → 30 |
| client-list-cold (ADMIN) | 40 → 4 | 476,000 → 20,965 | 130 → 10 | 130 → 30 |
| client-list-warm-return (ADMIN) | 40 → 4 | 476,000 → 20,965 | 0 → 0 | 130 → 30 |
| lead-list-all-pages (ADMIN) | 43 → 15 | 498,584 → 248,316 | 130 → 10 | 130 → 120 |
| client-list-all-pages (ADMIN) | 40 → 15 | 476,000 → 248,612 | 130 → 10 | 130 → 120 |
| lead-list-cold-then-export-all (ADMIN) | 43 → 10 | 498,584 → 268,557 | 130 → 10 | 130 → 90 |
| client-list-cold-then-export-all (ADMIN) | 40 → 10 | 476,000 → 268,878 | 130 → 10 | 130 → 90 |
| account-overview-cold (ADMIN) | 4 → 4 | 618 → 618 | 20 → 20 | 20 → 20 |
| account-policies-cold (ADMIN) | 3 → 3 | 608 → 608 | 20 → 20 | 20 → 20 |
| account-documents-cold (ADMIN) | 8 → 8 | 340,427 → 340,427 | 20 → 20 | 20 → 20 |
| communications-context-cold (ADMIN) | 1 → 1 | 272 → 272 | 10 → 10 | 10 → 10 |

Initial entry starts the page and roster requests in parallel. Rows appear before the two bounded background count requests finish: the table reports all four eventual requests, while raw JSON separately records the two started before first content.

First-page results intentionally compare the initial visible work view: the old list rendered all 300 matching rows; the paged implementation initially renders 25. Full-list traversal and complete exports appear separately. Admin warm navigation retains immediate cached content while revalidating; Producer/Staff still require fresh access before cached rows can appear. Remaining detail-tab/network counts stay unchanged because index and roster improvements occur behind the GraphQL boundary. The revised projection is assumed ready; deployment initialization uses the legacy fallback.

See `README.md` and raw JSON for fixture size, operation counts, payload definitions and reproduction commands. Backend tests and structural benchmarks establish index use, row evaluations and removed Cognito fan-out; they do not establish production p50/p95 latency.
