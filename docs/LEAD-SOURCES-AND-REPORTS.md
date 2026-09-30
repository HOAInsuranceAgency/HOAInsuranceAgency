# Lead sources, last contact, and report downloads

Lead-source implementation: September 10, 2026. Dashboard documentation updated September 30, 2026; the historical deployment record below describes the earlier release.

## Lead source

New lead creation requires exactly one of: Google Ad Website, Organic Website, Phone, Email, Meta Ad, or Property Manager. Account type (association, individual, or other commercial) remains separate.

The account overview displays the source as text. The generated Account API denies creation and denies changes to source, leadSource, and leadAttribution, including for administrators. New leads use the validated createLead or submitWebLead server handlers. An idempotent creation retry returns the existing lead without changing its source. Other account fields remain editable.

Existing records keep their original source. A historical website lead without campaign evidence appears as “Website · attribution not recorded” in the work list. Historical records are not silently labelled organic or paid.

All five website forms use the same attribution capture:

- Capture a tagged landing before the visitor navigates to a form. Retain it through navigation within that tab's browsing session; a new tagged campaign replaces it.
- Google Ad Website: gclid, gbraid, wbraid, or a Google paid UTM source/medium pair.
- Meta Ad: an explicit Meta/Facebook/Instagram paid UTM source/medium pair. A Facebook share identifier alone does not establish paid traffic.
- Organic Website: no recognized paid campaign marker was captured. This includes direct and untagged website traffic; it is not a claim that analytics proved an organic search visit.
- Store only the allowed campaign parameters and landing path, not full URLs or unrelated query parameters. Preserve click-ID case. The browser can still submit if storage is blocked, but cross-page attribution cannot then be guaranteed.

The server classifies the captured information at creation. Campaign evidence is retained separately from the existing website form/association lineage. The agent intake email and Front sidebar show the friendly source. Existing emails are unchanged.

Google documents [auto-tagging and GCLID](https://support.google.com/google-ads/answer/3095550?hl=en-au), [GBRAID/WBRAID measurement](https://support.google.com/analytics/answer/11367152?hl=en), and [manual UTM tagging](https://support.google.com/analytics/answer/11242870?hl=en). Ad links must retain these markers for automatic classification; untagged historical visits cannot be reconstructed reliably.

The additive website argument uses intake readiness contract 2. The website hosting build waits for the schema and handler to support it. Contract 1 remains supported for older clients.

## Last contact

Dashboard → Leads → Lead work list displays the latest recorded prospect email, call, or text in either direction, in the viewer's local time zone. The dashboard column is sortable and included in its download.

Internal notes, carrier conversations, automatic replies, unrelated/wrong-number calls, in-progress calls, and failed or queued messages do not move the date. Recorded missed/answered call activity and sent initial AI emails can count. Seen/read-receipt updates and team task changes never move the contact date or a commitment deadline.

The read uses the existing account history index, with bounded pages and current link checks; it works for previously linked history without a data migration. It returns only date, channel, and direction. The client follows remaining history pages and rejects repeated/incomplete cursors. “No contact recorded” means the search completed; read failures show “Unavailable” with a retry instruction. Choose a salesperson (including Unassigned) before viewing the work list. Its exports wait for this selection and for contact history to finish loading.

## Downloads

The admin-only Dashboard has three tabs and 16 Download controls. Former Overview, Reporting, and Renewals bookmarks land on Dashboard; renewal account work stays in Clients.

| Tab | Reports |
| --- | --- |
| Dashboard | Estimated commission per person; Quote win rate per person; Written premium by month; Premium by carrier; Commission by lead source; Commission by carrier |
| Leads | Open leads per person; Quotes in flight per person; New leads per person (30 days); Policies bound per person (30 days); Pipeline per person; Lead work list |
| Finance | Summary; A/R aging and open invoices; Interest income by salesperson (30 days); Premium finance portfolio |

Charts attribute records to the account's current salesperson, including inactive/former owners and an Unassigned bucket. Chart colors are consistent across views. Assignment reads and report reads succeed together, so unavailable assignments cannot masquerade as unassigned totals. Exact values are available in each chart's expandable table and download.

Dashboard date controls use policy/quote effective dates. Commission is premium × commission percentage; missing percentages are disclosed. Quote win rate is bound ÷ (bound + lost + declined); people without decisions show an explicit no-decisions state. The four money breakdowns stack by salesperson, retain historical/missing-date buckets for All time, and reconcile to the same policy scope.

Leads' recent charts use a rolling 30-day interval through refresh time, excluding future events. New leads include current leads and clients with a recorded conversion; direct/legacy clients without conversion history are not inferred. Binds use actual recorded policy bind timestamps, never effective dates. Quotes in flight exclude alternatives to a selected package. Open leads exclude lost, disqualified and bound dispositions; unfinished selected packages on converted clients remain in the pipeline/work list.

Finance separates billed, uncollected SENT/PROCESSING invoices from remaining non-billed financed principal. Financing installments post directly to loans, and future interest is excluded from A/R. Funded cancellations remain visible pending refund/reconciliation; cancelled unused offers do not count. Loans overlapping an open premium invoice or missing a reliable balance are excluded with an explicit incomplete-total warning and portfolio indication. Interest income uses actual posted payment interest, attributed to the account's current salesperson.

CSV spreadsheet downloads include all displayed report rows, their ordering, filter descriptions, snapshot time, time zone, and numeric amounts in USD. Multi-section reports contain a labelled table for each section. Empty results are explicit. Untrusted text is escaped for CSV and protected against spreadsheet formula execution.

Print / save PDF opens a separate, branded report with the same data. Click its Print / save PDF button and choose Save as PDF. The layout repeats table headers, paginates, and preserves Unicode names. Exports are disabled while refreshing, after a failed refresh, or for a reversed reporting date range.

## Dashboard read scope and deployment

All report-specific read operations require ADMIN in both the custom API access check and the communications handler. Attribution requests contain only account IDs contributing to the selected report. They return projected workflow ownership/disposition and account labels in batches of at most 500 IDs, with at most four client requests at a time. DynamoDB batches contain at most 100 keys and retry unprocessed keys; exhausted retries fail the snapshot rather than inventing Unassigned rows. The team roster is still loaded when the report has no records.

Leads query Account's stage index and read compact selected-quote membership from paginated COMMERCIAL_PLAN index results. Open quotes come from four status-index partitions, and recent binds come from a date index over the recorded bind timestamp. Compact quote histories are scoped to current LEAD accounts in batches of 25 account partitions; selected-package quote references use projected batch reads with explicit missing IDs. Full quote terms and package details are loaded only for the chosen salesperson's work list. Missing selected quotes continue to count as unfinished work. The work-list download waits for package details and contact history. The Dashboard's date controls scope policy/quote results and ownership joins; switching filters replaces the displayed snapshot immediately so the previous window cannot be downloaded under new labels.

Finance queries `dashboardPaymentsByDate` for the fixed 30-day interval, up to 500 receipts per page. The payment GSI uses existing `__typename` and `postedAt` attributes, so DynamoDB backfills historical payments without rewriting financial records. Leads adds one GSI on Quote status and one on Policy's existing bind date; every affected table gains only one report index and retains its existing relation indexes. The index must finish deployment before the report can load; an unavailable index produces a retryable error, never a full-history scan fallback. Only open invoices on accounts with outstanding financing load invoice-line anchors. These use parameterized PartiQL IN reads over the existing invoice partition index, with up to 25 invoice IDs and 500 evaluated lines per page; no per-invoice relation hydration remains. Account quote reads reuse the same bounded indexed-page helper, with 20 rows per page for full terms. Cursors bind to the query scope, all pages must complete, and IAM explicitly denies full-table PartiQL scans. Policy lookups are limited to those loans and bills; overlap matching indexes account and policy/quote anchors rather than comparing the whole loan and invoice books.

These changes remove full commercial hydration per account and full-history payment/line reads. They do not make every dashboard query constant-cost: the Performance tab's generated Policy/Quote lists and Finance's Invoice/PfLoan lists still scan their tables even when filtering projected results. Leads has no global Quote/Policy list calls. All-time production, Account stage queries, and selected-plan membership still grow with their relevant source books. A million-record deployment would need indexed source projections or maintained report aggregates before promising interactive full-book charts. Regression fixtures verify bounded owner and quote batches, no full quote hydration for 1,500 dormant clients, 251 invoice partitions read in 11 requests, selected-person detail loading, and non-quadratic matching across 2,000 unrelated loan/invoice accounts. A read-only staging check also verified a multi-account PartiQL query completes across three one-row pages using AWS continuation tokens.

Overview/Renewals retirement is intentional; the obsolete attention helpers and styles are removed. Renewal account work remains in Clients. Weekly marketing report delivery is unchanged.

## Staging acceptance walkthrough

1. Open Dashboard → Leads and choose a salesperson. Check the Last contact column for a lead with known email activity, then sort it. A lead with no captured communication should say No contact recorded.
2. Select New lead. Confirm the Lead source dropdown contains only the six choices. Creating without one should show an error. Create a clearly named test lead using Phone, then open its overview: Phone is visible and cannot be edited, while ordinary account fields still can.
3. Use a fresh browser tab with a test campaign landing such as `/?gclid=staging-test&utm_campaign=staging-source-test`, navigate to a form, and submit an explicitly labelled staging enquiry using an approved test recipient. Expect Google Ad Website in the work list, account overview, and new intake email. Use a separate fresh tab with no campaign parameters to check Organic Website. An explicitly tagged `/?utm_source=meta&utm_medium=paid_social` landing should create Meta Ad.
4. Visit each dashboard tab. Choose Download → CSV spreadsheet on a report and compare row counts and totals with the screen. On Dashboard, choose a custom range and toggle cancelled policies; downloads must follow those settings. On Leads, verify the work list is empty and its download disabled until a salesperson is selected. On Finance, compare billed aging, non-billed principal, posted interest, and the portfolio salesperson columns.
5. Choose Download → Print / save PDF. Check the branded report and use its print button to save a PDF. Long reports should retain all rows across pages.

Automated validation: 2,015 tests across 104 files, frontend/backend type checks, backend synthesis, CRM build, and website build (156 pages) passed before deployment. Live staging verification is recorded after the release.


## Historical live staging verification · September 10, 2026

Release `ca67c70` deployed successfully: CRM Amplify job 184 and website job 183.

- Chrome: Dashboard → Leads showed all 15 existing leads, readable historical source labels, last-contact dates, and explicit no-contact states. TEST Lead Brief 0910 showed September 10 at 8:47 AM.
- Lead follow-up → Waiting on prospect showed that same 8:47 AM contact and its unchanged September 14, 9:00 AM commitment.
- Browser-downloaded CSV contained exactly the 15 displayed rows, correct columns, filter/snapshot metadata, and the matching contact timestamp. Chrome saved the PDF successfully; its three pages included all rows and repeated column headers.
- New lead creation refused a missing source. Created TEST Source Lock 0910 (`b4b36240-1efd-4323-b39d-5f7284225156`) with Phone and Jake in both assignment roles. Its source is read-only in the overview; an ordinary note edit saved successfully. No prospect contact information was entered and this manual creation did not queue outreach.
- All five Reporting exports appeared in the live interface. Automated component tests exercise all 15 dashboard controls and check that the selected reporting window and cancelled-policy filter affect exported commission rows.
- Inspected the deployed AppSync account policy: acquisition fields are absent from user/admin update allowlists, with no admin bypass. Evaluated the deployed policy with Cognito mode simulated (the standalone evaluator otherwise reports API-key mode): ordinary name/notes allowed; changing or clearing leadSource, changing source, and changing leadAttribution denied. Direct generated Account creation was also denied for a simulated admin.
- Google/organic/Meta classification, cross-page capture, campaign replacement, and backend persistence were verified in automated tests. No additional prospect emails were sent to perform campaign attribution testing.
