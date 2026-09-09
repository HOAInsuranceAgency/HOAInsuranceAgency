# Front, Dialpad and CRM rollout

Implementation is in the repository. Deployment, credentials, tenant configuration and real-provider acceptance have **not** been performed by this change. Do not confuse passing repository checks with a connected production integration.

## Operating behavior

- Website enquiries are captured once, together with their original answers, Brian's two responsibilities, the pending Front import and team SMS alert. An unchanged browser retry uses the same submission ID, retry proof and answers to retrieve its receipt, including after reload. Corrected answers receive a new submission identity; a previous attempt whose response was lost may already have arrived. Cached older forms without an identity remain accepted during cutover, but cannot receive retry deduplication. A storage failure does not show a success screen.
- Front imports the labelled website submission. After the existing document/upload window, the AI producer queues a reply as Brian Cole through the shared sales channel, using that exact conversation. There is no email provider selector and no SES fallback for this flow.
- Front acceptance is pending delivery. The worker resolves the returned message UID to a message and conversation before recording SENT and scheduling follow-up. An ambiguous outbound result is held for review, without an automatic resend.
- Brian is the default salesperson and deal champion. Team settings control dropdown eligibility independently of Cognito access. Explicit reassignment preserves deadlines. Large accounts apply notification and Front-routing changes through durable batches of 25 records after committing the two duties. A unavailable or unconfigured default leaves a visible assignment exception.
- Ordinary no-reply follow-up is 9 a.m. Eastern on the second business date after confirmed outbound email; escalation is 9 a.m. the next business date. Inbound response and callbacks use eight staffed hours, 9–5 Eastern, Monday–Friday excluding the configured holidays. Custom promises require a reason and a future date and survive later messages. A late-linked request retains its original deadline; if its escalation deadline has already passed, the salesperson and champion are informed together, using one escalated notice when they are the same person.
- CRM tasks and notifications remain authoritative when any Front user snoozes, archives, marks read or changes the handler. Due work reopens its linked conversation. Cleanup checks current activity, ownership, commitments, delivery uncertainty and synchronization health before archiving.
- Dialpad is authoritative for calls and texts. Front's native integration remains the human calling/texting interface. Calls and SMS conversations stay separate from email. Explicit activity links unify their CRM history without manufacturing duplicate Front messages.
- The main and individual business lines are monitored. New prospect text drafts use the shared **(508) 233-2261** channel and require a person to send in Front. Delivered SMS and connected calls do not prove that a request was resolved.
- Unknown callers/texts enter triage; a phone-number match alone never chooses an HOA. Staff can link one activity, combine selected requests with the earliest deadline, and confirm a call outcome with the applicable next action. Carrier requests remain separate from prospect response work.

## Deployment order

Use an isolated staging backend, Front inbox/channel and controlled contacts first. Intake identity arguments are additive and optional at the schema boundary, so cached older forms remain accepted. The new website always supplies them. Do not make them required until old clients have been retired.

1. Run CRM tests, frontend/backend type checks, both application builds and `synth:check`.
2. Deploy the CRM backend and frontend to staging. The integration initially pauses delivery. New enquiries remain durably captured while setup is incomplete; their queued delivery is visible.
3. Set the staging website's existing `PUBLIC_CRM_API_URL` and `PUBLIC_CRM_API_KEY` to that staging backend, and deploy the website. Disable staging analytics using the existing setting. Front/Dialpad secrets never belong in website variables.
4. Configure the integration and run the controlled tests below. Complete tests before enabling cleanup.
5. Production may start both application builds from one push. The website build now performs a skipped GraphQL mutation that validates the new contract without executing intake, then calls the non-writing `leadIntakeReady(readinessContract: 1)` query (dispatch uses the argument because Amplify does not supply `event.info`) that checks the new handler version and its communication-table access. It waits up to 20 minutes for the CRM schema; if the backend is unavailable or incompatible, the website build fails and the existing deployed website remains live. Fix/retry the CRM build, then rerun the website build. Monitor legacy FormSubmit conversations from cached pages during cutover. Historical initial replies are held as described below. Only activate after the production channel and sender are validated.

Infrastructure additions: one server-only DynamoDB table with kind/account/due/open-work indexes, a Secrets Manager secret, custom authenticated read/write resolvers, a signed public webhook receiver, and a scheduled delivery/reconciliation worker. The Account stream initializes responsibility state for other existing lead-creation paths. Public lead-intake requests receive an AWS WAF IP rate limit; sampled request bodies are disabled. These resources add normal AWS usage charges. Existing non-lead mail flows keep their existing transport.

`customHttp.yml` allows the `/front-sidebar` route to be embedded by Front, disables caching for that page and sends no referrer. Check actual staging response headers, including any console-configured `X-Frame-Options`, before installing the sidebar. Other CRM authorization rules remain in effect.

## Admin setup

### Team

In **Settings → Team**, enable both salesperson and deal-champion eligibility for Brian Cole. Map each teammate to their real Front teammate ID (`tea_…`) and Dialpad user ID. These fields do not alter roles, groups, visibility or permissions. In **Settings → Integrations**, select Brian as the default for both duties.

### Front

Create a private developer application for this CRM integration in the intended Front company. Save its application signing key and the appropriately scoped API token in the secure credential fields in Integration settings. Tokens are stored only in Secrets Manager; the UI receives presence indicators, never saved secret values.

Configure:

- Company ID from Front's `/me` response.
- Shared Sales inbox and its actual email channel. Production sends as `sales@protectmyhoa.com`; staging cannot use that production sender and also enforces a recipient allowlist.
- Enable **Track sent emails** on that shared sales channel, and verify a Seen signal using a controlled test recipient. API delivery alone does not prove tracking is enabled.
- Additional inboxes to include in CRM scope.
- Separate native Dialpad voice and shared-line SMS channels, with the shared text channel mapped in settings.

The Integration screen displays the deployed webhook and sidebar URLs. Register the `/front` webhook as an **application webhook**, with inbound/outbound messages, delivery failure, assignment and conversation state events. The receiver validates Front's timestamp and HMAC, checks the company ID, and answers the signed challenge. It stores each ordinary event before acknowledging it.

Install the sidebar at the displayed `/front-sidebar` URL. Users sign in with their existing CRM identity. If Front's embedded browser has separate storage, request a CRM sign-in email and copy its unopened sign-in link into the sidebar's private link field. No Front identity or teammate mapping substitutes for CRM authentication.

Read-only connection checks establish API access and channel identity. They do not send a customer message. The final activation action also requires recent signed test events and the admin's confirmation of native channel tests.

### Dialpad

Use an API identity with company access covering the intended office, main line and individual business numbers. Enter the real company/office IDs and normalized business numbers. The screenshots establish the main line and Connect Pro subscription; they do not supply all individual numbers or prove API scopes.

Register the displayed `/dialpad` URL as a Dialpad webhook with a dedicated signing secret saved in CRM settings. Configure call and SMS subscriptions for the intended office/users; avoid subscribing staging to all production calls. Include the relevant connected, hangup, voicemail and available enrichment events. Request SMS delivery status events. SMS body export requires the applicable `message_content_export` or `message_content_export:all` permission. Call reconciliation requires `calls:list` and coverage beyond the token owner's personal history.

Subscription creation is a tenant setup step: use Dialpad's administration/API tooling to create the webhook and scoped call/SMS subscriptions. The CRM does not change routing, recording policies or number assignments. Keep provider subscription IDs in the deployment record alongside the tested numbers.

Verify native shared-line SMS send/receive and all individual voice lines. Front's app-store Enabled label alone does not establish these connections. Individual-number SMS uses Dialpad event capture where authorized; the implementation does not promise native Front SMS channels for those personal numbers.

After controlled signed events arrive, select **Validate and activate**. Activation records the capture starting point. Changing channel/line mappings or rotating credentials pauses delivery until revalidation. Changing companies after activation requires a separate migration of stored links.

## Daily use and recovery

**Lead follow-up** contains response, due/overdue, waiting, champion, assignment, communication issue, unlinked activity, notification, delivery and event views. Views query an index of actionable records and fill pages with matching work on the server, including the selected view and My leads filter. Each request searches up to eight source pages. If more records remain, an empty result explicitly offers Continue searching; it does not claim there is no work. Dates use Eastern time. There is no global communication-body export through the work endpoint.

Use the account panel or Front sidebar to assign the two duties, make dated commitments, record a result, add internal notes, and explicitly link activity. Complete a prospect task together with its successor/waiting commitment or a lost/disqualified outcome. Binding continues through the existing quote/bind flow. Reopen lost/disqualified leads with a dated next action; do not trigger another initial AI email.

When several messages/calls concern the same request, select the response/callback tasks and use **Combine and keep the earliest deadline**. This is an explicit association decision, not a phone-number inference. Unrelated requests remain open.

Responsibility changes, promises, outcomes and conversation links write atomically into the existing CRM Activity timeline. Internal notes can be queued as Front comments. An attachment is copied only when a person selects **Save to CRM documents**; that explicit import enters the existing document/OCR workflow. It does not submit an application to a carrier. The source message and attachment IDs prevent repeated saves from making duplicate documents. Files over 25 MB, failed downloads or an unsupported download host are rejected before a new document is created and produce a visible issue; open Front to handle those files manually.

### Failed or uncertain delivery

- **RETRY_WAIT:** wait for configuration, the provider's retry window or a safe retry. Website capture has already succeeded.
- **ACCEPTED:** Front supplied a UID; the worker is still resolving the final message. This is not SENT.
- **UNKNOWN:** the external send may have happened but its result was not saved. The worker will not resend it.
- **FAILED:** the provider or validation rejected the operation. The issue remains visible for review.

An admin can inspect Front, enter a verified message UID to reconcile delivery, cancel the queued operation, or explicitly confirm that the source did not send before retrying. The review requires notes and an expected record version. A customer-send timeout never falls back to SES. Team SNS alerts also hold partial/ambiguous failures for review rather than duplicating successful alerts.

Cancelling the pending AI reply sets human takeover. If the operation is already dispatched/accepted or uncertain, the UI explains that this does **not** recall it. Simultaneous native human sending and an API dispatch cannot be globally locked across Front and the CRM.

### Processing and sync gaps

Signed receipts are durably saved and replayable. Versioned writes and stable provider IDs make repeated events safe. A webhook acknowledges a failed write only if a consistent read verifies that the exact event already exists. Transaction throttles and transaction conflicts are not treated as duplicate receipts. Call legs are aggregated into one customer call; a missed call is rechecked against concluded call details before callback work is projected. One answering agent prevents the other ringing agents from creating separate missed-call tasks.

The worker checks incremental Front inbox history with a six-hour overlap and Dialpad concluded call history with a 24-hour overlap, starting at activation. Checkpoints advance only after the page has been processed or durably queued. Dialpad overlap deduplicates by call ID and a canonical hash of its provider snapshot, so unchanged calls do not create new events on every tick; changed details still enrich the call. Repeated missed-call snapshots do not rearm concluded-call lookups. Transfer master IDs take precedence over entry-point/operator IDs; conflicting relationships are held for review. Excluded business-line events retain an explicit scope reason. Pagination and work per run are bounded. Front rate headers and retry windows are shared across workers; optional Seen/search requests leave capacity for sends.

A worker interruption creates a sync-gap issue that prevents cleanup until reviewed. Inspect the saved events, delivery queue, provider webhook state and the affected interval. Repair credentials/scopes, then replay failed saved events from the event view. Front 401/403 failures retain pending delivery and raise an authorization issue, so token repair does not require retrying every email manually. Team tasks remain scheduled regardless of the number of processing failures; rate-limit waits do not consume their failure count, and successful dispatch resets it. Review and resolve the synchronization issue after repair. Front may disable an application webhook after repeated failures; update/reverify it in Front after fixing the receiver.

Do not assume historical SMS can be recovered from an undocumented API. Review Dialpad/Front native history for an SMS gap, explicitly restore the affected activity/tasks, and document the reconciliation before clearing the gap issue. Available recording/transcript/recap events enrich the call without moving its deadline; missing AI/media features do not block the base call record.

Seen is cached separately from confirmed delivery. The worker supports numeric/string second or millisecond timestamps, records check time and failures, and stops scheduled checking after a substantive reply, terminal outcome or fourteen days. A missing Seen signal is not labelled unread. Neither an open signal nor SMS delivery proves a human read the message.

**Refresh Seen status** queues a rate-limited check of a selected sent email, including older messages. It does not change any follow-up date or send another email. A verified Front conversation merge updates the canonical link when resolving delivery; a merge across different CRM leads requires review.

### Existing leads and legacy replies

Use **Fill missing lead responsibilities** in batches to apply Brian defaults without overwriting existing assignments or dates. Link existing Front conversations explicitly; this queues a paginated backfill of messages from the activation window and repairs account links for previously unlinked messages. Do not merge every historic message from a shared property-manager address.

The cutover does not replay historical initial emails. Old pending replies without a new submission identity, and old SENDING rows without a Front-generation claim, are held for migration review. Inspect their previous AWS/Front history before any human contact. New generation crashes can recover their durable outbox operation; old ambiguous AWS sends cannot safely be treated as unsent.

Do not bulk-remove Jake's legacy subscriptions or snoozes until ownership, next actions and shared/personal Front views have been verified. Front's personal and shared status behavior must be tested separately.

## Controlled live acceptance record

Record the environment, company/channel IDs, test recipient/number, timestamp, CRM account/task IDs, Front message UID/message/conversation IDs and Dialpad call/message IDs for each scenario. Do not put secrets or bearer upload links in this record.

| Check | Expected result |
| --- | --- |
| Each of the five website forms | All answers captured; one lead, one labelled Front import, one AI reply in the same conversation; uploads still work |
| Repeated submission / interrupted request | Same lead and upload receipt; no second intake, initial email or team alert |
| Front paused or unavailable | Website capture succeeds; delivery stays pending and visible |
| Brian defaults and role changes | Both initial duties Brian; eligible dropdowns; unchanged CRM access and original deadlines |
| Reply, auto-reply and repeated inbound | Substantive response deadline from first unanswered message; auto-replies do not clear waiting work |
| Personal/shared snooze and archive | CRM deadlines unchanged; due work surfaces; no claim that every personal inbox copy was cleared |
| Same-role reminder/escalation | One task and notification for Brian, updated to escalated urgency |
| Main line / each individual number | Correct real line and actor; one call activity across transfers and rings |
| One agent misses, another answers | One answered call, no spurious callback for the missed agent leg |
| Shared-line text / individual-number inbound text | Correct shared sender; received body and final delivery states where scoped; no duplicate CRM activity |
| Property manager with several associations | Explicit lead selection; one activity can be linked without assigning all phone history |
| Missed call, later voicemail/recap | One callback from original event time; late enrichment does not restart it |
| No answer / human-confirmed resolution | Attempt preserves commitment; resolution completes only selected work and saves a successor |
| Forged event / duplicate / wrong company | Rejected or deduplicated; no unauthorized timeline, send or task change |
| Lost send response | UNKNOWN or UID reconciliation; no automatic second customer send |
| Sidebar context switch | No stale search, draft or edit applied to the newly selected conversation |
| Attachment import | One existing-workflow document; source checked; credentials and public recording links absent |
| Binding / lost / reopen | Existing validated bind remains authoritative; obsolete tasks close; reopening saves a plan |
| Webhook interruption / throttling | Visible gap/backlog; scoped replay; original deadlines; cleanup held during uncertainty |

Repository tests use controlled fixtures, not the company's live provider accounts. Tenant-level behavior, transfer payloads, the actual shared text channel, attachment download hosts, Seen availability and header/iframe behavior remain live acceptance prerequisites.

## API references

Implementation choices were checked against Front's [import](https://dev.frontapp.com/reference/import-inbox-message), [reply](https://dev.frontapp.com/reference/create-message-reply), [application webhook](https://dev.frontapp.com/docs/application-webhooks), [Seen](https://dev.frontapp.com/reference/get-message-seen-status), [rate limit](https://dev.frontapp.com/docs/rate-limiting) and [search](https://dev.frontapp.com/reference/search-conversations) documentation. The installed Front plugin SDK supplies the typed context and draft APIs.

Dialpad's [call events](https://developers.dialpad.com/docs/call-events), [SMS events](https://developers.dialpad.com/docs/sms-events), [concluded call lookup](https://developers.dialpad.com/reference/callget_call_info) and [call list](https://developers.dialpad.com/reference/calllist) document capture/recovery boundaries. Front's [native Dialpad guide](https://help.front.com/en/articles/2891264) explains separate call/SMS channels and personal-number limits. AWS documents the [monorepo header configuration](https://docs.aws.amazon.com/amplify/latest/userguide/monorepo-custom-headers.html).

## September 9 review remediation

The six reported deploy blockers and the additional confirmed findings are tracked with their code changes and executable regression coverage in [the remediation record](specs/communications-review-remediation.md). Repository gates still do not establish a connected production integration.


### Recovery behavior after the second review

- Each scheduled run captures one independent Front search page and one Dialpad call-history page before processing due work. Front conversation jobs and per-message receipts isolate bad history items. Malformed records remain visible in review. Storage failure prevents advancing the affected provider cursor; a Front outage does not stop Dialpad capture.
- Late call relationships combine already captured legs. A confirmed answer retracts duplicate automatic callbacks; custom promises remain open. A failed lookup leaves a known missed-call callback due on its original clock. Conflicting association links require explicit review. Relationships not yet supplied by Dialpad cannot be inferred safely from a shared caller number.
- Authorization failures hold queued delivery with increasing delays, capped at an hour. Shared cooldowns limit probes of a broken provider token. Reconnect an invalid Front mailbox or update credentials, validate, and resume. New credentials can validate immediately; existing queued operations resume on their retained retry schedule. Unknown external-send outcomes still require delivery review before retry.
- The worker stops starting due items after 75 seconds and writes health before returning. Keep reserved concurrency at one; changing it requires a new review of call unions and provider-send fencing.
- Re-saving a healthy conversation link preserves its history walk and manual Front assignment. It repairs a missing workflow binding or missing history job, and restarts a failed capped history job in place. Active jobs retain their cursor. Failed message receipts can be replayed through Event review after correcting the cause.
- Settings save standard Activity metadata atomically with configuration. Credential updates log requested/completed field names only. If secret storage succeeds but completion auditing fails, inspect the existing intent and validate the connection before resuming; do not assume that the credential update failed.


### History recovery and staging soak

Admin **Settings → Integrations → Repair history capture** provides two recovery actions:

- **Restart Front/Dialpad history search** drops the rejected pagination token while preserving the unfinished time window and Front inbox position. Record a reason. If another worker has advanced the cursor since the screen loaded, refresh settings and retry. The next scheduled sweep rereads already captured pages safely and continues through the missing interval.
- **Retry conversation history** restarts a stopped or completed conversation walk from its first page using its existing job identity. Captured message receipts deduplicate projection. An active walk keeps its current position. Both link-triggered and periodic history jobs use the same reset behavior: clear the cursor, retry count, failure and completion marker, then set the due time. This action does not retry a customer email.

Repeated periodic Front history walks have a 30-minute cooldown measured from successful completion. Each conversation still has at most one periodic walk running. A failed capped walk remains visible for deliberate repair instead of being restarted each cycle. Signed webhooks continue to ingest new messages immediately; the cooldown bounds repair traffic and is a recovery latency to measure in staging.

The website readiness wait is now 20 minutes, leaving build time below Amplify's [default 30-minute timeout](https://docs.aws.amazon.com/amplify/latest/userguide/troubleshooting-build-issues.html). If the backend needs longer, rerun the website build after it succeeds.

For the staging soak, use the existing isolated CRM and website staging branches, keep delivery paused and cleanup disabled until test channels and recipients are configured, and record the controlled acceptance matrix above. Measure idle-history request volume over at least one 30-minute cooldown, reset rejected provider cursors through the UI, and retry a capped conversation job. Then observe real controlled email/call/text events across both native and CRM views. Extend the soak across a business deadline before assessing reminder/escalation behavior. This is an operational validation step, not another broad static audit.

### Initial staging deployment — September 9, 2026

Commit `4edbaab` was pushed to the existing staging branch. CRM job 167 deployed the backend successfully, including the new LeadReply due index. The worker became active with reserved concurrency one, a fresh non-lagging heartbeat and the staging sender. No integration configuration or provider credentials were saved; delivery therefore remained paused and cleanup disabled.

Website job 166 waited for the new backend contract and reported readiness before completing its build. Hosting then rejected the shared header file because it lacked the website's `appRoot`. CRM job 167 subsequently failed its frontend type check because shared website component tests resolved React from the uninstalled website dependencies. Both previous frontend deployments stayed in place. The corrections add an explicit website header entry and resolve React types from the CRM installation without dropping tests from type checking. The corrected CRM build also passed with website dependencies temporarily absent.

The hosting redirect adds a trailing slash to `/front-sidebar`; both authenticated and sign-in routing now recognize either form. Website job 167 additionally established that Amplify requires a nonempty `customHeaders` array: the website entry now sets `X-Content-Type-Options: nosniff`, and the configuration regression enforces both app matching and a nonempty list. Redeploy both staging apps with these corrections and verify their successful hosting steps, the deployed sidebar and response headers. Provider traffic acceptance remains pending Front/Dialpad credentials, test channels and designated recipients; infrastructure deployment alone does not complete that soak.

CRM job 168 and website job 168 succeeded. Live browser checks rendered both the sidebar sign-in and the website contact form, and the backend readiness probe passed. The sidebar nevertheless returned HTTP 404 through the existing SPA fallback, omitting its custom headers. The CRM build now emits `front-sidebar/index.html` from the generated app shell, and the header rule covers that directory. This fixes the sidebar route in build artifacts without changing the app-wide hosting rewrite rules. Verify HTTP 200, Front `frame-ancestors`, `no-store` and `no-referrer` after redeploying this correction.
