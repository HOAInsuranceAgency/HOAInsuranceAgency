# Live staging CRM latency comparison

These are matched authenticated browser observations. First useful content means the next animation frame after the target DOM becomes useful. API completion means the last observed GraphQL response body; background work is reported separately from first content.

**First visits and cached returns are separate.** A first suite visit has N=1 per flow and is a single observation, not a median estimate or a demonstrated cold cache. Same-document return medians have only the stated sample count. No p95, confidence interval, or population performance claim is inferred.

Target: [staging CRM](https://migration-staging.d1nuh9rw1hcuxo.amplifyapp.com). Role: ADMIN. Dataset: 22 Leads and 11 Clients.

Frontend asset: `index-BWEoqmE0.js` → `index-IHeVRLo9.js`.

Capture windows: before 2026-11-04T20:11:47.815Z–2026-11-04T20:12:33.671Z; after 2026-11-04T22:01:32.566Z–2026-11-04T22:02:14.946Z.

Before release: Mixed partial upstream release: job21 backend succeeded; frontend failed TypeScript out-of-memory and remains job19. Latency optimizations not yet deployed.

After release: Hosted job24 succeeded; backend and frontend latency release deployed. Root verified normal strict guard and health pass; current-day READYversion1 completeprocessed33 pending0 at21:41:38Z before measurement.

**Prior failed after attempt retained:** [live-after-job24-attempt1-failed.json](live-after-job24-attempt1-failed.json). The successful matched run below is a retry. See the README and deployment evidence for the observed network errors and limits of the server-side correlation.

Across the 19 matched successful navigations: **93 → 66 GraphQL requests**, and **1,044,080 → 232,758 response JSON bytes**. These totals exclude the separately retained failed attempt; they do not pool timing distributions.

## Carriers document reload — single observation per release

This is the common suite setup page, measured separately from route entry. It does not establish a cold HTTP or service cache.

| Metric | Before → after |
| --- | ---: |
| DOMContentLoaded ms | 338.5 → 564.6 |
| Load event ms | 433.3 → 661.3 |
| First contentful paint ms | 464 → 676 |
| Last initial GraphQL response ms | 2,154.6 → 2,881.5 |
| GraphQL resources | 5 → 5 |

## First suite visit — single observation per flow

| Flow / role | N before / after | First useful ms, before → after | Change | Last API ms, before → after | GraphQL requests, before → after | JSON bytes, before → after | DOM rows, before → after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| leads / ADMIN | 1 / 1 | 4,290.1 → 1,185.5 | -72.4% | 6,640.9 → 1,921.1 | 12 → 3 | 238,784 → 24,339 | 22 → 22 |
| clients / ADMIN | 1 / 1 | 1,611.1 → 717.4 | -55.5% | 1,601.8 → 1,576.9 | 6 → 3 | 115,588 → 10,774 | 11 → 11 |
| overview / ADMIN | 1 / 1 | 554.5 → 528.3 | -4.7% | 1,182 → 1,338.1 | 4 → 4 | 2,623 → 2,647 | 1 → 1 |
| policies / ADMIN | 1 / 1 | 270.2 → 535.6 | 98.2% | 302.3 → 531.6 | 2 → 2 | 3,059 → 3,309 | 2 → 2 |
| documents / ADMIN | 1 / 1 | 195 → 526.5 | 170% | 381.6 → 724 | 7 → 7 | 7,481 → 8,115 | 3 → 3 |
| activity / ADMIN | 1 / 1 | 1,168.3 → 804.5 | -31.1% | 1,165.5 → 799.4 | 2 → 2 | 20,289 → 20,289 | 23 → 23 |

## Same-document returns — repeated observations

| Flow / role | N before / after | First useful ms, before → after | Change | Last API ms, before → after | GraphQL requests, before → after | JSON bytes, before → after | DOM rows, before → after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| leads / ADMIN | 2 / 2 | 13.1 → 25.3 | 92% | 1,847.5 → 1,303.2 | 6 → 3 | 119,392 → 24,339 | 22 → 22 |
| clients / ADMIN | 2 / 2 | 13.2 → 17.2 | 30.8% | 1,781.7 → 1,772.4 | 6 → 3 | 115,588 → 10,774 | 11 → 11 |
| overview / ADMIN | 2 / 2 | 239.2 → 385 | 61% | 809.1 → 1,175.6 | 4 → 4 | 2,623 → 2,647 | 1 → 1 |
| policies / ADMIN | 2 / 2 | 320.2 → 399.2 | 24.7% | 318.2 → 566.1 | 2 → 2 | 3,059 → 3,309 | 2 → 2 |
| documents / ADMIN | 2 / 2 | 232.8 → 520.7 | 123.6% | 341.9 → 662.5 | 7 → 7 | 7,481 → 8,115 | 3 → 3 |
| activity / ADMIN | 2 / 2 | 1,435.8 → 749.5 | -47.8% | 1,433.4 → 745.8 | 2 → 2 | 20,289 → 20,289 | 23 → 23 |

Observed first-content ranges (ms; descriptive only):

- leads / ADMIN: 13.1–13.2 before; 24.5–26 after.
- clients / ADMIN: 12.5–13.8 before; 15.2–19.2 after.
- overview / ADMIN: 184.8–293.6 before; 384.4–385.7 after.
- policies / ADMIN: 296.2–344.2 before; 366–432.4 after.
- documents / ADMIN: 144.6–321 before; 500.9–540.4 after.
- activity / ADMIN: 1,072–1,799.5 before; 682.8–816.1 after.

## Final warm return — single observation per flow

| Flow / role | N before / after | First useful ms, before → after | Change | Last API ms, before → after | GraphQL requests, before → after | JSON bytes, before → after | DOM rows, before → after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| leads / ADMIN | 1 / 1 | 14.8 → 24.3 | 64.2% | 1,760.1 → 2,489.9 | 6 → 3 | 119,392 → 24,339 | 22 → 22 |

Maximum recorded observer JSON parsing/byte-count CPU: 1.5ms before; 0.3ms after. Stream-cloning overhead was not independently isolated.

GraphQL counts are browser requests, not DynamoDB operation counts. Browser HTTP and AWS service caches are uncontrolled. First-page list observations may render fewer rows after pagination on larger datasets; DOM row counts are retained for context. Source data, projection readiness, authorization behavior, and completed exports need their separate checks.
