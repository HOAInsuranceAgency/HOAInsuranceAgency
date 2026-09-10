# Front, Dialpad and CRM rollout

Implementation is deployed to staging. Front and Dialpad credentials and channels are configured, the replacement email channel is verified, and CRM connection checks pass. Controlled provider acceptance and activation remain pending, as recorded below. Production is not deployed or activated. Do not confuse passing repository checks with a connected production integration.

For hands-on acceptance, use the [step-by-step staging test walkthrough](FRONT-DIALPAD-TEST-WALKTHROUGH.md) or its [interactive checklist](FRONT-DIALPAD-TEST-WALKTHROUGH.html). Each test has actions, expected results, and an explicit setup requirement where another teammate or administrator is needed.

## Operating behavior

- Website enquiries are captured once, together with their original answers, the configured default responsibilities, the pending Front import and team SMS alert. An unchanged browser retry uses the same submission ID, retry proof and answers to retrieve its receipt, including after reload. Corrected answers receive a new submission identity; a previous attempt whose response was lost may already have arrived. Cached older forms without an identity remain accepted during cutover, but cannot receive retry deduplication. A storage failure does not show a success screen.
- Front imports the labelled website submission. After the existing document/upload window, the AI producer queues a reply as Brian Cole through the shared sales channel, using that exact conversation. There is no email provider selector and no SES fallback for this flow.
- Front acceptance is pending delivery. The worker resolves the returned message UID to a message and conversation before recording SENT and scheduling follow-up. An ambiguous outbound result is held for review, without an automatic resend.
- Brian is the intended production default salesperson and deal champion; admins may choose any active teammate eligible for both roles. Team settings control dropdown eligibility independently of Cognito access. Explicit reassignment preserves deadlines. Large accounts apply notification and Front-routing changes through durable batches of 25 records after committing the two duties. A unavailable or unconfigured default leaves a visible assignment exception.
- Ordinary no-reply follow-up is 9 a.m. Eastern on the second business date after confirmed outbound email; all scheduled reminders and champion escalations run in the 9 a.m. Eastern batch. Inbound response and callbacks use eight staffed hours, 9–5 Eastern, Monday–Friday excluding the configured holidays. Response/callback reminders arrive at 9 a.m. on the due date, while the original staffed-hour deadline stays unchanged. Overdue work escalates at 9 a.m. on the next business date after that due date. Custom promises require a reason and a future date and survive later messages. A late-linked request retains its original deadline; if its escalation deadline has already passed, the salesperson and champion are informed together, using one escalated notice when they are the same person.
- CRM tasks and notifications remain authoritative when any Front user snoozes, archives, marks read or changes the handler. Due work reopens its linked conversation. Cleanup is automatic whenever the integration is activated and delivery is running; there is no separate toggle. Old saved cleanup preferences are ignored and removed on the next settings save. Pausing delivery pauses cleanup too. Cleanup checks current activity, ownership, commitments, delivery uncertainty and synchronization health before archiving.
- Dialpad is authoritative for calls and texts. Front's native integration remains the human calling/texting interface. Calls and SMS conversations stay separate from email. Explicit activity links unify their CRM history without manufacturing duplicate Front messages.
- The main and individual business lines are monitored. New prospect text drafts use the shared **(508) 233-2261** channel and require a person to send in Front. Delivered SMS and connected calls do not prove that a request was resolved.
- Unknown callers/texts enter triage; a phone-number match alone never chooses an HOA. Staff can link one activity, combine selected requests with the earliest deadline, and confirm a call outcome with the applicable next action. Carrier requests remain separate from prospect response work.

## Deployment order

Use an isolated staging backend, Front inbox/channel and controlled contacts first. Intake identity arguments are additive and optional at the schema boundary, so cached older forms remain accepted. The new website always supplies them. Do not make them required until old clients have been retired.

1. Run CRM tests, frontend/backend type checks, both application builds and `synth:check`.
2. Deploy the CRM backend and frontend to staging. The integration initially pauses delivery. New enquiries remain durably captured while setup is incomplete; their queued delivery is visible.
3. Set the staging website's existing `PUBLIC_CRM_API_URL` and `PUBLIC_CRM_API_KEY` to that staging backend, and deploy the website. Disable staging analytics using the existing setting. Front/Dialpad secrets never belong in website variables.
4. Configure the integration and run the controlled tests below. Cleanup runs automatically once delivery starts; use linked test leads and verify the archive safeguards as part of acceptance.
5. Production may start both application builds from one push. The website build now performs a skipped GraphQL mutation that validates the new contract without executing intake, then calls the non-writing `leadIntakeReady(readinessContract: 1)` query (dispatch uses the argument because Amplify does not supply `event.info`) that checks the new handler version and its communication-table access. It waits up to 20 minutes for the CRM schema; if the backend is unavailable or incompatible, the website build fails and the existing deployed website remains live. Fix/retry the CRM build, then rerun the website build. Monitor legacy FormSubmit conversations from cached pages during cutover. Historical initial replies are held as described below. Only activate after the production channel and sender are validated.

Infrastructure additions: one server-only DynamoDB table with kind/account/due/open-work indexes, a Secrets Manager secret, custom authenticated read/write resolvers, a signed public webhook receiver, and a scheduled delivery/reconciliation worker. The Account stream initializes responsibility state for other existing lead-creation paths. Public lead-intake requests receive an AWS WAF IP rate limit; sampled request bodies are disabled. These resources add normal AWS usage charges. Existing non-lead mail flows keep their existing transport.

`customHttp.yml` allows the `/front-sidebar` route to be embedded by Front, disables caching for that page and sends no referrer. Check actual staging response headers, including any console-configured `X-Frame-Options`, before installing the sidebar. Other CRM authorization rules remain in effect.

## Admin setup

### Team

In **Settings → Team**, enable both salesperson and deal-champion eligibility for the intended default teammate. Map each teammate to their real Front teammate ID (`tea_…`) and Dialpad user ID. These fields do not alter roles, groups, visibility or permissions. In **Settings → Integrations**, select that teammate as the default for both duties. Brian is the intended production default; Jake can be selected in staging. This setting is validated by identity and eligibility, not by name.

### Front

Create a private developer application for this CRM integration in the intended Front company. Save its application signing key and the appropriately scoped API token in the secure credential fields in Integration settings. Tokens are stored only in Secrets Manager; the UI receives presence indicators, never saved secret values.

Configure:

- Company ID from Front's `/me` response.
- Shared Sales inbox and its actual email channel. Production sends as `sales@protectmyhoa.com`; staging cannot use that production sender and also enforces a recipient allowlist.
- Enable **Track sent emails** on that shared sales channel, and verify a Seen signal using a controlled test recipient. API delivery alone does not prove tracking is enabled.
- Additional inboxes to include in CRM scope.
- Separate native Dialpad voice and shared-line SMS channels, with the shared text channel mapped in settings.

The Integration screen displays the deployed webhook and sidebar URLs. Register the `/front` webhook as an **application webhook**, with inbound/outbound messages, delivery failure, assignment and conversation state events. The receiver validates Front's timestamp and HMAC, checks the company ID, and answers the signed challenge. It rejects explicitly excluded inbox events before persistence and queues only identifiers for other events. The worker checks current inbox membership before fetching conversation or message content. A denied workspace-resource lookup does not start a token-wide authorization cooldown; real token authentication failures still do.

Install the sidebar at the displayed `/front-sidebar` URL. Users sign in with their existing CRM identity. If Front's embedded browser has separate storage, request a CRM sign-in email and copy its unopened sign-in link into the sidebar's private link field. No Front identity or teammate mapping substitutes for CRM authentication.

Read-only connection checks establish API access and channel identity. They do not send a customer message. The final activation action also requires recent signed test events and the admin's confirmation of native channel tests.

### Dialpad

Use an API identity with company access covering the intended office, main line and individual business numbers. Enter the real company/office IDs and normalized business numbers. The screenshots establish the main line and Connect Pro subscription; they do not supply all individual numbers or prove API scopes.

Register the displayed `/dialpad` URL as a Dialpad webhook with a dedicated signing secret saved in CRM settings. Configure call and SMS subscriptions for the intended office/users; avoid subscribing staging to all production calls. Include the relevant connected, hangup, voicemail and available enrichment events. Request SMS delivery status events. SMS body export requires the applicable `message_content_export` or `message_content_export:all` permission. Call reconciliation requires `calls:list` and coverage beyond the token owner's personal history.

Subscription creation is a tenant setup step: use Dialpad's administration/API tooling to create the webhook and scoped call/SMS subscriptions. The CRM does not change routing, recording policies or number assignments. Keep provider subscription IDs in the deployment record alongside the tested numbers.

Verify native shared-line SMS send/receive and all individual voice lines. Front's app-store Enabled label alone does not establish these connections. Individual-number SMS uses Dialpad event capture where authorized; the implementation does not promise native Front SMS channels for those personal numbers.

After controlled signed events arrive, select **Validate and activate**. Activation records the capture starting point. Changing channel/line mappings or rotating credentials pauses delivery until revalidation. Changing companies after activation requires a separate migration of stored links.

## Daily use and recovery

**Lead follow-up** offers Needs attention, Upcoming, and All open. Needs attention includes prospect/carrier responses, callbacks, delivery corrections, and work due today or overdue; Upcoming contains the remaining future tasks. Responsibility is a separate salesperson/champion filter. My leads retains lead ownership filtering; combined with a responsibility, it requires the signed-in teammate to hold that role. Waiting on prospect is a label on automatic follow-ups, not a view. None of these reads changes a task or deadline.

Shared assignment and unlinked-activity cards appear in Needs attention and All open independently of personal/role filters, so work without an owner stays visible. Each list has its own bounded pagination and error/retry state. My reminders is a separate collapsible section retaining the existing current-recipient checks. Technical ISSUE, OPERATION, and EVENT reads and issue resolution now require ADMIN. They are available under **Settings → Front and Dialpad → Advanced tools → Connection issues and queues**; staff retain activity linking and their own reminders.

Views fill pages with matching work on the server. Each request searches up to eight source pages. If more records remain, an empty result explicitly offers Continue searching; it does not claim there is no work. Date grouping uses the agency's Eastern calendar. There is no global communication-body export through the work endpoint.

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

The worker checks incremental Front inbox history with a six-hour overlap and Dialpad concluded call history with a 24-hour overlap, starting at activation. Checkpoints advance only after the page has been processed or durably queued. Dialpad overlap deduplicates by call ID and a canonical hash of its provider snapshot, so unchanged calls do not create new events on every tick; changed details still enrich the call. Repeated missed-call snapshots do not rearm concluded-call lookups. Transfer master IDs take precedence over entry-point/operator IDs; conflicting relationships are held for review. Receipts from an explicitly excluded business line are acknowledged with a scope reason before persistence. Call-history scans skip excluded lines. Records whose line cannot be identified retain provider IDs for review without message or transcript content; their problem remains visible. Previously saved excluded events retain a processing outcome explaining their scope. Pagination and work per run are bounded. Front rate headers and retry windows are shared across workers; optional Seen/search requests leave capacity for sends.

A worker interruption creates a sync-gap issue that prevents cleanup until reviewed. Inspect the saved events, delivery queue, provider webhook state and the affected interval. Repair credentials/scopes, then replay failed saved events from the event view. Front 401/403 failures retain pending delivery and raise an authorization issue, so token repair does not require retrying every email manually. Team tasks remain scheduled regardless of the number of processing failures; rate-limit waits do not consume their failure count, and successful dispatch resets it. Review and resolve the synchronization issue after repair. Front may disable an application webhook after repeated failures; update/reverify it in Front after fixing the receiver.

Do not assume historical SMS can be recovered from an undocumented API. Review Dialpad/Front native history for an SMS gap, explicitly restore the affected activity/tasks, and document the reconciliation before clearing the gap issue. Available recording/transcript/recap events enrich the call without moving its deadline; missing AI/media features do not block the base call record.

Seen is cached separately from confirmed delivery. The worker supports numeric/string second or millisecond timestamps, records check time and failures, and stops scheduled checking after a substantive reply, terminal outcome or fourteen days. A missing Seen signal is not labelled unread. Neither an open signal nor SMS delivery proves a human read the message.

**Refresh Seen status** queues a rate-limited check of a selected sent email, including older messages. It does not change any follow-up date or send another email. A verified Front conversation merge updates the canonical link when resolving delivery; a merge across different CRM leads requires review.

### Existing leads and legacy replies

Use **Fill missing lead responsibilities** in batches to apply the configured default without overwriting existing assignments or dates. Link existing Front conversations explicitly; this queues a paginated backfill of messages from the activation window and repairs account links for previously unlinked messages. Do not merge every historic message from a shared property-manager address.

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

For the staging soak, use the existing isolated CRM and website staging branches, keep delivery paused until test channels and recipients are configured, and record the controlled acceptance matrix above. Measure idle-history request volume over at least one 30-minute cooldown, reset rejected provider cursors through the UI, and retry a capped conversation job. Then observe real controlled email/call/text events across both native and CRM views. Extend the soak across a business deadline before assessing reminder/escalation behavior. This is an operational validation step, not another broad static audit.

### Initial staging deployment — September 9, 2026

Commit `4edbaab` was pushed to the existing staging branch. CRM job 167 deployed the backend successfully, including the new LeadReply due index. The worker became active with reserved concurrency one, a fresh non-lagging heartbeat and the staging sender. No integration configuration or provider credentials were saved; delivery therefore remained paused and cleanup disabled.

Website job 166 waited for the new backend contract and reported readiness before completing its build. Hosting then rejected the shared header file because it lacked the website's `appRoot`. CRM job 167 subsequently failed its frontend type check because shared website component tests resolved React from the uninstalled website dependencies. Both previous frontend deployments stayed in place. The corrections add an explicit website header entry and resolve React types from the CRM installation without dropping tests from type checking. The corrected CRM build also passed with website dependencies temporarily absent.

The hosting redirect adds a trailing slash to `/front-sidebar`; both authenticated and sign-in routing now recognize either form. Website job 167 additionally established that Amplify requires a nonempty `customHeaders` array: the website entry now sets `X-Content-Type-Options: nosniff`, and the configuration regression enforces both app matching and a nonempty list. Redeploy both staging apps with these corrections and verify their successful hosting steps, the deployed sidebar and response headers. Provider traffic acceptance remains pending Front/Dialpad credentials, test channels and designated recipients; infrastructure deployment alone does not complete that soak.

CRM job 168 and website job 168 succeeded. Live browser checks rendered both the sidebar sign-in and the website contact form, and the backend readiness probe passed. The sidebar nevertheless returned HTTP 404 through the existing SPA fallback, omitting its custom headers. The CRM build now emits `front-sidebar/index.html` from the generated app shell, and the header rule covers that directory. This fixes the sidebar route in build artifacts without changing the app-wide hosting rewrite rules. Verify HTTP 200, Front `frame-ancestors`, `no-store` and `no-referrer` after redeploying this correction.

### Verified staging outcome — September 9, 2026, 11:58 a.m. Eastern

Code commit `e3d5eac9f6b5e97df2f13ec341867c89d4b9199d` deployed successfully in CRM job **170** and website job **169**, including their hosting verification steps. Production was not deployed.

| Live check | Result |
| --- | --- |
| [CRM Front sidebar](https://staging.d2d4g940z91vj4.amplifyapp.com/front-sidebar/) | HTTP 200; sign-in screen renders. `frame-ancestors 'self' https://*.frontapp.com https://*.front.com`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`; no conflicting `X-Frame-Options`. |
| [Website contact form](https://staging.dx1256wpowwzz.amplifyapp.com/contact/) | HTTP 200; form renders; `X-Content-Type-Options: nosniff`. No enquiry was submitted. |
| Deployed intake contract | Non-writing readiness probe returned true. |
| Scheduled worker | Staging environment, reserved concurrency one, heartbeat at `2026-09-09T15:58:41.335Z`, `lagging: false`. |
| Paused runtime observation | The 11:16–11:46 a.m. Eastern CloudWatch window reported 28 invocations, zero errors and zero throttles across 28 reported minute buckets. This is an idle baseline, not provider-traffic acceptance. |
| Provider setup | No saved integration configuration; all four API/signing credential fields absent. Default delivery paused and cleanup disabled. Staging sender: `jake+testing@protectmyhoa.com`. Unconfigured Front and Dialpad webhook endpoints each returned 503 for an empty unsigned request. |

Local verification reached **1,921 tests across 97 files**. Frontend/backend type checks, website type checks, both builds and backend synthesis passed during remediation. The subsequent hosting corrections passed the isolated CRM build, generated-sidebar artifact comparison, seven relevant build-configuration tests and whitespace checks.

**Connected soak remains pending.** An admin must configure credentials through [staging Settings → Front and Dialpad](https://staging.d2d4g940z91vj4.amplifyapp.com/settings/?tab=integrations), identify the Front test inbox/email/SMS channels and Dialpad test lines, and designate recipient email/phone numbers. Do not count this deployment as evidence for real email threading/open events, signed webhook capture, call-leg reconciliation, SMS, provider cursor recovery, or reminder/escalation delivery. Run the controlled acceptance matrix and observe a business deadline after that setup. No customer message or live lead was created in this validation.

### Tenant setup in Chrome — September 9, 2026, 12:29 p.m. Eastern

Completed:

- Created the private Front app **HOA CRM — Staging**, developer app ID `314906`, app UID `a60c398b88e32340`. Its sidebar feature is Ready and points to `https://staging.d2d4g940z91vj4.amplifyapp.com/front-sidebar/`. Embedded conversation behavior remains untested.
- Created **CRM Staging**, inbox `inb_d2me2`, in **HOA Insurance Agency LLC**. Access is restricted to Jake Greasley and Brian Cole; ticket prefix `HOATEST`. No channel is attached yet.
- Created Front token record `jwt_s716`, named **HOA CRM — Staging**, with global resource metadata and shared access restricted to the HOA workspace. Permissions: read attachments, channels, comments, conversations, events, inboxes, messages, teammates and teams; write comments, conversations and messages; send messages. No delete, private-resource, provisioning or application-trigger access was granted.
- Saved the new Front API token and application signing key through staging CRM secure settings. Verified both are present in Secrets Manager without exposing their values. No Dialpad credentials are saved.
- Verified Front `/me` returns `cmp_5azru`, named **GIM Property Management, LLC**; the HOA workspace belongs to that company. Saved this company ID and the staging inbox ID. The CRM connection checks pass **Front company** and **Front inbox access**.
- Saved Jake's Front teammate mapping `tea_ci3mi`. Brian's verified Front teammate ID is `tea_cr21m`; Michael Greasley's is `tea_cja56`. Brian is not yet a staging CRM member, so both Brian defaults remain unconfigured. No invitation was sent.
- Confirmed **Track sent emails** is already enabled on `sales@protectmyhoa.com`. This does not establish a Seen event. The staging sender remains `jake+testing@protectmyhoa.com`; that sender is not yet connected as a Front email channel.
- Verified the existing native **HOA Dialpad** voice inbox (`inb_d2iai`). There is no connected native Dialpad SMS channel in the HOA workspace.
- Recorded the business-number allowlist: main line `+15082332261`, Jake `+16177024123`, Christina `+15085459125`, Brian `+15082571566`, Mike `+15085384962`. Dialpad user/company/office IDs and subscription scope are still pending.

Blocking setup details:

1. Dialpad identifies the current Jake account as **Office Admin**. The native Front SMS authorization returned **“You need to be a company admin in Dialpad to setup the channel.”** Use a Company Admin identity for native shared-line SMS and the API key, then create signed call/SMS subscriptions. No SMS channel or subscription was created. An Office Integrations Enable click produced no verified change and must not be counted as completion.
2. Confirm an accessible staging sender mailbox and controlled recipient email/phone. Add Brian to staging and enable both assignment options before selecting him as the default. Permission to send his invitation was requested and remains pending.
3. The application-webhook settings are determined but **not registered**; the unsaved creation form was cancelled pending scope resolution. Front's creation UI exposes URL and event types, without an inbox/workspace filter. Its [documented application webhook scope](https://dev.frontapp.com/docs/webhooks-1) covers shared inboxes; the separate API token restriction does not establish an equivalent webhook restriction. The current receiver verifies the company and persists the full event before the worker checks conversation inbox scope. Resolve this scope before enabling the webhook on this Front company, which contains multiple businesses. Do not describe the HOA API-token restriction as isolated webhook capture.

The prepared Front webhook target is `https://47mcywcaocslt3i2z3uorqj4vi0ykugc.lambda-url.us-east-1.on.aws/front`; the Dialpad target uses `/dialpad`. The Front draft selects inbound/outbound messages, delivery failure, moved/archived/reopened/deleted/restored/merged/snoozed conversations, snooze expiry, comments and assignment changes. Registration, signed challenge acceptance and real signed event capture are not yet verified.

Amplify's console confirms the successful staging deployment. No additional Amplify environment variables or production changes were made during tenant setup. Delivery remains paused, cleanup disabled, and the test-recipient allowlist empty. No prospect email, text, call or live lead was created.


### Company-admin setup and tenant isolation — September 9, 2026, 1:12 p.m. Eastern

This entry supersedes the pending company-admin and credential observations in the 12:29 p.m. entry. The user confirmed the staging email address and instructed that no staging invitation be sent. No invitation was sent, and no additional staging CRM member was created.

- Dialpad now verifies Jake as **Company Admin**. Created company API key **HOA CRM — Staging** with default access, recordings export, message-content export, list calls and AI Recap. Saved its value securely; no credential values appear in this record or Amplify environment variables.
- Verified Dialpad company `4972992849059840` (GIM Property Management), HOA office `5077405326581760`, and all five permitted business numbers. Company API keys use `/company`; `/users/me` returns 404. The connection check now uses the verified company endpoint.
- Connected the native Front Dialpad SMS channel **HOA Insurance Agency (sms)**, `cha_glcre`, to **HOA Dialpad** (`inb_d2iai`). The channel is valid and sends as `+15082332261`; its internal address is `+15082332261_sms`. Validation now checks the native `dialpad_sms` type and `send_as` number. Existing voice channel `cha_gl8ii` is unchanged. Native SMS conversation closure is one day; this does not set a CRM commitment date.
- Created Front email channel `cha_glct6` for **jake+testing@protectmyhoa.com**, routed to **CRM Staging** (`inb_d2me2`). Sent-email tracking is enabled, closure is Never, and sending uses Front's default server. Gmail forwarding is **not yet complete**, so the API currently reports this channel invalid. Mail to the testing alias reaches Jake's business Gmail (`jake@getgim.com`). Adding the Front forwarding destination triggered Google's device identity check. After that check, confirm the destination and create a filter for **To: jake+testing@protectmyhoa.com** only; leave global mailbox forwarding disabled and do not forward historical messages.
- Saved staging email channel, SMS channel, company/office IDs, the existing phone-number allowlist, the native phone inbox as an additional allowed inbox, and `jake+testing@protectmyhoa.com` as the permitted test email recipient. Jake's team mapping now includes Dialpad user `5655281245659136`. Brian is still absent from the staging roster; the two Brian defaults remain an explicit setup exception. Do not invite him as a workaround.
- Created signed Dialpad webhook `4934104331100160` for the displayed `/dialpad` callback. Its dedicated random signing secret is saved in Secrets Manager. Created the scoped subscriptions below, **all disabled** pending controlled tests. Call subscriptions include `all` states (the live API requires an explicit list despite describing it as optional). SMS subscriptions include inbound/outbound, content permission and delivery-status updates, with internal messages excluded.

| Target | Dialpad target ID | Call subscription | SMS subscription |
| --- | --- | --- | --- |
| HOA main line / office | `5077405326581760` | `4762460190973952` (group calls only) | `5082771637706752` |
| Jake | `5655281245659136` | `6292980376838144` | `5983546538762240` |
| Brian | `6631979646656512` | `4671795847274496` | `6454057421021184` |
| Christina | `6047451736743936` | `5171249473953792` | `4554878113325056` |
| Mike | `5241968595607552` | `5875826510831616` | `6118054948806656` |

The Front company-webhook boundary is corrected in code: explicitly excluded source inboxes are discarded, retained receipts contain processing identifiers only, and the worker verifies inbox membership before requesting content. Conversation-specific scope denials no longer put the whole provider into authorization cooldown. Dialpad receipts and call reconciliation also enforce the business-number allowlist before storing content. Unidentified records retain minimal provider identifiers for visible review. Deploy these corrections before registering the company-wide Front webhook.

Validation: **1,936 tests across 97 files** passed; the final small assignment-event optimization additionally passed the 86 workflow tests. Backend/frontend type checks and the CRM build passed with the final optimization; backend synthesis and the 156-page website build also passed. This is repository verification, not a connected provider soak. Google verification, Front email validation, Front webhook registration, controlled call/text recipients, signed provider traffic and responsibility defaults remain outstanding. Delivery remains paused and cleanup disabled. No prospect email, SMS or call was sent.


### Live verification follow-up — September 9, 2026, 1:25 p.m. Eastern

Commit `cf923ffdd955df7dd85503f643a5b3aab34ff6a8` deployed successfully in CRM job **171** and website job **170**. The deployed receiver and worker packages contain the new inbox-scope restrictions. Live CRM checks verify Front company, inbox access, shared texting, Dialpad company and the presence of both signing secrets.

A live empty Dialpad `/call` window returns `{}`; a 24-hour query returns an `items` array. The call-history validator and reconciliation now accept exactly the observed empty-object form while continuing to reject malformed/error-shaped responses. Added regressions cover an empty-window checkpoint and malformed responses. These follow-up changes passed **111 targeted provider/workflow tests**, backend/frontend type checks and the CRM build before redeployment.

Front's own Create-webhook verification failed even though a direct, locally signed `sync` challenge returned HTTP 200 with the correct echo in 0.31 seconds. That direct diagnostic is not evidence of a real Front-delivered event and does not update webhook health. Re-copied the private app's signing key through Chrome and saved it securely to rule out an incorrect initial transfer. Minimal rejection logging records fixed reasons only, never signatures or event bodies, to diagnose any continuing provider challenge failure. After re-copying the app signing key, Front successfully created the webhook at approximately 1:25 p.m. Eastern. The feature now shows **Ready** at `https://app.frontapp.com/settings/developers/314906/features/webhook`, with the configured callback and all 13 selected event types. This verifies Front’s own signed challenge; it does not establish ordinary inbound/outbound capture or the controlled acceptance matrix.


### Verified handoff — September 9, 2026, 1:36 p.m. Eastern

Follow-up commit `3aa179f886ffc8257f0bcdf7641412838a3f1dd3` deployed successfully in CRM job **172** and website job **171**. CRM build, hosting deployment and hosting verification all succeeded. Production remains unchanged.

The live Settings check now passes **Front company**, **Front inbox access**, **Shared text channel**, **Dialpad company**, **Dialpad call history** and **Webhook signatures** (credential presence). The remaining failed setup checks are **Front sales channel**, pending Google forwarding verification, and **Default responsibilities**, because Brian has no staging roster entry. All four credential values remain present in secure storage.

Front delivered a real signed `new_comment_added` event at `2026-09-09T17:27:20.490Z`; the worker marked it processed at `2026-09-09T17:27:41.209Z`. This proves an ordinary provider event reached the receiver and worker. It does not substitute for controlled lead email, threading, Seen, call, SMS or deadline tests. The Front webhook and sidebar are both Ready.

All five call subscriptions and five SMS subscriptions listed above were re-read and verified **disabled** by their exact IDs. Dialpad list responses identify their endpoint through the nested `webhook` object, not a top-level `endpoint_id`. No ordinary signed Dialpad receipt has arrived yet.

Final saved state: staging, delivery paused, cleanup disabled, no activation timestamp. No staging invitation, prospect email, SMS or call was sent. Google’s identity-verification popup remains open for Jake; the forwarding destination has not yet been confirmed and no mailbox-wide forwarding was enabled. The controlled phone recipient remains unspecified. Complete those steps and resolve Brian's staging assignment without sending an invitation before running the remaining acceptance matrix and activating.

### Staging address clarification — September 9, 2026

The user confirmed **`jake+testing@protectmyhoa.com`** as the staging test recipient; it already delivers to their mailbox. The pending Gmail forwarding request and Google verification window were cancelled. Gmail again shows only **Add a forwarding address**, with no forwarding destination configured; no forwarding rule was enabled. Earlier instructions to complete Google verification for that request are superseded. The recipient was also configured as the Front sender during setup; that sending-channel arrangement remains unresolved and must not be described as ready.

### Readiness recheck — September 9, 2026, 1:52 p.m. Eastern

Both latest Amplify staging jobs remain successful (CRM 172, website 171). A live read confirms delivery is paused, cleanup is disabled, activation has not occurred, and the default responsibility user is unset. The worker heartbeat at `2026-09-09T17:50:41.451Z` reports no lag; Front receipt health is `2026-09-09T17:51:34.067Z`. There is still no Dialpad receipt health record. Front reports staging email channel `cha_glct6` invalid and native shared SMS channel `cha_glcre` valid. The permitted test email recipient is saved correctly. The full workflow is not ready for user acceptance: resolve the sending channel and Brian's staging responsibilities, designate the controlled phone recipient, then enable and verify scoped phone capture and activate delivery for controlled tests. No invitations or messages were sent by this recheck.

### Settings usability update — September 9, 2026

The Front and Dialpad settings page now starts with a compact, saved-state overview of the sender, test recipients, shared text number, default responsibilities, delivery state and cleanup. Delivery controls and advanced tools are collapsed. Technical IDs, webhook URLs, recovery controls and credentials remain available through deliberate disclosure/editing; connection checks present plain-language actions with raw diagnostics under Advanced tools. This UI change does not activate delivery or change provider configuration.

Settings use an isolated edit session with explicit Save and Cancel. Multiline input is parsed on submission, so saving does not depend on blur. Failed saves retain edits; successful saves adopt the returned version and clear new credential input. Connection checks, activation and recovery cannot run while editing, and duplicate actions are fenced while requests are pending. Previously saved cleanup preferences are preserved when resuming delivery.

Validation: 1,943 tests across 98 files, frontend/backend type checks, both builds and backend synthesis passed. Browser checks of the actual components with local fixture responses passed at desktop and mobile widths, including no horizontal overflow, collapsed technical controls, and edit isolation. Live staging hosting verification follows deployment. Existing provider setup blockers remain unchanged.

Commit `a2f6d3202df06401e122e563a8a3356f7176b8cb` deployed successfully in CRM job **173** and website job **172**, including hosting verification. Chrome live verification at approximately 4:22 p.m. Eastern confirmed the compact overview, collapsed advanced controls, Edit/Cancel behavior, and a real connection check reporting the two existing setup issues: lead ownership and email sending. No integration values were changed or delivery activated during browser verification. The updated settings page was left open for the user.


### Default teammate correction — September 9, 2026

The admin's chosen default may be any current, enabled CRM teammate eligible for both salesperson and deal champion. The original Brian-only dropdown and server name check incorrectly turned the intended production default into a permanent restriction. Both restrictions are removed; empty-state and validation messages now refer to the selected default. Changing this setting does not reassign existing leads, alter permissions, or change the AI email's Brian Cole sender identity. No invitation is needed to select an existing eligible staging member. This supersedes the earlier requirement to add Brian to the staging roster as a setup prerequisite.

Validation for this correction: 1,952 tests across 98 files, frontend/backend type checks, CRM and website builds, and backend synthesis passed. New regressions cover selecting and saving Jake, applying the configured default to a new lead, preserving existing assignments, and rejecting missing roles, disabled teammates/sign-in accounts, or stale roster identities. Both staging and production environments use the same eligibility rule; production configuration is not changed by this correction.

### Protected teammate connection settings — September 9, 2026

Front teammate IDs and Dialpad user IDs now display as read-only reference values in **Settings → Team**. **Edit connections** opens the app's standard form dialog with explicit Save and Cancel, provider-format feedback, and string-preserving ID fields. Blur, Escape, Close and Cancel cannot save an edit. Pending requests block duplicate saves, dismissal and simultaneous role changes; a failed save keeps the draft available for retry. The API returns the committed eligibility version so a subsequent edit does not depend on an eventually consistent index refresh.

Validation: 1,958 tests across 99 files passed, along with frontend/backend type checks, the CRM build and backend synthesis. The unchanged website build passed during the preceding default-owner correction. Chrome review of the actual component with local fixture responses verified the read-only table and standard dialog layout. Live provider IDs have not been edited as part of this UI verification.


### Live owner verification and sending-channel diagnosis — September 9, 2026

The default-owner correction (`56b1db6`) deployed successfully in CRM job **174** and website job **173**. A refreshed live settings page at 4:56 p.m. Eastern confirms **Jake Greasley** is saved as the default salesperson and deal champion. The connection check now reports only **Email sending**; default responsibilities pass. One stale edit attempt was correctly rejected before the refresh confirmed the current saved choice. Existing lead assignments and the Brian Cole AI sender identity were not changed.

The current staging email channel's Front Settings page explicitly says it is validating redirection. It is an unverified **Other email account** / SMTP forwarding channel, so receiving its email in Jake's mailbox alone cannot complete that channel's validation. For the requested no-forwarding setup, Front's **Google → Gmail Alias** flow offers the existing `jake@getgim.com` primary channel and a separate alias-validation link. The intended correction is to connect `jake+testing@protectmyhoa.com` through that flow, route it to **CRM Staging**, validate the emailed link, and update the CRM to the resulting verified channel. This replaces the earlier forwarding setup recommendation; it has not yet been completed. No channel was created or deleted, no mailbox forwarding was configured, and no validation email was sent during this inspection.

The protected-ID update (`d51f6a1`) deployed successfully in CRM job **175** and website job **174**, including hosting verification. Chrome verification at approximately 5:02 p.m. Eastern confirmed read-only Front/Dialpad IDs in the Team table, the standard **Edit connections** dialog, disabled Save for unchanged values, and Cancel returning to the table. Jake's exact provider IDs and both eligibility choices remain unchanged. The saved Jake default survived reload after this deployment. Delivery remains paused and cleanup disabled; no invitations, emails, texts or calls were sent.


### Verified staging email channel — September 9, 2026, 5:07 p.m. Eastern

After the user completed alias verification, the Front API reports `cha_gld22` as valid, with `send_as: jake+testing@protectmyhoa.com`, in **CRM Staging** (`inb_d2me2`). Front represents this alias as an `smtp` channel; its `send_as` address, rather than its generated inbound address, is the configured sender. Updated staging through the CRM's admin settings from the old `cha_glct6` channel to `cha_gld22`. A consistent saved-state read confirms the new channel and unchanged sender, inbox and Jake default.

The live CRM now reports **Connection checks passed**. This resolves the email-connection setup issue; it does not establish controlled sending, reply threading, Seen events or Dialpad event capture. Delivery remains paused, cleanup disabled, and activation unset. No email, text or call was sent during this update.


## September 10: cleanup is always automatic

Commit `ff644df` removes the separate cleanup control from the settings screen, activation request, and shared configuration. Cleanup runs whenever the integration is activated and delivery is running. Existing saved `cleanupEnabled: false` values and the same field from cached clients are ignored, stripped from returned configuration, and removed on the next settings save; no reactivation or data migration is needed. The overall delivery pause still pauses provider changes. Archive eligibility continues to require valid ownership, a durable next action, resolved inbound work, and healthy synchronization with no uncertain delivery.

Validation: **2,032 tests across 105 files** passed, including automatic and manual cleanup with an old disabled setting, preserved commitments, and paused/unactivated, unanswered, overdue, missing-owner, and sync-gap cases. Frontend/backend type checks, both application builds, and backend synthesis passed. The final test typing adjustment also passed the 124 workflow tests and the CRM build.

CRM staging job **187** and website staging job **186** succeeded. Chrome verified **Delivery active**, **Inbox cleanup: Automatic**, and no cleanup checkbox in the expanded Delivery controls. The existing **TEST Lead Brief 0910** conversation was already archived in Front; its manual Tidy request nevertheless completed as a confirmed ARCHIVE operation at **12:39:44 p.m. Eastern**, proving the old disabled setting no longer blocks the action. Its salesperson/champion remained Jake and its next follow-up remained **September 14 at 9 a.m. Eastern**. No new prospect email, text, call, or invitation was sent for this check. This verifies the setting removal and manual cleanup path; it does not claim a new outbound email or future reminder was exercised during this change.
