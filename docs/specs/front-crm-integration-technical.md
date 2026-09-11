# Front + CRM integration: technical design and acceptance

**September 10 next revision:** Use [Sales, managers and carrier work](sales-carrier-workflow-revision.md) and its [confirmed business decisions](sales-carrier-business-decisions.md) for revised ownership, manager-to-owner escalation, annual incumbent-date rollover, outreach-attempt credit, reporting and routine task-entry behavior where they conflict with this earlier design. Those business policies are confirmed; implementation, deployment and live acceptance remain separate.

Implementation is now present in the repository. Deployment and real-provider acceptance remain pending; see the [rollout runbook](../COMMUNICATIONS-RUNBOOK.md). The design below records the reviewed requirements, not a claim of a live connection.
Companion to the [product specification](front-crm-integration.md).
Updated September 8, 2026. Service names below describe the reviewed design; the rollout runbook maps the implemented UI and operations.

## 1. Existing surfaces and planned changes

| Surface | Planned change |
| --- | --- |
| `web/src/lib/crmLead.ts` | One awaited, durable submission contract; stable retry identity; distinguish saved/pending from rejected |
| `web/src/components/quote/submission.ts` and quote submit caller | Replace FormSubmit send; preserve answer labels and complete source payload |
| `ContactForm.tsx`, `InstantAssessment.tsx`, `CoverageCalculator.tsx`, `AssociationLeadForm.tsx` | Use the common capture path; show success only after durable capture |
| `crm/amplify/functions/lead-intake` | Idempotent capture, responsibility exception, outbox entry, once-per-submission SMS dispatch |
| `crm/amplify/functions/lead-reply` | Existing timing/generation plus saved-conversation reply through Front; human-takeover suppression |
| `crm/amplify/functions/portal-sweep` | Keep document/extraction logic; replace standalone lead document notification with same-conversation internal note |
| `crm/amplify/data/resource.ts` and backend | Add workflow/communication records, indexes, queues, workers and scoped authorization |
| `crm/src/pages/Team.tsx` | Two admin-only eligibility controls, independent of access role |
| Lead/account pages and dashboard | Two responsibility selectors, task views, communication timeline and Front links |
| New `/integrations/front/sidebar` CRM route | Embedded authenticated sidebar with the same command handlers as the full CRM |
| New integration settings section | Front company/inbox/channel validation, user mapping, health and recovery controls |

Inspect and migrate all lead-creation paths, including manual entry, imports and
extractors. Default both lead roles to the configured teammate's verified user ID; preserve valid
explicit selections on authenticated creation/import. System capture exceptions
remain visible if the default cannot be applied. Account
conversion continues to happen through the existing bind workflow.

Unrelated login, invitation, licensing, invoice and other operational email
transports are outside this change. Front is the fixed transport for the
specified lead communication flow. Remove provider-switch code and do not add
a provider dropdown or `LEAD_EMAIL_PROVIDER` variable.

## 2. Proposed data contract

Use stable IDs, UTC timestamps, conditional versions and server-assigned audit
actors. Model names may follow repository conventions at implementation, but
the following responsibilities and invariants must survive.

| Record | Required contents and invariants |
| --- | --- |
| `LeadRoleEligibility` | One row per Cognito user ID; salesperson/deal-champion eligibility; changed by/time. Authenticated read, ADMIN-only mutation. Cannot be self-edited through ordinary profile writes |
| `LeadWorkflow` | One per account: salesperson ID, deal-champion ID, ACTIVE/LOST/DISQUALIFIED disposition for lead workflow, version, assignment audit, last inbound/outbound times, initial AI state. CLIENT/BOUND derived from existing account/quote data |
| `LeadFollowUp` | Account, action kind, responsibility role, assigned user, due time, OPEN/COMPLETE/SUPERSEDED/CANCELLED state, escalation time, reason, version, source message/action ID and a dedupe key |
| `LeadSubmission` | Submission ID, source/schema version, canonical answer snapshot, captured time, payload hash, account ID, provisioning state, Front intake operation ID. Restricted private retry-proof hash kept out of user-facing queries |
| `FrontConversationLink` | Environment/company/conversation/account IDs, purpose PROSPECT/CARRIER/OTHER, primary flag, link method, current handler, routing mode, canonical/old merged IDs, source submission ID, last sync and version |
| `LeadCommunication` | Account/conversation/message IDs, direction and source, author identity, recipients, subject, timestamp, actual-send state, failure/Seen status, last check, attachment references and source operation ID |
| `FrontOperation` | Deterministic operation ID, kind, aggregate/version, immutable request or protected payload reference, state, attempt count, lease, next attempt, UID/message/conversation receipts, safe error category |
| `FrontEventReceipt` | Company/event ID, event timestamp, received/processed timestamps, processing state and protected payload reference; unique company+event key |
| `FrontIntegrationConfig` | Per-backend company/inbox/channel IDs, allowed inbox set, expected sender, teammate mappings, last validation, rate budget and health. No provider selection or plaintext token |
| `LeadNotification` | Task/exception, recipient, notification kind and dedupe key, created/read timestamps; one notification per transition/recipient |

`LeadWorkflow` can be combined with additive Account fields if all updates still
pass the same server-side validation and concurrency rules. Do not add
unrestricted direct-write fields that bypass `setLeadResponsibilities`.
A separate eligibility record is preferable because UserProfile currently
allows people to update their own profile.

Resolve and verify the admin-selected default teammate's stable CRM user ID during
setup and require both eligibility flags plus an enabled Cognito account. Brian
is the intended production choice, not a name-based validation rule. The default
dropdown and server accept any active CRM teammate eligible for both roles,
including Jake in staging. Set both responsibilities as part of new-lead provisioning,
not in a later optional notification worker. Public callers cannot override
these defaults. An idempotent replay returns the existing lead without restoring
the default over a later team reassignment. An unavailable default is a visible
configuration/assignment exception; preserve capture instead of dropping the
enquiry or selecting an arbitrary teammate. Backfill only missing roles on
existing active leads with conditional writes that preserve concurrent edits.

Index tasks by state/due time and assigned user/due time; operations by state/
next-attempt time; communications by account/time and next receipt check;
conversation links by company+conversation and account; submissions by their
unique ID and provisioning state. Use pagination everywhere. Timed workers
query due indexes rather than scanning every lead and message as volume grows.

Role eligibility affects selection only. Apply existing CRM authorization to
account data and normal actions. Do not add owner-scoped read restrictions or
new permissions through these two roles. Eligibility settings and integration
configuration remain ADMIN-only writes. `LeadReply` and `UploadPortal` contain
bearer credentials and remain restricted; user-facing communication data is a
separate projection containing no upload tokens.

When audit coverage is needed, extend the existing activity stream/handler
intentionally. Do not write a second uncoordinated account-history ledger.
System changes have named actors; user mutations derive their actor from the
validated session, not from an argument supplied by the browser.

## 3. Durable public intake

The common request includes source/form version, a cryptographically random
submission ID, contact/property fields, a typed source-answer object, and a
separate high-entropy retry proof. The browser retains that identity for retries
of the current submission. An intentional new enquiry gets a new identity.
The server enforces source allowlists, size limits, field validation and payload
hash equality for a repeated ID. A changed payload under an already committed
ID is a conflict, not an overwrite of an existing lead.

The submission ID can appear in the Front intake record for correlation; it is
not an upload credential. Store only a retry-proof hash privately and require
proof when returning sensitive resume/upload data for a duplicate request.
Knowing a submission ID or an email address must not reveal an upload token.
Do not place retry proofs in analytics, log output or the Front message.

Allocate deterministic internal IDs for the submission's account/contact/window
and persist the submission plus its work item before acknowledging success.
Use a real conditional transaction for the required capture records; several
independent GraphQL writes do not constitute a transaction. Optional projections
such as carrier details may run as idempotent repairable steps from the saved
snapshot. Public input cannot assign staff, supply a Front destination, choose
a pipeline state or update an arbitrary existing account.

The response distinguishes `received`, `duplicate_received` and rejection.
A received submission may have Front work pending. Return the same permitted
account/upload context on a verified retry; do not create another account,
contact, SMS dispatch or initial reply. If provisioning is asynchronous, return
an opaque receipt and a bounded, proof-protected resume path for upload readiness.
Preserve form answers when capture fails. Rate limiting/abuse controls remain
server-side so removing FormSubmit does not turn the endpoint into an unrestricted
email relay. API credentials stay server-side.

## 4. Exact Front conversation construction

The selected path uses the existing shared email inbox and its connected email
channel; no custom messaging channel is needed for initial outreach.

1. Create an intake import operation for the captured submission. Its stable
   external ID and import thread reference include environment and submission ID.
   Set the record open and explicitly skip existing Front rules for imported
   intake; CRM routing owns this import. Represent it as an inbound website
   submission using validated contact details, with a clear source heading.
2. Resolve Front's acceptance UID to the created message/conversation, then save
   the canonical link before any AI send is allowed.
3. Reply through the saved conversation with an explicit sales channel, explicit
   prospect recipient and empty extra-recipient lists. Brian remains the named
   sender. Supply only approved customer-facing content, omit internal quoted
   history, and apply one signature.
4. Resolve the outbound acceptance to the actual message. The sent time starts
   follow-up scheduling. Keep the conversation open until the archive invariants
   in the product specification hold.

Front documents the import endpoint's duplicate external-ID handling and
conversation targeting; the API contract is in its
[official Core API specification](https://github.com/frontapp/front-api-specs/blob/main/core-api/core-api.json).
The service calls [Import message](https://dev.frontapp.com/reference/import-inbox-message)
and [Create message reply](https://dev.frontapp.com/reference/create-message-reply).
The import thread reference is scoped to imports, so the AI reply uses the
resolved conversation ID, not an invented cross-endpoint threading reference.

Imports must not fire an unrelated Front rule that sends a second acknowledgement.
Review rules for both imported intake and real outbound/inbound email at setup.
A verified test must confirm empty quoted history, recipient isolation, shared
channel routing, and that a real recipient reply returns to the expected thread.
Preserve a stable customer-appropriate subject through the initial conversation;
subject text is never a database relationship key.

No-email or invalid-email captures remain in Needs contact correction and Needs
assignment as appropriate. Preserve the raw submitted value in the protected
intake context. Do not invent a customer address or send an AI email. Once
corrected by a team member, explicitly prepare its Front conversation and initial
reply, with an audit entry and the same submission identity.

Separate submissions by different associations sharing one contact stay separate.
Linking a later enquiry to an existing account is explicit and does not overwrite
previous form answers. One account can have several linked conversations. A
carrier conversation remains separate from the prospect conversation even when
both belong to the same lead; carrier-only notes must not be sent to the prospect.

Support Front's documented merged-conversation redirects by resolving the new
canonical ID and updating the mapping. Do not forward a bearer token to an
arbitrary redirect host, and do not convert a redirected POST into an accidental
GET or duplicate send. Detect cross-account link conflicts for review. The
architecture does not depend on a public conversation-merge operation.

## 5. Sending, idempotency and outage behavior

Proposed operation states:
`READY → LEASED → ACCEPTED → CONFIRMED`, with `RETRY_WAIT`, `UNKNOWN`, `FAILED`
and `SUPPRESSED` branches. State transitions use conditional updates; leases
have expiry and a fencing/version token. Timed workers cannot claim the same
logical send independently. Persist the final rendered content before sending,
so retries never regenerate a materially different email accidentally.

| Result | Required handling |
| --- | --- |
| Work captured but Front unavailable before a send attempt | Retain queued work; retry reads/preflight safely; show delay |
| Import accepted | Save UID immediately; resolve with GET; reuse external ID on safe reconciliation |
| Outbound reply accepted | Save UID immediately; do not claim delivery/read; resolve with GET |
| Explicit 429 | Honor Retry-After and shared rate budget; retry the same immutable operation |
| Definite validation/permission rejection | Visible failed operation with corrective action; no regeneration loop |
| POST timeout, disconnected response or ambiguous server error | UNKNOWN; reconcile; no blind resend or SES fallback |
| Receipt saved but CRM projection fails | Retry projection only, not the send |
| Worker stops after sending but before saving receipt | Preserve uncertain operation; inspect Front; never reclaim as an unsent READY operation |
| Later Front delivery failure | Update communication health, stop relying on the contact's reply clock and create a delivery-correction task |
| Prospect/human reply before pending AI send | SUPPRESSED with source message and reason |

Front's asynchronous message UID flow is documented in
[Messages](https://dev.frontapp.com/reference/messages) and
[resource aliases](https://dev.frontapp.com/docs/resource-aliases-1).
A sent message is not guaranteed delivery; later failures arrive separately.

For an uncertain import, use its saved UID when available. If the receipt was
lost, reconcile using the exact non-secret submission marker in the imported
body and the permitted inbox. Accept a match only after verifying its marker,
source and account correlation. Validate duplicate-import response behavior
against the actual account during the initial integration test. Multiple or
unverifiable matches stay in the human review queue; never change the external
ID to force another import.

For an uncertain outbound send, reconcile against the known conversation and
saved recipient, content, author and attempt interval, preferring the UID and
webhook receipt. An ambiguous match requires an admin/operator decision with
a recorded reason. Do not claim mathematically exact-once email delivery from
an API that does not document an outbound idempotency key.

Before sending the AI email, refresh the latest conversation activity and check
a local human-takeover flag. Expose **Handle personally / cancel AI reply** while
it is scheduled. Human sends already observed suppress it. A simultaneous native
Front send and API send cannot be locked by a CRM database transaction; detect
and surface that narrow race, and do not promise a stronger guarantee.

Operational thresholds proposed for review: pending intake notification over
five minutes, pending initial email over fifteen minutes beyond its eligible
send time, and any UNKNOWN or permanent rejection appear in Communication
issues. Emit one deduplicated admin notification per incident, not one per
retry. Normal CRM intake remains available while delivery is delayed.

A pause control may stop outbound dispatch while retaining captured work. It
is an operational pause, not an email-provider switch. Recovery drains queued
work after reconciliation. A deployment rollback preserves identifiers and
never replays historical sends as new submissions.

## 6. Event ingestion and reconciliation

Create a private Front application with a signed application webhook and sidebar
feature. Validate the signature using the raw request body, timestamp and app
signing secret, and check the expected Front company. Store/enqueue an event
before returning success. Verify the setup challenge separately. Process events
asynchronously within a per-company/per-conversation ordering strategy.

Deduplicate by company+event ID. Reject stale state changes using source event
ordering and record version; if ordering is ambiguous, fetch current Front state
instead of guessing. Only process configured inboxes and linked conversations.
New unlinked eligible enquiries enter a linking/assignment queue, not automatic
matching by sender alone. Exclude unrelated business inboxes visible in Jake's
Front workspace.

Handle inbound, outbound, delivery failure, assignment, archive/reopen, snooze,
move, tag/link and delete/restore events as required for routing and canonical
link maintenance. Imports generated by the integration must be recognized as
intake events, not a second customer reply that cancels the initial AI response.
Own outbound/system actions must not echo indefinitely between CRM and Front.

A periodic reconciler repairs gaps, expired leases and missing projections.
A durable failure queue supports bounded retry and audited replay. Poll scoped
changed conversations/events using a persisted cursor and overlap window;
deduplication makes the overlap safe. Alert on a disabled webhook or unhealthy
processing lag. Front's finite retry and acknowledgement behavior is documented
in [Application webhooks](https://dev.frontapp.com/docs/application-webhooks).

Archive commands include the version/activity watermark they were based on.
Revalidate before dispatch, and compensate by reopening if a newer inbound event
races the operation. Task completion, message-seen status, Front archive status
and account disposition are separate states.

Front also exposes a dedicated
[conversation reminder endpoint](https://dev.frontapp.com/reference/update-conversation-reminders)
for scheduling/cancelling snoozes. Its shared-inbox behavior differs from private
conversation behavior; current conversation data includes scheduled reminders.
Do not use a task-conversation due-date field as an email snooze. The confirmed
policy is to observe both personal and shared snoozes without changing CRM
deadlines. A business-date change must use the validated CRM/sidebar mutation,
retain the prior date in its audit, and recalculate future notifications using
the new action version. Snoozing, cancelling a snooze and archiving never
complete, postpone or cancel a CRM task. A later snooze expiry also cannot
replace the CRM's authoritative due date.

## 7. Follow-up engine and Seen synchronization

Use one durable follow-up per logical prospect-wait episode, keyed to the
confirmed outbound message. A later substantive outbound supersedes that episode
unless a team-entered commitment explicitly preserves its date. An inbound
human reply supersedes it and raises response work. Duplicate events cannot
schedule multiple tasks. Uncertain automatic-response classification surfaces
for review; do not hide new inbound activity based on a guess.

The due dispatcher checks current task version, lead disposition, assignments,
latest message state and any custom commitment before notifying. It creates
one salesperson notification at due time and one champion escalation at the
next overdue business date. Same-person roles share one notification with an
escalation update. Reassignments preserve deadlines and redirect future notices.
A permanently unassigned action remains in team/admin exception views.

Automatic assignment to Brian supersedes the proposed one-day assignment-gap
alert. If that default cannot be applied, expose a configuration exception and
deduplicate its admin notification per incident; do not hide the lead or keep
attempting to assign an unavailable user silently.

Track unanswered-inbound episodes independently of the outbound no-response
episode. Their deadline begins at the oldest outstanding substantive prospect
message; later inbound messages do not restart it. The confirmed target response
interval is **one business day**, using the staffed-time calendar defined in the
product specification. Deduplicate alerts by episode, notification kind
and recipient, and check current assignments/message state before dispatch.
Initialize the response target in workflow settings to one business day.

Completing a prospect task requires either a successor action, a dated waiting
commitment or terminal outcome in the same validated mutation. Champion tasks
may be independently completed when done. A no-op comment or Seen event never
resets the prospect's follow-up. Read views distinguish upcoming, due, overdue,
escalated and cancelled tasks without converting all of them into new emails.

Proposed Seen schedule: check new outbound email after confirmation; recheck
eligible recent messages every fifteen minutes for the first two days, then
hourly through day fourteen. Stop automatic checking after a substantive reply,
terminal outcome, or the tracking horizon. On-demand refresh is rate-limited.
This schedule is subordinate to the company's shared API budget, never a promise
of an immediate receipt update. Cache last successful fetch separately from
receipt absence and API failure. Support recipient-specific or anonymous signal
data without inferring unavailable identity.

The documented application webhook event list has no Seen event. Use the
[Seen API](https://dev.frontapp.com/reference/get-message-seen-status), not a
fabricated webhook subscription. Honor company-wide budget and rate headers;
reserve capacity for intake and replies ahead of optional receipt refreshes.
See [Front rate limits](https://dev.frontapp.com/docs/rate-limiting).

## 8. Sidebar/backend operations

These names describe proposed shared service operations, not deployed endpoints.

| Operation | Behavior |
| --- | --- |
| `frontSidebarContext` | Given a conversation context, return authorized account summary, both roles, tasks, quote/document summaries and sync status; no credential-bearing models |
| `setLeadResponsibilities` | Validate active eligible selections; save both roles atomically with expected version; move role-based tasks; audit routing decisions |
| `saveLeadFollowUp` | Add/change action, role and date with expected version and reason; preserve custom commitments |
| `completeLeadFollowUp` | Complete or supersede with reason and required successor/outcome; fail visibly on stale version |
| `linkFrontConversation` | Explicit account/conversation/purpose selection; verify permitted inbox/company; prevent conflicting automatic relinks |
| `setFrontConversationHandler` | Set current handler or return to role-based routing without silently changing lead roles |
| `cancelInitialAiReply` | Cancel unsent work conditionally; explain if already accepted/sent; never claim a sent email was recalled |
| `addLeadInternalNote` | Save an auditable CRM note and enqueue its Front internal-comment projection with a stable operation ID |
| `saveFrontAttachment` | Verify linked message and access; copy chosen attachment into the existing document ingestion path with source IDs and duplicate prevention |
| `refreshFrontCommunication` | Queue a bounded refresh; return cached state and freshness while work runs |
| `updateLeadRoleEligibility` | ADMIN-only settings update; does not alter access roles or remove existing lead assignments |
| `validateFrontConnection` | ADMIN-only company/channel/inbox/permissions checks; return health, never the token |

Internal notes use Front's [Add comment](https://dev.frontapp.com/reference/add-comment)
operation and remain distinct from prospect messages. Failed comment projection
cannot become an outbound email. Attachment downloads are authorized server-side;
do not expose expiring Front download links broadly or refetch arbitrary URLs
supplied by a sidebar client.

Authenticate the embedded UI through the existing CRM identity system with a
supported external sign-in/resume handoff if the iframe cannot complete login.
Do not assume a Front teammate ID supplied by client-side context is a trusted
Cognito identity. Match Front users to CRM users through admin-confirmed mappings.
The backend enforces the same account/action permissions as the main CRM.

Validate framing/CSP and supported Front origins without weakening framing rules
for unrelated CRM pages. Use SDK context change events and discard stale
responses. SDK navigation opens the main CRM; no raw tokens in URLs or browser
messages. Complete a staging login/context-switch test before treating the
sidebar as ready. Background syncing runs in workers, not in the user's open tab.

## 9. Migration and operational setup

- Inventory all five form entry points, manual/import lead creation, Front sales
  channels, inbox rules, subscribers, current snoozes and existing AI replies.
- Admin configures a default teammate eligible for both roles, with Brian as the
  intended production choice. New leads use that selected teammate; migration fills only missing roles on active leads and
  preserves existing explicit assignments. Show coverage and exception counts.
- Link historical conversations using verified IDs and review ambiguous matches.
  Preserve prior snooze commitments as reviewed CRM dates before clearing them.
- Inventory prior SENT/FAILED/SENDING LeadReply rows so cutover cannot issue a
  second initial email. Retain existing upload links and uploaded documents.
- Configure a distinct test inbox and sender in staging. Verify the actual
  channel's sender and company against settings; reject production mappings in
  staging and prevent test recipients/routing from leaking into production.
- Validate necessary scopes for channels/messages, conversations, comments,
  teammates, events and any configured tags/links. Grant only endpoints used;
  never send Front credentials to the website or sidebar.
- Remove FormSubmit calls, constants and dependencies only with the tested
  durable capture cutover. There is no steady-state double delivery or SES
  fallback for initial lead email. Coordinate frontend and backend releases.
- Observe the pilot until capture, sending, thread linking, assignments, reply
  syncing, due actions and exceptions all reconcile. Only then archive legacy
  reminders whose CRM commitments have been verified.

## 10. Dialpad extension

[Dialpad + Front + CRM](dialpad-crm-integration.md) specifies the confirmed
main-line/individual-number tracking scope, shared-line prospect SMS, one-business-day
callbacks, cross-channel request handling, additional activity/source mappings,
event recovery, and channel-specific acceptance criteria. It is part of this
integration's design and remains unimplemented. Use its call/SMS handling rules
alongside the email rules above; a call attempt or delivery receipt alone cannot
complete a prospect request or restart its deadline.

## 11. Acceptance matrix

| Scenario | Passing result |
| --- | --- |
| Every website form and wizard branch | All existing useful answers survive; one saved lead and a source-labelled intake record |
| Double click, network retry or repeated same request | Same committed submission/account; no duplicate contact, SMS, conversation or AI email |
| Same submission ID with changed answers or wrong proof | Rejected/conflict without leaking upload access or changing the original |
| Different associations share a contact email | Separate leads/conversations unless explicitly linked by the team |
| Invalid/missing prospect email | Saved lead with contact-correction work; no fabricated recipient or send |
| Front down while website succeeds | Durable capture and visible queued notification; no false unsaved state or fallback email |
| Database capture fails | Form retains values and displays retry; no success conversion event |
| Imported intake then AI email | Same verified Front conversation, correct recipient, Brian/sales sender, one signature, no internal quoted content |
| Prospect replies from an external email client | Linked inbound activity, Needs response, obsolete no-response task superseded |
| Manual human handling before AI | Scheduled AI suppressed; no redundant email after observed human reply |
| Near-simultaneous native Front and AI send | Race detected and surfaced; no false exact-once guarantee |
| Definite send rejection / 429 / ambiguous POST / late bounce | Correct failure branch and visible corrective work; no blind duplicate or SES fallback |
| Process exits after external side effect | Receipt reconciliation/projection recovery; lease expiry does not resend an uncertain operation |
| Duplicate or reordered webhook event | One logical change/task/notification; newer state preserved |
| Webhook disabled or delayed | Health alert and scoped reconciliation repair; no silent divergence |
| Two roles assigned to same person | Valid assignment and no duplicate reminder/escalation |
| Team member changes eligibility | New dropdown choices change; access and existing assignments remain intact |
| Non-admin attempts eligibility/config write | Server rejects it; normal lead access unaffected |
| User deactivated with active leads | Clear reassignment exceptions and retained deadlines/history |
| New lead created without explicit authenticated selections | Both responsibilities reference the configured default teammate's verified user ID |
| Team reassigns either role | Both roles remain valid; audit recorded; pending due work transfers without deadline reset |
| Submission replay after team reassignment | Existing responsibility selections survive; retry does not reset them to the default |
| Configured default cannot be applied | Lead captured with visible assignment/configuration exception; no auto-archive or arbitrary replacement |
| Migration fills missing roles | The configured default fills only empty values; existing/concurrent explicit assignments remain intact |
| Prospect sends several messages before the team replies | One response episode retains the deadline from the first unanswered message |
| Prospect reply remains unanswered for one business day | Response task becomes overdue; no automatic customer email; later messages or Front cleanup do not extend the deadline |
| Front assignee changed manually | Current handler changes; salesperson/champion remain unchanged |
| Friday send, weekend, holiday, DST and exact callback date | Specified business-day/UTC schedule and explicit overrides honored |
| Deadline followed by one overdue business day | Salesperson reminder then champion escalation, once each |
| Reply races reminder/archive | Stale reminder suppressed; conversation reopened if needed; no lost response task |
| Manual Front snooze/archive | CRM obligations remain; explicit CRM date change required to move the business deadline |
| Personal or shared snooze scheduled beyond a CRM deadline | CRM reminder/escalation still occurs on its original schedule; cleanup cannot postpone the commitment |
| Later website documents arrive | Existing conversation receives grouped internal update; no new notification thread |
| Carrier conversation linked | Champion context/tasks shown; no carrier-only content enters the prospect email |
| Front thread manually merged | Canonical mapping repaired or conflict surfaced; no send to an unrelated account |
| Sidebar no/single/multiple selection and rapid switching | Correct context, no stale edits or cross-account response rendering |
| Sidebar session expired or unauthorized | Sign-in/access state; no sensitive data or mutation through Front context alone |
| Sidebar and CRM edit concurrently | Version conflict shown, no silent overwritten responsibility/date |
| Receipt unavailable/anonymous/proxy-generated | Honest signal/freshness display; no task completed or identity invented |
| Archive from shared and personal views | Actual Front behavior documented; no claim all subscribed copies vanished |
| Migration and deployment rollback | Existing replies/documents/IDs preserved; zero historical AI resends |
| Large backlog or API rate-limit contention | Indexed/paginated work, intake prioritized, bounded retries and visible backlog age |

Required engineering checks include meaningful unit/state-machine tests,
backend type checks and synthesis, form integration tests, authenticated UI
checks, and an authorized live test through the actual staging Front channel.
A mock-only result does not verify tracking pixels, email-provider threading,
Front inbox rules or embedded login.
