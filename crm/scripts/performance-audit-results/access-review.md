# Access and export verification

This review covers the CRM latency changes deployed to staging by job 24 at
`b3de7a81ffad93fd2be0cb243ef09e6fed4bd7fd`. It is not a production acceptance.

Compared with the actual pre-latency staging backend (`01980f0`), the Cognito
configuration, data schema, session/access handler, active-role validation,
persistent user-status checks, file-signing rules, policy access and lead
assignment boundaries are unchanged. The new operations enter through the same
initial session guard. The private projection has no browser/Cognito grants.
The public `web/` tree is byte-identical to that baseline.

Final source validation passed 4,912 tests (10 skipped), backend typechecking,
frontend build and retained-staging synthesis under Node 22. Focused review
included 738 security/parity/cache tests and 58 existing authentication,
deactivation and control tests. These test results verify defined regressions;
they are distinct from the live UI checks and do not claim exhaustive security
proof.

The normal strict postdeployment guard passed against the exact retained root.
It preserved all original 57 stateful identities, 22 cursor identities and eight
schedules. Deployment-role updates add only exact staging metadata resource
scopes to existing verification actions; they grant no new actions, record reads,
record writes or CRM user access. The default AWS profile, native invite-only
authentication and disabled Google sign-in remain unchanged.

The live Admin timing suite completed all 19 navigations with no alerts or
HTTP/GraphQL errors and unchanged row counts. A separate switch using the same
session's existing Producer role confirmed 22 Leads, 11 Clients, exactly one W8
fixture, owned Overview, two Policies, three Documents and Activity history.
The role was restored to Admin. This verifies those positive reads, not another
producer's denial or a live reassignment/deactivation transition; the latter
remain covered by regression tests rather than destructive staging mutations.

The Producer Documents generated-forms subpanel showed one warning on each of
two visits; the retained second warning was `Invalid FilterExpression: The
expression has redundant parentheses`. The compiler and caller are unchanged
from the baseline backend. See `live-after-producer-access.json` and the separate
source finding. Main Documents still rendered, but this is **not an all-role
clean acceptance**. No application records, assignments or access settings were
changed during these browser checks.

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
