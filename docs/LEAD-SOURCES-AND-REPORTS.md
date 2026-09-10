# Lead sources, last contact, and report downloads

Implemented September 10, 2026. Staging release; production is unchanged.

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

Dashboard → Leads → Lead work list and Lead follow-up display the latest recorded prospect email, call, or text in either direction, in the viewer's local time zone. The dashboard column is sortable and included in its download.

Internal notes, carrier conversations, automatic replies, unrelated/wrong-number calls, in-progress calls, and failed or queued messages do not move the date. Recorded missed/answered call activity and sent initial AI emails can count. Seen/read-receipt updates and team task changes never move the contact date or a commitment deadline.

The read uses the existing account history index, with bounded pages and current link checks; it works for previously linked history without a data migration. It returns only date, channel, and direction. The client follows remaining history pages and rejects repeated/incomplete cursors. “No contact recorded” means the search completed; read failures show “Unavailable” with a retry instruction. Lead-work exports wait for contact history to finish loading.

## Downloads

Each of the 15 dashboard reports has a Download control:

| Tab | Reports |
| --- | --- |
| Overview | Summary; Needs attention |
| Leads | Summary; Pipeline; Lead work list |
| Finance | Summary; Invoice aging and open invoices; Premium finance portfolio; In motion |
| Renewals | Upcoming renewals |
| Reporting | Production/income summary; Written premium by month; Premium by carrier; Commission by source; Commission by carrier |

CSV spreadsheet downloads include all displayed report rows, their ordering, filter descriptions, snapshot time, time zone, and numeric amounts in USD. Multi-section reports contain a labelled table for each section. Empty results are explicit. Untrusted text is escaped for CSV and protected against spreadsheet formula execution.

Print / save PDF opens a separate, branded report with the same data. Click its Print / save PDF button and choose Save as PDF. The layout repeats table headers, paginates, and preserves Unicode names. Exports are disabled while refreshing, after a failed refresh, or for a reversed reporting date range.

## Staging acceptance walkthrough

1. Open Dashboard → Leads. Check the Last contact column for a lead with known email activity, then sort it. A lead with no captured communication should say No contact recorded. Open Lead follow-up and check the same lead's date.
2. Select New lead. Confirm the Lead source dropdown contains only the six choices. Creating without one should show an error. Create a clearly named test lead using Phone, then open its overview: Phone is visible and cannot be edited, while ordinary account fields still can.
3. Use a fresh browser tab with a test campaign landing such as `/?gclid=staging-test&utm_campaign=staging-source-test`, navigate to a form, and submit an explicitly labelled staging enquiry using an approved test recipient. Expect Google Ad Website in the work list, account overview, and new intake email. Use a separate fresh tab with no campaign parameters to check Organic Website. An explicitly tagged `/?utm_source=meta&utm_medium=paid_social` landing should create Meta Ad.
4. Visit each dashboard tab. Choose Download → CSV spreadsheet on a report and compare row counts and totals with the screen. On Reporting, choose a custom range and toggle cancelled policies; downloads must follow those settings. On Renewals, switch between Overdue and 30/60/90 days and compare the exported rows.
5. Choose Download → Print / save PDF. Check the branded report and use its print button to save a PDF. Long reports should retain all rows across pages.

Automated validation: 2,015 tests across 104 files, frontend/backend type checks, backend synthesis, CRM build, and website build (156 pages) passed before deployment. Live staging verification is recorded after the release.
