# Dialpad + Front + CRM specification

Implementation is now present in the repository. Deployment and real-provider acceptance remain pending; see the [rollout runbook](../COMMUNICATIONS-RUNBOOK.md). The design below records the reviewed requirements, not a claim of a live connection.
**Status: implementation built; live connection and acceptance pending.**
Updated September 8, 2026. This extends the
[Front + CRM product specification](front-crm-integration.md) and its
[technical design](front-crm-integration-technical.md). Existing ownership,
permissions, calendar and deadline protections apply across communication channels.

## 1. Confirmed decisions and observed setup

| Item | Decision or evidence |
| --- | --- |
| Tracking scope | Track the shared main line and the team's individual Dialpad business numbers |
| Prospect SMS sender | Send prospect texts from the shared main line, **(508) 233-2261** |
| Callback deadline | Return missed prospect calls and voicemails within **one business day** |
| Lead responsibilities | Brian Cole defaults as both salesperson and deal champion; explicit reassignment remains available |
| Existing escalation policy | Apply the existing one-overdue-business-day champion escalation to callback work; avoid duplicate notifications when both roles are the same person |
| Dialpad subscription observed | Billing screenshot shows Dialpad Connect Pro |
| Licenses observed | Four Connect Pro licenses, all in use; one room phone in use |
| Main line observed | (508) 233-2261, labeled HOA Insurance Main Line |
| Front app observed | The September 8 screenshot shows Dialpad marked Enabled in Front's App store |

Evidence comes from the user's September 8 billing, license and main-line PDFs,
and Front App store screenshot. An enabled app does not establish that particular
voice/SMS channels are connected, credentials/scopes work, or AI and recording
features are enabled. The four individual numbers and user identities have not
been supplied; setup inventories and verifies them rather than inventing them.
Additional-number license capacity is not evidence of another active phone number.

The remaining behavior below consists of explicit design defaults for review,
not additional decisions attributed to the user. There are no outstanding
business questions needed to specify this addition. Connection verification is
required before claiming the integration works; the subsequent user instruction authorized implementation. Production connection verification is still required.

## 2. What each system owns

| System | Responsibility |
| --- | --- |
| CRM | Lead/association identity, salesperson, champion, communication timeline, next actions, deadlines and escalation |
| Front | Team communication workspace, email, connected Dialpad voice/SMS conversations and CRM sidebar |
| Dialpad | Business numbers, call routing, telephony/SMS events, and available recordings, transcripts and AI recaps |

Use Front's native Dialpad integration for calling and shared-line texting.
Use Dialpad events for the CRM's call/SMS activity and available call outcomes;
link Front's representation to the same activity instead of importing duplicate
call logs into Front. Calls made in Dialpad itself remain within tracking scope
when they involve configured business numbers.

Native Front support has material limits: each call creates a separate Front
conversation; call threading is unsupported. Personal Dialpad number channels
support voice only in this integration. Shared-line voice and SMS require
separate channel connections. These facts are documented in
[Front's Dialpad setup guide](https://help.front.com/en/articles/2891264).

Accordingly, individual-number SMS monitoring uses Dialpad's API where
authorized and available; it does not promise an individual SMS inbox in Front.
Replies to those texts should direct the team to the configured shared-line
composer, with sender and recipient visible. Record the actual source of any
individual-number outbound SMS; do not relabel it as a shared-line send.

Retain existing Dialpad call routing and outgoing voice caller-ID behavior.
CRM lead responsibility does not automatically change who rings or answers.
Front may assign a call conversation to the answering teammate; that does not
change either CRM lead role. Native call handling remains distinct from the
email conversation's role-based handler and any manual override.

## 3. One lead history across separate conversations

Keep the website submission and initial AI email in their planned shared email
conversation. Link associated call conversations and SMS activity to the same
CRM lead. The sidebar shows this combined history and opens the appropriate
Front conversation or authorized Dialpad record.

Do not promise to merge calls or texts into the email thread. Do not post every
ring, call leg, SMS receipt or transcript update as a new email-thread comment.
A person can publish a concise internal call outcome to the email conversation
using the existing audited internal-note action. It must never become a
customer-facing email or quoted internal call transcript.

Normalize phone numbers for matching and maintain stable provider contact IDs.
A contact match is only a candidate association match: a property manager may
represent several HOAs using one number. Auto-link only when a verified mapping
or explicit selected-lead context identifies the association unambiguously.
Otherwise show candidate leads and require explicit linking. SMS conversations
can cover several associations; support message-level selection/linking without
silently assigning all past and future messages to one HOA.

Unmatched activity enters a visible communication triage queue with original
received time. Do not create a new sales lead for every unknown caller: existing
clients, carriers, vendors and spam can also call. A teammate can link an
existing record or explicitly create a lead, which receives the Brian defaults.
Linking late calculates an applicable deadline from the original event, so an
already-overdue callback appears immediately. Unlinked activity receives a
provisional one-business-day triage deadline and remains in team oversight.

## 4. Response and callback rules

Use the same America/New_York staffed-time calendar as the Front specification:
the proposed operational definition is eight staffed hours per business day,
9 a.m. to 5 p.m., excluding the configured agency holidays. The user confirmed
the one-business-day interval; the detailed calendar remains a reviewable default.

| Event | Workflow behavior |
| --- | --- |
| Substantive prospect SMS | Open Needs response with a one-business-day deadline from the first unanswered substantive message |
| Missed prospect call or voicemail | Open a callback action for the salesperson due one business day from the original missed call/voicemail, not from later transcript processing |
| Repeat contact about the same unanswered request | Attach the activity to the existing episode and preserve its earliest deadline |
| Outbound call with no answer, busy signal, or voicemail left | Record the attempt and result; do not automatically complete the request or restart its deadline |
| Connected call | Show outcome/next-action capture; connection or call duration alone does not establish resolution |
| Human-confirmed resolution by phone or SMS | Complete only the identified request and save the successor action, dated waiting commitment, or terminal outcome in one validated operation |
| Carrier call | Attach to the explicitly linked deal/carrier task; do not clear prospect response work |
| Archive, snooze, mark read, change availability, or reassign call handler | Record communication state separately; preserve CRM tasks, roles and deadlines |

A linked substantive inbound message replaces the stale no-response follow-up
for that same request. A missed prospect callback request moves that episode
to callback work; an earlier unresolved response deadline still takes precedence.
When it is uncertain whether two activities concern the same request, retain
visible work for review instead of merging away a commitment. Independent
requests and carrier tasks can coexist.

Use one overdue-business-day champion escalation with the existing notification
deduplication and reassignment rules. A promised callback at an explicit date/time
can replace the default through the same audited CRM/sidebar action with a
reason. Later messages, technical retries and call transfers cannot extend it.

After a connected call, the team records a result such as request handled,
waiting on documents, follow-up required, wrong number, or unrelated/spam.
Closing prospect work still requires a next action or recorded outcome. An AI
recap may suggest an action and date; a person confirms any proposed deadline,
responsibility, or deal-status change. No automatic bind or unattended SMS sequence.

Preserve existing SMS opt-out controls. Delivery status is distinct from a read
receipt; a sent/delivered SMS does not prove it was read or satisfy an inbound
request by itself. Explicit stop/opt-out messages enter the contact-preference
workflow rather than a normal sales follow-up sequence.

Observed substantive human handling by SMS, or a team-confirmed phone resolution,
can suppress an unsent initial AI reply using the existing cancellation service.
A ring, unanswered call or unconfirmed transcript does not count as handled.
Before dispatch, check known takeover state; retain the existing limitation
that simultaneous native communication and an API send cannot be globally locked.

## 5. CRM and sidebar additions

Add a channel filter and activity details: time, direction, external contact,
business line, actual teammate, call/SMS result, linked association, and source.
Show available summary/transcript/recording links with processing or unavailable
states. Keep email Seen, SMS delivery and call connection as distinct signals.

Add actions to link activity, record a call outcome, set/complete a callback,
confirm a suggested next action, and open related conversations. Shared-line
SMS entry must show the configured sender and prospect number before the person
sends. Validate any sidebar-to-composer handoff against the actual Front SDK;
if prefill is unsupported, open the native composer with clear sender/recipient
instructions rather than claiming an unavailable API capability.

Reuse existing CRM authorization. Dialpad/Front teammate mappings identify who
communicated; they do not grant CRM access. Do not expose provider credentials
or public recording share links in the sidebar. Prefer authorized source links;
backend-fetched text/media must retain the CRM's existing access enforcement.
Missing recordings or AI features must not block call logging or callbacks.

## 6. Technical integration and recovery

Extend the existing LeadCommunication model with voice/SMS channel kind, stable
Dialpad call/message IDs, contact/line IDs, actual actor, direction, call outcome,
SMS delivery state, timestamps and enrichment status. Use a normalized activity
with source references so Dialpad and Front can both describe one interaction.
Store call-leg relationships separately from the overall customer call.

Add admin-managed Dialpad company/office scope, permitted lines, shared SMS sender,
Front voice/SMS channel mappings and CRM/Front/Dialpad user mappings. Keep tokens
and webhook secrets server-side. Add durable Dialpad event receipts, replay
state and per-scope reconciliation progress. Configure the main line using its
verified provider IDs as well as +15082332261; do not route by display name alone.

Subscribe to the scoped call/SMS events. Dialpad documents delayed recording,
transcription and recap events. SMS content requires the applicable content
export permissions, and delivery-status events must be requested. See
[Call events](https://developers.dialpad.com/docs/call-events),
[SMS events](https://developers.dialpad.com/docs/sms-events), and
[Call transcript API](https://developers.dialpad.com/reference/transcriptsget).

Verify the documented webhook signature/JWT with the configured secret and bind
receipt processing to the expected subscription/company scope. Persist accepted
events before acknowledgement; process asynchronously with bounded retries and
audited replay. Deduplicate by provider, configured company, resource ID and
event identity/state. SMS status updates enrich one message rather than creating
new messages. Delayed summaries enrich one call without restarting deadlines.

Aggregate transferred/routed call legs before deciding a customer call was missed.
An agent who did not answer a ring is not evidence the whole call was missed if
another agent answered. Reconcile ambiguous or incomplete leg data and retain
visible uncertainty; do not issue one callback task per ringing teammate.

Use stable provider IDs to correlate Front and Dialpad where exposed. Before
enabling automatic correlation, verify real payloads expose the necessary
identifiers for each channel. A phone number and approximate timestamp alone
must not cause a confident merge; unresolved linkage stays in the review queue.
The CRM can retain a verified Dialpad activity with Front linkage pending.

Use scoped reconciliation with overlap/deduplication and provider rate limits.
Verify actual history/recovery endpoints, access and retention during setup;
do not promise unlimited historical replay. Detect gaps and processing lag.
An unresolved sync gap prevents automatic cleanup of potentially affected work.
When event-time data is recovered late, preserve original deadlines and record
the delay. Enrichment outages do not block minimal activity or task persistence.

Native Front remains the human SMS sender. This design does not add a second
automatic Dialpad SMS sender or replay sends while repairing CRM projections.
If a failed or ambiguous native send requires human retry, show its source status
and preserve the pending commitment; do not infer a response from send acceptance.

## 7. Setup, rollout and acceptance

Verify the four users and their actual individual business numbers, main-line
operators/routing, Front channel connections, user mappings, shared-line SMS
send/receive access, required API permissions and enabled AI/recording features.
Retain existing routing and recording settings unless a separate change is
authorized. Missing API access is a technical prerequisite, not evidence that
the user's Pro subscription automatically supplies every needed permission.

Use controlled test recipients and dedicated test configuration. Do not connect
staging subscriptions to all production business activity by default. Start
capture from a recorded activation point; avoid automatically backfilling the
entire phone history or generating historical overdue tasks. Any historical
import is explicitly scoped and reconciled with existing commitments.

| Scenario | Passing result |
| --- | --- |
| Main-line and individual-number calls | Correct activity, real actor and lead context; matching works for Front and Dialpad-originated calls |
| Individual-number SMS | API capture verified where authorized; no false promise of a native personal SMS channel in Front |
| Shared-line prospect text | Correct shared sender and selected recipient; one sent activity; failures visible |
| Same manager represents several HOAs | Explicit association selection; no blanket phone-number or SMS-thread assignment |
| Unknown caller | Visible triage with original time; no automatic sales lead for a carrier/client/vendor/spam call |
| Missed call and later voicemail/transcript events | One callback episode with original one-business-day deadline |
| One ringing agent misses, another answers | One overall answered call; no spurious callback per missed call leg |
| Prospect emails, calls and texts about one request | Earliest applicable deadline preserved; no duplicate escalation or loss of independent work |
| No answer or voicemail left on outbound attempt | Activity logged; existing commitment remains open and due date unchanged |
| Connected call or AI says resolved | Team confirmation required to complete work or change the next action |
| Confirmed phone outcome | Selected request completed with required successor/outcome; unrelated tasks preserved |
| Callback overdue by one business day | Champion escalation follows existing rules, deduplicated when both roles are Brian |
| Archive/snooze/status/handler change | CRM deadlines and salesperson/champion remain unchanged |
| Duplicate, out-of-order, transfer or replay events | One logical activity and correct final state without repeated tasks or sends |
| Front/Dialpad identifiers unavailable or ambiguous | Activity retained, linkage pending and visible; no guessed merge |
| AI/media disabled, delayed or inaccessible | Basic activity/callback works; honest availability state; no public recording exposure |
| Webhook outage or rate-limit backlog | Health alert, scoped recovery and original event-time deadlines |
| Sidebar context switch or unauthorized user | No cross-lead edit, credential leak or access inferred from provider identity |
| Human handling before scheduled AI email | Known substantive handling suppresses the unsent email; unanswered attempts do not falsely resolve the lead |

Validate these behaviors with representative real test payloads before enabling
automatic lead correlation or cleanup. Documentation and mocks alone cannot
prove connected-line coverage, transferred-call aggregation, media access or
the available Front/Dialpad correlation identifiers.
