# CRM UX audit — September 24, 2026

The CRM currently makes agents assemble a workflow from several lists, forms, and reporting screens. It has useful capabilities, but too much of its internal data structure is exposed in the everyday interface. A new agent must learn where information lives before they can confidently act.

The highest-value improvement is to organize the app around **what needs doing, for which account, by whom, and by when**. Account information should support that decision, with detailed editing available when needed. Smaller fonts, tighter spacing, tooltips, or a training tour would not resolve the main problems.

## Scope and evidence

- Audited the live production CRM at `app.protectmyhoa.com`, signed in as an administrator. Opened every standard routed page, all five dashboard views, all six Settings tabs, and every account tab across representative lead and client records. The coverage register below distinguishes live inspection from source review.
- Reviewed the corresponding frontend implementation at local main commit `ce2ef7861be14f4593ac49d3d278d515022d82a1`. This identifies the source baseline, not an independently verified production deployment hash.
- Examined populated, empty, loading, and selected edit/preview states. Opened editors and cancelled; did not submit forms, change CRM records/settings, generate documents, send communications, bind coverage, or perform financial transactions.
- Desktop inspection used a 1,728-pixel viewport. Sampled key workflows at 390 × 844, plus the account overview at 1,024 × 768. Restored the browser viewport afterward.
- Measurements below are actual DOM layout observations, not estimates from screenshots. Page heights describe the sampled records and can change with data. Counts are snapshots; for example, the dashboard showed 63–65 attention items during the audit.
- First-login onboarding, non-admin behavior, the populated embedded Front panel, and enabled Honeycomb submission states were reviewed in source where a suitable live session/state was unavailable. The signed-out login screen and the standalone Front empty state were inspected live. No email sign-in request was sent.

**Priority:** P1 = materially interferes with frequent work, learning, or reliable interaction; P2 = meaningful friction or confusion in a narrower workflow. The ordering within a priority reflects expected benefit to agents. These are UX priorities, not security incident classifications.

## Ranked list of the worst UX

| Rank / ID | Priority | Problem | Recommended outcome |
| --- | --- | --- | --- |
| 1 / UX-01 | P1 | Work is split between Dashboard, Leads, Lead follow-up, Tasks, Renewals, and account actions. | One daily work queue; Leads and Clients become account views with a clear purpose. |
| 2 / UX-02 | P1 | The account Overview is a long editing form; next actions are buried. | A concise account summary with next action, owner, contact, coverage, and outstanding needs first. |
| 3 / UX-03 | P1 | Follow-up and attention screens overwhelm users with differently scoped queues and repetitive items. | Explicit personal/team scope, grouped work, and a short prioritized first page. |
| 4 / UX-04 | P1 | The dashboard waits on broad data loads before showing anything useful. | Fast useful content, independent widget loading, and cached summaries. |
| 5 / UX-05 | P1 | Core lists require horizontal scrolling and prioritize secondary data. | A small set of useful default columns, saved views, and responsive account cards. |
| 6 / UX-06 | P1 | Editing, saving, formatting, and control styles vary across features. | One CRM component kit and one predictable editing contract. |
| 7 / UX-07 | P1 | Shared tables and many fields are not properly accessible by keyboard/assistive technology. | Real record links, keyboard sorting, associated labels, and consistent focus behavior. |
| 8 / UX-08 | P1 | Navigation does not preserve orientation; desktop sidebar cannot collapse. | Collapsible navigation, breadcrumbs, remembered list context, and fewer competing destinations. |
| 9 / UX-09 | P1 | Mobile reflows the shell but leaves wide tables and long workflows intact. | Mobile layouts for actual work, including readable summaries and reachable actions. |
| 10 / UX-10 | P1 | Quotes, packages, binding, and carrier submissions do not read as one process. | A clearly staged carrier-to-coverage workflow with one appropriate next action. |
| 11 / UX-11 | P2 | Documents combines file management, data review, and form generation. | A file library with separate, focused review and preparation workflows. |
| 12 / UX-12 | P2 | Activity is a raw database change log rather than an account story. | A business timeline, with detailed audit changes available on demand. |
| 13 / UX-13 | P2 | “Financing” leads to configuration rather than the portfolio; billing work is fragmented. | A billing workspace for balances and actions; administrative rules in Settings. |
| 14 / UX-14 | P2 | Carrier discovery and carrier maintenance are both form-heavy. | Account-aware market recommendations and concise carrier profiles. |
| 15 / UX-15 | P2 | Team setup repeats people across multiple tables and hides invitation below configuration. | One teammate list with focused access, assignment, and connection details. |
| 16 / UX-16 | P2 | Unknown, incomplete, and verified data are not consistently distinguished. | Honest totals, readiness states, and specific data-quality actions. |
| 17 / UX-17 | P2 | Lead creation asks for too much upfront and lands on Documents regardless of intent. | Minimal initial capture followed by an appropriate next step. |
| 18 / UX-18 | P2 | Search, quote/policy directories, and login recovery lack some expected shortcuts. | Consistent search/filter behavior, record-specific destinations, and clear recovery help. |

## Findings and concrete changes

### UX-01 — There is no single, obvious place to do today's work

**Observed:** The sidebar has both Leads and Lead follow-up. Follow-up opens a page titled “Work follow-up”; Tasks opens “Marketing tasks,” covering carrier deadlines rather than all tasks. Dashboard has another Leads view and another attention queue. Renewals and account workspaces introduce further work lists. Carrier work lives under an account's Quotes tab, while Submissions is specifically Honeycomb.

The issue is not simply that two tabs exist. An account directory and an action queue are both useful. Their purposes and scopes are currently difficult to infer from navigation.

**Change:** Make **My work** the normal agent landing page. Include leads, replies, carrier deadlines, renewals, and service work as filters over clearly defined actions. Keep **Accounts → Leads / Clients** for finding and reviewing records. Put manager reports behind a Reports destination or manager view. Preserve different action types and ownership rules underneath the unified presentation.

**Acceptance:** A new agent can find their next assigned action without deciding between three task-like destinations. An action has a named account, owner, reason, due time, and direct destination. Cross-links retain the same action identity and status.

### UX-02 — Account Overview starts with data entry instead of understanding

**Observed:** A sampled client Overview was **5,331 pixels tall** on desktop. It contained 89 visible account input/select/textarea controls across the page, excluding global search and controls inside closed disclosures. Details and Contacts appear before the client workspace. The “Next actions” heading began **1,478 pixels** down the desktop document and **2,594 pixels** down the phone document. The mobile page was **9,243 pixels tall**.

The first screen emphasizes legal name, FEIN, SIC, NAICS, entity type, revenue, and TIV. Those fields matter at particular stages; they do not answer an agent's first questions. Property, buildings, blankets, GL, D&O, and photos extend the same page, with multiple independent save areas.

**Change:** Start with a read-only summary: stage, accountable teammate, primary contact, next action, renewal/effective date, coverage summary, and important missing information. Show a short recent timeline. Move underwriting data into clearly named sections with an **Edit** action and progressive disclosure. Open add-contact/building/coverage forms only when requested. Tailor visible detail to account type and stage.

**Acceptance:** On a normal laptop and phone, the account's current situation and next action are visible before any long form. Opening an account requires no scrolling to determine who owns it and what to do next. Detailed fields remain discoverable within their domain.

### UX-03 — Attention is abundant but not sufficiently prioritized

**Observed:** “My work” reported no actions needing attention in the inspected admin view, while its adjacent daily report said **113 accounts / 739 actions** and included team and setup concerns. Those scopes can legitimately differ; the problem is that the relationship is not obvious. The personal view also displayed a long shared call/text linking queue despite the personal-work checkbox. Its copy calls the control “My leads,” while the checkbox says “My work.”

The daily report reached **46,194 pixels** on desktop and **67,321 pixels** on mobile, even with setup issues initially collapsed. The dashboard showed 63–65 attention items, including repeated-looking missed carrier submission windows. Tasks showed 77 carrier tasks. Several account actions had similar titles without enough policy/term identity to explain why they were separate.

**Change:** Use explicit **Mine / My team / All permitted work** scope. Show **Do now / Waiting / Scheduled** groups, with a bounded initial list and useful counts. Group related actions by account and term, while preserving distinct coverage requirements. Put shared assignment/linking maintenance in a separate, counted queue. Explain escalation ownership and scope in the interface, not a paragraph agents must remember. Investigate duplicate-looking records before either merging or suppressing work.

**Acceptance:** Users can explain why an item is in their queue. “Nothing due” cannot be visually contradicted by an unexplained wall of work beneath it. Counts identify their scope and include a breakdown. Old unresolved items remain accessible without dominating the landing page indefinitely.

### UX-04 — Loading blocks the dashboard's entire useful surface

**Observed:** Returning to Dashboard repeatedly showed only “Loading…” beneath the shell. Source confirms that Overview waits for **nine dataset loads**, each potentially paginated: lead accounts, client accounts, quotes, policies, marketing tasks, invoices, loans, failed documents, and licenses. The shared tab frame withholds the content until initial success. Account lists and search also load broad datasets to build their views.

This confirms a loading and architecture problem, but this audit did **not** establish a reliable p50/p95 timing benchmark or isolate network/backend latency.

**Change:** Fetch a small work summary first. Load independent cards separately, cache recently visited data, and keep previous results visible during refresh. Use server-side/indexed queries or maintained summaries for counts and work lists; request only needed fields. Defer finance/licensing/report data until relevant. Use skeletons that show the intended layout and local error/retry states. Preserve the dashboard's existing honest freshness stamp and retry behavior.

**Acceptance:** A slow or failed licensing/finance read does not prevent an agent seeing assigned work. Measure time to first useful content, query count, transferred data, and navigation-back latency before/after; use the proposed targets near the end of this report.

### UX-05 — Tables expose reporting schemas instead of useful working views

**Observed:** The Leads directory rendered **15 columns and 99 rows**, with a **2,049-pixel table inside a 1,392-pixel desktop container**. At phone width, the same table remained 2,049 pixels wide inside a 316-pixel container. The dashboard Leads view also has 15 columns. Lead source, website form, opportunity, commission, units, and TIV compete with the account identity. The directory lacks a primary next-action column. Clients is narrower but still emphasizes record attributes rather than service needs.

**Change:** Default to approximately five or six working columns: Account/contact, Stage, Next action, Owner, Due/renewal, and an optional important amount. Provide saved views, a column chooser, useful status/owner filters, result count, and pagination or bounded loading. Make secondary attribution and commission columns available in a reporting view. For genuinely wide analytical tables, pin identity and headers and make scrolling apparent. Use cards on phones for core agent workflows.

**Acceptance:** Common agent tasks require no horizontal scrolling at 1,280-pixel desktop width. Account identity and the next action remain together. Returning from an account preserves the user's filter, sort, and position.

### UX-06 — Users must learn a different editing contract on different screens

**Observed:** The app mixes always-open forms, inline editors, modal previews, immediate-save selects, explicit Save buttons, and several dropdown/button styles. Policy status changes persist directly from the table select; quote status also changes directly. Most account sections require Save. Carrier numeric fields display values such as `50000` while other money fields use commas. Label sizes and alignment differ between wrapped labels and older `.field` markup. Long pages have multiple unrelated save controls.

There are already useful shared primitives: formatted inputs, badges, Modal, SaveStatus, and form-state helpers. They are not applied as a complete page/form system. Source review found dirty-state support but no general route/tab guard against abandoning unsaved edits; losing a live draft was not deliberately tested.

**Change:** Extend the existing primitives into one kit. Use read-only summaries with section-level Edit, then a visible Save/Cancel area. Make saving/saved/failed/unsaved states consistent. Treat consequential status transitions as named actions with context and confirmation where needed, rather than a casual status dropdown. Use a single money/date/phone/percentage/number formatting policy, field spacing, select pattern, and validation pattern. Add protection for dirty forms when changing tabs/routes.

**Acceptance:** Every editable section has an evident save boundary. Users can predict whether a control change persists immediately. Policy cancellation and similar transitions show the record and intended result before saving. The same data type looks and behaves the same throughout the CRM.

### UX-07 — Shared accessibility gaps affect essential navigation and data entry

**Observed:** Leads/Clients, global Quotes/Policies, and account search results use clickable table rows with plain text rather than a real link in the identity cell. Shared `SortTh` renders a clickable `<th>` without a keyboard button or `aria-sort`. The login Email input is visually labelled but lacks a programmatically associated label. In the sampled New lead form, **15 of 18 visible form controls** lacked a programmatic label; global search is excluded from that count. Placeholder text in some fields is not a substitute for a persistent label.

**Change:** Make the account/record name an actual link; keep optional row-click convenience. Put a focusable button in sortable headers and expose sort state. Build labelled fields with stable IDs, descriptions, and error associations into the kit. Standardize focus indicators, modal focus management, and selected-tab semantics. Test core journeys using keyboard and a screen reader.

**Acceptance:** Users can open records and sort lists without a mouse. Every editable control has an accessible name. Validation moves or announces focus appropriately. This finding is based on DOM/accessibility-tree and source inspection, not a completed screen-reader conformance audit.

### UX-08 — Navigation wastes space and loses context

**Observed:** The desktop sidebar reserves 230 pixels and has no collapse control; the menu button is only shown below 800 pixels. At 1,024 pixels the full sidebar remains. Account pages have ten top-level tabs, no breadcrumb back to the originating list, and no active Leads/Clients parent item. Global Quotes/Policies are reached through dashboard tiles rather than a clearly explained navigation location. Sidebar agency identifiers occupy persistent space regardless of task.

**Change:** Add a remembered desktop collapse state with accessible icon labels/tooltips. Keep a mobile menu, with predictable close/focus behavior. Show breadcrumbs and a “Back to results” affordance. Consolidate account tabs into a few task-oriented groups, preserving linkable subviews. Move frequently copied agency identifiers into a compact utility panel or menu. Use the same names in navigation, page titles, and links.

**Acceptance:** Users can tell where they are and return to their previous working list in one action. The collapsed rail is usable by keyboard. Account sections fit a clear mobile section picker or equivalent compact navigation.

### UX-09 — Responsive CSS has not produced a responsive workflow

**Observed at 390 pixels:** The mobile menu opened and closed correctly and navigation collapsed it after a selection. New lead stacked without whole-page overflow, and the PDF preview fitted the viewport. Those are good foundations. However:

| Surface | Observed phone behavior |
| --- | --- |
| Leads | 2,049-pixel table in 316 pixels; most information/actions require sideways scrolling. |
| Account Overview | Ten tabs wrap to three rows (112 pixels); next actions begin 2,594 pixels down; page height 9,243 pixels. |
| Account Quotes | An empty package-options card fills most of the first screen; quote table is 721 pixels wide. |
| Account Documents | Document table is 1,365 pixels wide; AI review table is 746 pixels wide. The “Linked to” select is 486 pixels wide and expands the **whole page to 523 pixels**. |
| Search documents | Results table is 785 pixels wide in a 316-pixel container. |
| Settings Team | Two teammate tables are 872 and 950 pixels wide; invitation starts 1,631 pixels down. |
| Follow-up report | A long sequence of full work cards creates a 67,321-pixel document. |

**Change:** Design mobile account and work cards; put the next action first. Constrain select/input widths and allow long option text to truncate without widening the page. Use a compact account section picker, fewer default columns, and disclosure of secondary attributes. Prioritize contact, follow-up, document viewing, and quick status review on mobile; dense administration can use focused subpages.

**Acceptance:** No whole-page horizontal overflow on the core mobile routes at 390 pixels. Primary actions fit the viewport. A user can identify a lead's owner and next action without traversing a desktop table sideways. Validate on a real phone and with the on-screen keyboard, beyond the viewport checks in this audit.

### UX-10 — The quote-to-policy journey lacks a clear sequence

**Observed:** The Quotes tab starts with Package options, Estimated opportunity, and Pending commission even when no packages exist and actual quotes are already available. “+ Package option” precedes “+ New quote.” A quoted lead offers both **Bind** and **Request binding** alongside a status selector. Opening a new quote exposes a large coverage form with GL-specific fields before the user has established the relevant lines. Carrier marketing tasks sit below these sections.

The generic Submissions tab currently opens Honeycomb-specific content and a staging-only notice in production. The staging restriction is intentional and correct; its placement/name creates a production UX dead end. Source review of the enabled flow found useful estimate linking, review confirmation, queued/running status, portal handoff, and cautious unknown-result recovery.

**Change:** Present a visible sequence: **Prepare application → Approach markets → Compare quotes → Record client approval → Confirm carrier binding → Service policies**. Offer the next valid action for each record, with alternatives in a secondary menu. Start Quotes with received/in-progress quotes and requested coverages; introduce packages when comparison is relevant. Name the distinction between client approval and carrier-confirmed binding explicitly. Locate Honeycomb within carrier submissions, show availability intentionally, and retain estimate lineage without making users interpret raw IDs.

**Acceptance:** A new agent can explain what “Request binding” accomplishes before clicking it. The UI never implies that a website estimate or partial submission is bound coverage. Existing validation, review, authorization, and carrier-confirmation safeguards remain intact. Disabled production integrations do not look like a general-purpose workflow that is broken.

### UX-11 — Documents is three applications on one page

**Observed:** A client Documents tab contains 27 files, an expanded 19-row extraction review, and 17 form-generation choices on a roughly 5,040-pixel desktop page. Each file has a link selector and up to five adjacent text actions: Rename, Preview, Download, View text, Delete. “Linked to” acts as both a list filter and an upload destination; adjacent “Category” is upload metadata, not an equivalent filter. There is no local filename search. Fourteen of the 17 generation choices say “Mapping not built yet.”

**Change:** Default to a searchable file library with category/type/date filters, clear record association, Preview as the primary action, and a secondary actions menu. Give uploading its own short form. Offer **Review extracted information (N)** as a focused review flow with evidence and field groups. Move **Prepare application forms** into the submission workflow or a separate view; show ready forms first and place unavailable templates under an availability/help disclosure.

**Acceptance:** An agent can locate a specific document without scanning extraction fields or unavailable forms. Filtering cannot silently change the intended upload target. Human review and evidence remain part of applying extracted data.

### UX-12 — Activity reads like a developer audit log

**Observed:** One client Activity tab renders 189 changes across **17,168 pixels**, including raw CREATE/UPDATE operations, model names, IDs, and expanded before/after values. A lead with 54 changes still exceeded 10,000 pixels. Communication history and notes live elsewhere on Overview, so the agent must combine separate histories mentally.

**Change:** Make the default timeline describe business events: prospect contacted, documents received, application sent, quote received, approval recorded, policy bound. Group related updates from one operation. Add date/type/person filters and bounded loading. Keep the full technical audit trail behind “Change details” or a dedicated audit view.

**Acceptance:** Users can understand the last meaningful interaction and decision without reading database field diffs. Detailed accountability remains available.

### UX-13 — Financing has a misleading destination and fragmented context

**Observed:** Sidebar Financing opens a 51-jurisdiction configuration table with counsel opinions, rule notes, and a signed-file hash. The portfolio is instead under Dashboard → Finance, and an account has separate Invoices and Financing tabs. Configuration copy refers to an “account-independent Documents area,” but `/documents` now redirects to Search. An empty account financing state says to see Invoices without a direct action link. Active and cancelled loan rows have similar visual weight.

**Change:** Make the operational destination show balances, upcoming payments, invoices, and items requiring attention. Group invoices and loans under an account's Billing section with explicit subviews. Move jurisdiction/counsel setup into administrative Settings. On an account, show the applicable eligibility/result and a link to the explanation. Fix the outdated document-upload instruction. Put inactive loan history behind a filter/disclosure.

**Acceptance:** An agent who clicks Financing can find a loan and its next due item. A blocked financing offer names the specific next step or responsible role. This is an information-design recommendation; the audit does not assess the legal correctness of jurisdiction rules.

### UX-14 — Carrier pages expose maintenance before practical usefulness

**Observed:** Carriers opens with a nine-field appetite finder above a directory whose long state lists dominate rows. Carrier detail defaults to an editable appointment form with dozens of state checkboxes. Adding an appetite guide introduces another large form with states, thresholds, restrictions, and implementation explanations. Finding a market requires manually re-entering account risk attributes.

**Change:** Allow “Find markets for this account” with prefilled facts, a short list of likely matches, reasons, and unresolved eligibility questions. Default a carrier page to appointment status, relevant appetite, underwriter/contact actions, portal, and guidelines. Use “Edit appointment” and “Edit appetite” for maintenance, with searchable multi-selects or compact state summaries.

**Acceptance:** Agents can identify a relevant carrier/contact without scrolling through a state checklist. Do not present appetite matching as guaranteed underwriting acceptance.

### UX-15 — Team and administrative settings require too much interpretation

**Observed:** Team lists the same people across assignment eligibility, manager routing, and member access tables. Invitation appears below configuration. Access role, salesperson/champion eligibility, reporting coverage, Front/Dialpad identifiers, signatures, and SMS settings are distributed across the page. Settings defaults to form-template administration even for a user looking for personal settings. Licensing's map and coverage views use differing scope/denominator labels (47 of 51 versus 47 writable/3 gaps), which requires interpretation.

**Change:** Use one teammate list with a prominent Invite action. Open a person's details for **Access**, **Assignments**, **Connections**, and **Notifications**. Explain permissions separately from work responsibilities. Default personal settings to profile/signature, and group admin setup separately. Make licensing coverage denominators and treatment of DC/untracked jurisdictions explicit. Retain map summaries and gap-only filtering.

**Acceptance:** An admin can invite a teammate and see their readiness in one coherent place. An agent does not need to understand integration IDs to find their own settings.

### UX-16 — Missing information sometimes looks like a meaningful value

**Observed:** The Renewals view showed “$0 premium expiring” for 32 accounts while the sampled premium cells were unknown (`—`); its aggregate substitutes zero for missing premiums. Losses distinguishes “No losses recorded” in its empty copy, but the heading “0 losses” can still be mistaken for verified loss-free history. Templates marked Uploaded in Settings can remain unavailable for generation because mapping is incomplete. Repeated-looking buildings/losses/actions add noise; their underlying data provenance needs separate investigation.

**Change:** Distinguish **Unknown**, **Not applicable**, **Not yet reviewed**, **Confirmed none**, and actual zero. Show “Known premium: $X · Y of Z records complete.” For loss history, include requested/received/reviewed coverage period. Give templates a business readiness state rather than only a file-upload state. Provide a focused review queue for apparent duplicate/inconsistent data with evidence; do not silently merge it.

**Acceptance:** A missing value never becomes a reassuring zero total without a completeness qualifier. Users can tell whether a document/template/application is actually ready for its next step.

### UX-17 — Lead creation should capture an opportunity, not begin an underwriting questionnaire

**Observed:** New lead puts assignment controls first, followed by type, identity, source, contact, address, exposure, incumbent information, notes, and optional documents in one form. Desktop fields spread across many columns without strong grouping. On mobile, it becomes a 1,702-pixel page. Source confirms successful creation always goes to Documents, even when no document was attached. There is no explicit Cancel/back action in the form.

**Change:** Put prospect/account name, contact method, lead source, and sensible assignment defaults in the first section. Collapse optional property/incumbent details under “Add more information.” Validate source/contact data inline without removing required business attribution. After creation, show the account summary and suggested next action; offer review/extraction when documents were attached. Provide Cancel and preserve local draft work appropriately.

**Acceptance:** A typical new lead can be captured without completing optional underwriting fields or learning OCR terminology. The landing destination follows what the user just did.

### UX-18 — Recovery and retrieval need more obvious affordances

**Observed:** Global search has useful grouped suggestions and keyboard hints, but initially displays “Building the search index.” Its full results split accounts and documents, with long OCR snippets and no visible type/date refinement. Quotes offers In flight/All but no account/carrier/owner search; Policies has no similar active/history filter. Selecting a quote opens its account's whole Quotes tab rather than visibly selecting the quote. The sign-in screen is simple, but source has no request-in-progress state; the sent screen offers “Use a different email” rather than a direct resend/recovery route. No support/invitation guidance appears on the initial login screen.

**Change:** Reuse one searchable list pattern, remember view state, and land on the selected record. Label partial/indexing search states clearly and show ready results progressively. Add email-request progress and concise resend/check-spam/contact-admin guidance without revealing account existence. Preserve a return destination through sign-in. Keep first-run onboarding short and explain the initial work screen through its content, rather than relying on a long tour.

**Acceptance:** Searching a policy/quote leads to the intended item. Agents can recover from a missing/expired sign-in email without knowing the internal account provisioning process. Email delivery, expired-link recovery, and invitation were not exercised live in this audit.

## Page-by-page coverage register

“Live” means the page/state was opened and inspected in the signed-in admin session, unless stated otherwise. It does not mean every possible record, transaction, error branch, or role was tested. The register covers all routes defined in `App.tsx`, the separate Front route, auth gates, and their principal subviews.

| Page / view | Coverage | Main finding or disposition |
| --- | --- | --- |
| Sign in | Live signed-out screen; sent/error states in source | Simple entry point; label association and recovery/progress gaps (UX-07, 18). |
| First-login onboarding | Source only | Requires producer NPN/license setup; keep requirements but prefill known invite data and explain the next step (UX-18). |
| Shell / sidebar / global search | Live desktop and mobile | No desktop collapse, naming/context gaps; useful mobile menu and grouped search (UX-01, 07–09, 18). |
| Dashboard — Overview | Live desktop/mobile; loading observed | Broad blocking load; long attention queue (UX-03, 04). |
| Dashboard — Leads | Live desktop | Duplicates directory; 15-column work list and pipeline semantics need clarification (UX-01, 05). “Unworked” should not be inferred to mean never contacted merely because no quote exists. |
| Dashboard — Finance | Live desktop | Useful portfolio/aging summaries, but operational finance is hard to locate from sidebar (UX-13). |
| Dashboard — Renewals | Live desktop | Needs owner/work filters and honest unknown-premium totals (UX-01, 03, 16). |
| Dashboard — Reporting | Live desktop; period/filter controls reviewed | Better visual consolidation; locate manager reporting separately from daily agent work. Keep missing-commission caveats near the affected metric. |
| Leads directory | Live desktop/mobile | Wide table, secondary columns, no clear next action; inaccessible row navigation (UX-05, 07). |
| New lead | Live desktop/mobile; creation/conditional behavior in source | Long initial form and unconditional Documents destination (UX-17). No lead created. |
| Clients directory | Live desktop | More compact than Leads, but lacks a strong owner/next-service-action view; same row navigation issue (UX-05, 07). |
| Lead follow-up — My work | Live personal and team scopes, desktop/mobile | Empty personal queue followed by shared cleanup; mixed ownership (UX-01, 03). |
| Lead follow-up — Daily report & my team | Live desktop/mobile | Hundreds of actions and extensive scrolling; manager/setup scope competes with daily execution (UX-03). |
| Lead follow-up — Upcoming, All open, reminders | Source review of view/pagination/disclosure behavior | Reuse the same work model; preserve useful pagination and deferred reminders. Individual reminder completion was not exercised. |
| Tasks / Marketing tasks | Live desktop | Carrier tasks only under a general label; 77 rows, limited prioritization/filtering (UX-01, 03). |
| Account — Overview | Live lead and client; client desktop/tablet/mobile | Always-editable details bury the next action; many save boundaries (UX-02, 06, 09). |
| Account — Contacts, Property, Buildings, Blankets, GL, D&O, Photos | Live within Overview; source reviewed | Each is available but should be summary-first and edited independently on demand (UX-02). No records changed. |
| Account — Prior coverage | Live lead; client-tab rules in source | Add form precedes existing coverage; align naming (“prior carrier” versus coverage), preserve history across conversion. No data-loss claim (UX-02, 06). |
| Account — Losses | Live populated client and empty lead | Compact list is useful; add form should be secondary, and “none recorded” needs verification context (UX-16). |
| Account — Submissions | Live production lead/client; enabled staging states in source | Honeycomb-specific staging gate under a generic tab; preserve existing review/async/recovery patterns (UX-10). No carrier API call made. |
| Account — Quotes and website estimates | Live lead/client; estimate branches in source | Packages/commission precede quotes; clarify estimate versus quote versus policy (UX-10). |
| Account — New quote / package editor | Live opened and cancelled | Large forms and competing entry points; collect relevant coverages progressively (UX-06, 10). |
| Account — Request binding / Bind | Live affordances; transition forms/guards in source | Explain client authorization versus carrier confirmation; preserve safeguards (UX-10). Neither action submitted. |
| Account — Policies | Live client; transition behavior in source | 12-column table with immediate-save status select; use named status actions (UX-05, 06). |
| Account — Invoices | Live populated client, empty lead, existing invoice editor | Keep association-visible versus agency-only totals; group under Billing, improve policy identity in chooser (UX-13). Send/payment states not exercised. |
| Account — Financing | Live empty lead, client loan list, servicing panel | Clarify active versus historical loans and direct next steps; keep financial actions explicit (UX-13). No payment posted. |
| Account — Documents | Live lead/client, desktop/mobile, client PDF preview | Mixed file/filter/upload/extraction/generation responsibilities (UX-09, 11). |
| Account — AI extraction review | Live populated client and lead's empty extraction state | Evidence-based review is valuable; isolate it as a focused workflow (UX-11, 16). No extraction rerun or applied. |
| Account — Form generation | Live availability list; output behavior in source | 14 unavailable options overwhelm 3 usable ones; readiness labels need improvement (UX-11, 16). No form generated. |
| Account — Certificates | Live empty lead/client and client editor opened/cancelled | Lead state is a dead end; policy chooser needs carrier/term identity. “Record certificate” should explain generation and provide a review/preview step. No certificate issued. |
| Account — Activity | Live lead/client | Raw, unbounded database history rather than business timeline (UX-12). |
| Account — Lead deletion | Live affordance within Overview; source reviewed | Keep danger-zone separation and explicit confirmation. No destructive action tested. |
| Carriers directory / appetite finder | Live desktop | Long state lists and manual re-entry of account risk facts (UX-14). |
| Carrier detail / appointment / appetite guides / documents | Live Honeycomb record and appetite editor | Large default editing surface; needs a useful summary and focused maintenance (UX-14). |
| Global Quotes | Live In flight and All | Limited search/refinement, weak navigation context and record targeting (UX-18). |
| Global Policies | Live loaded directory | Active and cancelled records together without useful view controls; row navigation issue (UX-07, 18). |
| Global Search results | Live query with account/document matches, desktop/mobile | Useful cross-entity retrieval; filters, loading, and mobile result layout need work (UX-09, 18). |
| Legacy `/documents` | Live redirect | Redirect to Search works; financing instructions referring to an upload area are stale (UX-13). |
| Global Financing | Live desktop | Configuration and counsel rules occupy an operational destination (UX-13). |
| Settings — Form templates | Live desktop/mobile | Technical default; Uploaded does not mean ready to generate (UX-11, 15, 16). No template replaced. |
| Settings — My signature | Live | Focused task with clear draw/upload options; retain this simplicity. No signature changed. |
| Settings — Agency | Live | Small focused settings form; retain and align with shared edit/save conventions. |
| Settings — Team | Live desktop/mobile | Repeated teammate tables; invitation buried; clarify responsibility versus permission (UX-15). |
| Settings — Licensing / Map | Live, including state detail | Map is an effective summary; clarify scope and denominator (UX-15). |
| Settings — Licensing / Firm | Live | Long table; useful files/actions, would benefit from common list filters (UX-05). |
| Settings — Licensing / People | Live grouped view | Collapsed person groups reduce clutter; retain this approach. |
| Settings — Licensing / Coverage | Live gap view | Gap-only view is useful; align counts with map scope (UX-15, 16). |
| Settings — Front and Dialpad | Live summary, edit/cancel, advanced/queue disclosures | Strong summary-first/edit-on-demand pattern to reuse. Keep diagnostics/repair under Advanced. No connection test/repair/change performed. |
| Embedded `/front-sidebar` | Live standalone empty state; populated embedded flow in source | Compact next-action/disclosure structure is promising. Conversation context, linking, and draft handoff need separate embedded validation; no conversation/message action taken. |
| Unknown route / Not found | Live | Clear “Page not found” and Back to dashboard recovery; retain. |

## Suggested navigation and account structure

This is a proposed direction for a redesign, not an implemented change. Validate labels with agents before removing established links; redirect existing deep links rather than breaking them.

| Primary destination | What belongs here |
| --- | --- |
| My work | Assigned actions; team scope when permitted; due now, waiting, scheduled, renewals, carrier work. Default landing for agents. |
| Accounts | Leads and Clients as saved views, with a clear stage and next action. New lead is the primary creation action. |
| Carriers | Carrier directory, contacts, appointment/appetite summaries; account-aware market matching. |
| Billing | Invoices, receivables, loans, payment follow-up; operational information appropriate to role. |
| Reports | Agency pipeline, performance, finance, and exports; manager-focused. |
| Settings | Personal settings first; team, agency, licensing, templates, integration and financing configuration for the appropriate roles. |

Keep global Search available. Quotes and Policies can be searchable saved views within Accounts rather than adding more permanent sidebar entries.

An account can start with approximately six sections: **Summary**, **Coverage & markets**, **Documents**, **Billing**, **Timeline**, and **Account details**. Coverage & markets contains prior/current coverage, submissions, quotes/packages, and certificate tasks at the appropriate stage. Account details contains contacts, property, buildings, and underwriting information. Use explicit subviews and deep links; consolidation must not turn into one huge replacement tab.

## The CRM kit to establish

Build on existing components instead of introducing another competing design system. Establish a small reference page showing every supported variant, then migrate screens to those components.

| Shared pattern | Required behavior |
| --- | --- |
| App shell and page header | Collapsible rail, mobile navigation, breadcrumb/back-to-results, page title, one primary action, secondary menu. |
| Account/work summary | Stage/status, owner, next action, due date, contact and important exceptions; readable before opening forms. |
| Summary card / detail list | Read-only default, consistent missing-value presentation, section-level Edit, concise relevant facts. |
| Form section | Associated labels, help/error text, required/optional markers, consistent field widths, responsive grouping, visible Save/Cancel and dirty-state handling. |
| Inputs and selects | Shared money with commas, integers, percentages, dates, phone/email, text, searchable selects, multi-selects and checkboxes. No raw uppercase backend enums in normal user copy. |
| Data list | Real links, keyboard sorting, clear filters/result count, useful saved defaults, pagination, retained view state, optional columns, phone cards where appropriate. |
| Actions and status | Predictable primary/secondary/destructive hierarchy; status badges distinct from actions; meaningful progress, confirmation, success and failure messages near the action. |
| Loading / empty / error | Stable layout, progressive loading, actionable empty states, local retry, last-updated indicator, honest partial-data status. |
| Modal / drawer / preview | Consistent title/actions/close, constrained mobile width, keyboard focus and Escape behavior; use a full page for large workflows. |
| Timeline / review | Human-readable events, grouped updates, progressive disclosure of evidence/raw changes; review remains explicit. |

## Implementation sequence

1. **Agree on the work model and build the shared foundations.** Define what counts as a task, whose queue it belongs in, and where its action leads. Build the labelled field, list, page header, summary, save, and responsive shell patterns. Address dashboard fetching/loading in parallel; do not postpone speed until after visual redesign.
2. **Fix the three most-used surfaces.** Deliver My work, the simpler Leads/Clients views, and summary-first account pages. Add desktop collapse, back-to-results behavior, keyboard record links, and mobile work/account cards. This should produce the largest reduction in training.
3. **Make the end-to-end sales/service flow clear.** Unify carrier work, estimates/submissions, quotes, packages, approval and binding presentation. Separate document library/review/application preparation. Introduce business Timeline and coherent Billing subviews.
4. **Finish administrative consistency and verification.** Simplify carriers, team setup, templates/licensing, search/directories and login recovery. Remove superseded UI paths only after links and role-based behavior are verified. Apply the kit across remaining screens.

Do not treat this as a request to remove necessary underwriting information or safeguards. The goal is to reveal information when it supports the user's decision and keep the full record accessible.

## Acceptance checks for a simpler CRM

These are proposed targets for the redesign, not results already achieved:

- A newly invited agent can identify their next assigned action within 10 seconds of reaching the home screen, without a walkthrough.
- From an account, the agent can identify the primary contact, owner, current stage, and next action on the first screen, and reach the appropriate workflow within two deliberate actions.
- Core working lists do not require horizontal scrolling at 1,280 pixels; core phone workflows have no whole-page overflow at 390 pixels. Detailed analytical tables can be an explicit exception with pinned identity and clear scrolling.
- Common record navigation, sorting, editing, cancellation and error recovery work with keyboard alone. Fields have accessible names and errors. Validate with a screen reader as well as automated checks.
- Set and measure a performance budget: proposed p95 of two seconds to first useful work content under an agreed normal connection, and under one second for cached return navigation. Track initial and refreshed data separately. Loading placeholders alone do not count as useful content.
- Every work count declares its scope. Unknown/incomplete data never silently reads as zero or verified complete. Opening an item takes users to that item's context rather than a broad list they must search again.
- Every editing flow has clear saving/error/success feedback and predictable handling of an unsaved departure. Important status changes identify their consequences before persistence.
- Test five unaided journeys with agents: respond to a new lead; prepare/send a carrier submission; record a received quote and obtain approval; find a policy/document and prepare a certificate; identify a renewal or payment needing action. Record hesitation, wrong turns, completion and recovery, then adjust the design.

## Source evidence index

These anchors explain the main structural findings and give implementation starting points. Live observations above are independent evidence; source-only behavior is explicitly identified in the report.

| Finding | Source |
| --- | --- |
| Route inventory, navigation and Front branch | [App.tsx](/Users/jake/Repos/HOAInsuranceAgency/crm/src/App.tsx:310) |
| Fixed desktop rail, mobile-only hamburger, wrapping tabs | [styles.css](/Users/jake/Repos/HOAInsuranceAgency/crm/src/styles.css:47) |
| Nine dashboard dataset loads | [OverviewTab.tsx](/Users/jake/Repos/HOAInsuranceAgency/crm/src/pages/dashboard/OverviewTab.tsx:61) |
| Initial dashboard content gate and retained refresh data | [dashboard/common.tsx](/Users/jake/Repos/HOAInsuranceAgency/crm/src/pages/dashboard/common.tsx:90) |
| Work-list scopes and shared queue | [LeadWork.tsx](/Users/jake/Repos/HOAInsuranceAgency/crm/src/pages/LeadWork.tsx:16), [LeadWorkExtras.tsx](/Users/jake/Repos/HOAInsuranceAgency/crm/src/components/LeadWorkExtras.tsx:13) |
| Daily report's full list of work cards | [MorningWorkReport.tsx](/Users/jake/Repos/HOAInsuranceAgency/crm/src/components/MorningWorkReport.tsx:19) |
| Lead columns and clickable rows | [AccountsList.tsx](/Users/jake/Repos/HOAInsuranceAgency/crm/src/pages/AccountsList.tsx:182) |
| Account layout order and tab contents | [AccountDetail.tsx](/Users/jake/Repos/HOAInsuranceAgency/crm/src/pages/AccountDetail.tsx:236) |
| Sorting accessibility | [useSort.tsx](/Users/jake/Repos/HOAInsuranceAgency/crm/src/lib/useSort.tsx:63) |
| Quote packages before quotes; Bind/Request binding | [QuotesPanel.tsx](/Users/jake/Repos/HOAInsuranceAgency/crm/src/components/QuotesPanel.tsx:152) |
| Immediate policy-status persistence | [PoliciesTab.tsx](/Users/jake/Repos/HOAInsuranceAgency/crm/src/pages/account/PoliciesTab.tsx:163) |
| Staging restriction, estimate linking, pending and recovery states | [SubmissionsPanel.tsx](/Users/jake/Repos/HOAInsuranceAgency/crm/src/components/SubmissionsPanel.tsx:44) |
| Combined document filtering/upload controls | [DocumentsPanel.tsx](/Users/jake/Repos/HOAInsuranceAgency/crm/src/components/DocumentsPanel.tsx:372) |
| Raw account audit history | [ActivityTab.tsx](/Users/jake/Repos/HOAInsuranceAgency/crm/src/pages/account/ActivityTab.tsx:133) |
| Financing configuration and obsolete Documents instruction | [Financing.tsx](/Users/jake/Repos/HOAInsuranceAgency/crm/src/pages/Financing.tsx:84) |
| Missing-premium aggregation | [RenewalsTab.tsx](/Users/jake/Repos/HOAInsuranceAgency/crm/src/pages/dashboard/RenewalsTab.tsx:171) |
| Default Settings tab and admin visibility | [Settings.tsx](/Users/jake/Repos/HOAInsuranceAgency/crm/src/pages/Settings.tsx:33) |
| New-lead destination and initial form | [NewLead.tsx](/Users/jake/Repos/HOAInsuranceAgency/crm/src/pages/NewLead.tsx:185) |
| Shared form state and input foundations | [useFormState.ts](/Users/jake/Repos/HOAInsuranceAgency/crm/src/lib/useFormState.ts:1), [inputs/index.tsx](/Users/jake/Repos/HOAInsuranceAgency/crm/src/components/inputs/index.tsx:1) |
| Sign-in request/recovery and onboarding | [MagicLinkSignIn.tsx](/Users/jake/Repos/HOAInsuranceAgency/crm/src/components/MagicLinkSignIn.tsx:78), [Onboarding.tsx](/Users/jake/Repos/HOAInsuranceAgency/crm/src/pages/Onboarding.tsx:122) |
| Search index data requirements | [searchIndexData.ts](/Users/jake/Repos/HOAInsuranceAgency/crm/src/lib/searchIndexData.ts:19) |
| Embedded CRM context and disclosures | [FrontSidebar.tsx](/Users/jake/Repos/HOAInsuranceAgency/crm/src/pages/FrontSidebar.tsx:8) |

## Remaining validation boundaries

This is a broad heuristic and live interaction audit, not an exhaustive test of every record or a user study. Separate Producer/Staff sessions, commercial/personal record variants, live first-time onboarding, enabled staging Honeycomb flows, populated Front embedding, document-generation outputs, email delivery, binding, payment operations, deliberately induced network failures, and real-device/screen-reader testing remain follow-up validation. No claim is made that those unexecuted paths passed. The audit identifies the structural UX work before implementation; it does not change the CRM.
