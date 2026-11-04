# Access and export verification

This review covers the CRM latency changes in the working tree. It is not a production acceptance or deployment result.

| Control | Verification |
| --- | --- |
| New page/count operations choose agency or own-salesperson scope from the verified active role | Endpoint tests cover Owner, Admin, Producer and Staff; foreign salesperson selection and altered actor/role/filter/partition cursors are rejected. |
| Materialized rows do not grant record access | Source versions, source presence, required dependencies and canonical child account IDs are checked before rows return. The custom postfilter rechecks current assignment. |
| Deactivation remains effective on the next request | Existing session guard remains before indexed/custom access. Tests cover deactivation and reassignment while reads are in flight. |
| Admin exact-account lists use indexes; broad lists retain native behavior | Contact/Policy/Document query assertions and actual AppSync mapping-template evaluations cover the route decision. Non-admin ownership and canonical-parent checks remain in place. |
| Slow roster/count work does not block initial rows | Independent hook tests hold directory/count promises unresolved while authorized rows become visible. |
| Late data cannot restore rows after denial or role changes | Independent hook tests cover role remounts, view changes, pending Load more after counts denial and pending exports after access-generation revocation. |
| Warm cache does not bypass scoped access | Admin reuses its authenticated-shell cache while refreshing. Producer/Staff prior rows remain hidden until a fresh page succeeds. User/role remounts discard snapshots. |
| Export includes every filtered row | Fixture tests export all 300 matching rows without first loading more visible pages. Both legacy and revised code receive the same fixture. |
| Async printing retains the browser user gesture | PDF opens synchronously before report reads, immediately clears `opener`, and fills that same window after successful loading. Duplicate requests are blocked; failure or unmount closes the pending window. |
| Existing CSV/print callers retain behavior | Existing report serialization and dashboard export tests pass, including CSV formula escaping and printable HTML escaping. |

Independent frontend verification: 30 passing tests across `pagedAccountsListData.test.tsx`, `ReportDownload.test.tsx`, existing `reportDownload.test.ts`, `dashboardDownloads.test.tsx` and `FinanceTab.test.tsx`, including retaining a loaded 50-row window while both fresh pages arrive on warm return and displaying a bounded sparse cold page without automatically draining more pages. The access agent also reported 249 passing tests across five backend access suites, plus 14 successful AppSync VTL evaluations; see the raw backend artifacts for their exact fixtures and limits.

The request-waterfall fixture proves frontend request orchestration and complete traversal/export behavior. Endpoint/projector unit tests establish filtering, sorting and source-validation behavior. Neither substitutes for measured production p50/p95 latency or completion of the projection's deployment initialization.
