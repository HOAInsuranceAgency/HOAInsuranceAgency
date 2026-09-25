# CRM UX implementation — September 24, 2026

This change implements the main navigation, density, editing, and responsive recommendations from [the CRM UX audit](CRM-UX-AUDIT-2026-09-24.md). It is proposed for `staging`; it does not deploy or enable production Honeycomb submissions.

## What agents see

The landing page is **My work**, focused on assigned actions due now. **Accounts** contains Leads, Clients, Quotes, and Policies. The other primary destinations are Carriers, Billing, Reports, and Settings. The desktop sidebar can collapse and remembers the preference.

An account opens with contact/property/renewal facts and a bounded next-action workspace. Six section groups replace the long row of tabs: Summary, Coverage & markets, Documents, Billing, Timeline, and Account details. Detailed underwriting forms open on request. Old route/query links remain supported.

## Audit coverage

| Finding | Implemented change |
| --- | --- |
| UX-01 Work vs. directory | My work landing page; separate Accounts directory; carrier deadlines, renewals, team setup, and team report are explicit work subviews. |
| UX-02 Account density | Read-only account summary; named next-action owner; action explanation disclosure; account/property editors moved out of the default summary. |
| UX-03 Overloaded queues | Explicit personal/team scope and due/scheduled filters; account grouping; bounded actions/report pages; shared setup and reminder history load on request. Distinct tasks remain intact. |
| UX-04 Blocking dashboard | Lazy route modules; independent account/quote/policy report cards; broad agency checks deferred; short-lived session cache, freshness, refresh, and local errors. |
| UX-05 Wide working tables | Six-column account working view, next action/due data, 25-row pages, mobile records, URL-backed filters/sort/page. Detailed columns remain an explicit reporting view. |
| UX-06 Editing inconsistency | Shared field/control styles; explicit quote/policy status Save/Cancel; dirty-form route protection; formatted carrier money/phone/percent controls; teammate SMS edits use Save/Cancel. |
| UX-07 Accessibility | Field/label associations across existing forms, real record links, keyboard sort buttons with sort state, visible focus styles, named mobile section pickers. |
| UX-08 Navigation/context | Remembered sidebar collapse, active parent destinations, account breadcrumbs with originating list state, six account groups, compact agency identifiers. |
| UX-09 Mobile workflows | Working tables become labeled records, controls constrained to the viewport, fewer default quote/policy columns, section selectors and bounded work lists. |
| UX-10 Quote-to-policy journey | Workflow guidance, quotes before optional packages, coverage-specific GL fields, explicit client-approval vs. carrier-binding labels, named Honeycomb view with intentional availability guidance. Existing safeguards remain. |
| UX-11 Document overload | File search/category/association filters, explicit separate upload destination, secondary file actions, extraction and application forms in separate subviews, ready forms first. |
| UX-12 Activity density | Conversations and internal notes form the default timeline; bounded communication/change-history pages; technical before/after values behind details. |
| UX-13 Financing location | Operational Billing destination; invoices/loans grouped within accounts; financing rules moved to admin Settings; inactive loan history behind a filter; corrected outdated document instructions. |
| UX-14 Carrier usability | Searchable/paginated directory, concise state summary, account-prefilled market finder on request, contact summary before appointment editing. |
| UX-15 Administration | Invitation first, one member table with per-person settings, shared manager coverage disclosed separately, personal signature as default Settings view, consistent states/DC coverage totals. |
| UX-16 Unknown data | Renewal premium completeness counts, explicit missing values and empty-loss qualifications, template generation-readiness labels; no automatic duplicate merging. |
| UX-17 New lead | Identity/source/contact first; optional property/assignment/files; Cancel; summary destination after creation unless files require review. |
| UX-18 Retrieval/recovery | Searchable quote/policy directories, current/history views, selected-record anchors, document-result filters/pages, sign-in sending/resend/recovery guidance, preserved sign-in return query. |

The shared kit and future screen conventions are documented in `crm/src/components/ui/README.md`. A local preview renders the actual pages with fictional data and disabled writes; see `crm/scripts/crm-ux-preview/README.md`.

## Validation

- **Passed:** full Vitest suite (122 files / 2,321 tests), frontend/backend TypeScript checks, production Vite/Front-sidebar build, and `git diff --check`.
- New regression coverage checks labeled fields, keyboard and URL-controlled sorting, explicit status drafts, dirty-form navigation, visible-account next-action responses, independent overview loading/error recovery, cached refresh/session clearing, and upload destination independence.
- Local Chrome checks at **390 × 844**: Accounts/Clients, account summary, expanded property editor, quotes, documents, new lead, quote/policy directories, carriers/detail, Billing, Reports overview, Settings/signature, expanded team controls, and certificate draft/review rendered without whole-page horizontal overflow.
- At **1280px** with the sidebar expanded, the account working table was **944px in a 944px container** with a **1280px document width**. Sidebar collapse/expand also worked at desktop widths.
- In the sampled 390px account summary, the first action began at **764px** and its named owner at **802px**, including the local preview banner. Previously the audit found next actions beginning at 2594px on a sampled account. These are different fixture/live records, so this is a layout observation, not a controlled performance or record-for-record benchmark.
- The local certificate flow reached a review of holder, named policy, and term before the separate **Generate & record certificate** action. No certificate was generated or shared.

## Boundaries for staging review

- The original p95 timing budget, transferred-data target, and five unaided agent journeys still require measurement with real staging data/users. This change removes blocking dependencies and improves refresh behavior; it does not introduce materialized server-side dashboard aggregates. Some directories/reports still fetch full datasets before presentation pagination.
- Timeline now consolidates conversations/notes and separates record changes. It does not yet synthesize every quote, policy, invoice, and submission mutation into one deduplicated business-event feed.
- Saved view state is encoded in account URLs; there is no named-view storage or scroll-position restoration. Wide analytical tables remain deliberate report views. Mobile record cards have a sort field and direction picker that shares state with the desktop headers.
- Unsaved protection covers forms using the shared form/dirty hooks, including consequential status drafts. Existing purpose-built action editors retain their own behavior; this is not a claim of a universal form migration or screen-reader conformance.
- Real-device keyboard behavior, screen-reader review, email delivery/expired-link recovery, authenticated role journeys, and live billing/carrier mutations were not exercised. No real messages, financial actions, carrier submissions, or production record edits were made during verification.
- Review with realistic large datasets and each CRM role before merging to main. The build still reports large shared bundles; route splitting improves deferred loading but is not a complete bundle-size remediation.

## PR review fixes — September 25, 2026

- Reset the connection editor when switching teammates, preventing an old person's draft from appearing under the new selection.
- Resolve renewal-start links using the destination account's current stage: Quotes for leads, Policies for clients. This applies to shared work/report/reminder links and remains valid after conversion.
- Add shared mobile sort field/direction controls to every sortable list whose table headers are hidden on phones, including account records and child-row lists.
- Clear the saved lead draft after successful lead creation even when contact creation or file upload fails. Keep the recovery warning and protect genuinely uncreated drafts; rejected contact writes also reach the recovery state.

Regression tests cover switching and saving teammate connections, renewal destinations for both stages, mobile/desktop sort synchronization with missing values, and both partial-success and failed lead creation.

Review-fix validation: all 2,321 tests, frontend/backend type checks, production build, and whitespace checks passed. Local browser checks at 390px confirmed carrier/quote sorting, URL-backed account sorting, and no horizontal overflow; renewal links opened Quotes for a lead and Policies for a client. At 1280px, the mobile picker hid and desktop header sorting remained available.
