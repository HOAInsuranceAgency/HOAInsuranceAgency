# Communications review remediation — September 9, 2026

This records the findings supplied in the September 9 review and the implementation response. It does not independently verify the review's agent count, token usage or unpublished findings. No deployment or live customer communication was performed.

| Finding | Implementation response and verification |
| --- | --- |
| Reconciliation duplicates the 24-hour call window | Dedupe keys use the call ID and canonical provider snapshot hash. A multi-tick test proves unchanged calls produce one event, while late changes produce another. Repeated MISSED snapshots preserve the completed lookup state. |
| Transaction cancellation treated as duplicate | Only explicit conditional failures qualify as optimistic conflicts. Webhook acknowledgement requires a verified durable receipt after any failed write. Tests exercise throttling, transaction contention, duplicate delivery, missing reasons and mixed reasons. |
| Independent website/backend deployment race | New schema arguments remain optional for cached clients. Website deployment waits for a skipped GraphQL contract probe and a non-writing handler/table readiness check before publishing. A failed/incompatible backend leaves the old site deployed. Tests validate both schemas and prove the probe never runs the resolver. |
| Changed answers reuse a failed submission identity | Persisted retry state includes exact answers. Unchanged retries/reloads reuse the proof; changed answers get a new identity. Double clicks coalesce. The client waits 40 seconds. A changed enquiry can coexist with an earlier attempt that already arrived; this is not an amendment API. |
| Failed account read cancels live work | Missing/error account reads throw without closing the task. Worker-level tests prove the due row and OPEN status survive. |
| Twelve lifetime failures remove deadlines | Tasks retain their dispatch schedule without a retry-count cutoff. Rate limits do not consume attempts; delayed processing raises an issue; successful notification resets attempts. Tests run more than twelve failures and then recover. |
| Cancellation races with send preparation | EMAIL lease acquisition includes a workflow version condition. A cancellation during Front preflight prevents the POST. An already leased send remains explicitly non-recallable. |
| Front 401/403 fails the queue | Pending operations retry after credential repair and surface an authorization issue. Tests cover both responses. |
| Producer marks FAILED after durable enqueue | The producer checks the outbox on failure and never recommends another initial reply for queued work. Conditional status projection cannot overwrite a worker's SENT state. Tests execute the actual producer with each race/failure. |
| Past promises / near-simultaneous escalation | Manual promises require a future date. Late-linked requests keep the original clock; already-escalated work notifies both roles together, with one notice for a shared owner. Tests cover deadline preservation and delivery. |
| Dialpad transfer splitting / wrong number fallback | Master IDs take precedence; persistent provider aliases preserve relationships on later partial events. Inbound fallback uses the destination business number. Missing line/direction is an error; excluded lines retain a reason. Tests cover transfer ordering and real missed-call-to-callback projection followed by an answered leg. |
| Global communication-body enumeration | Removed the unsupported COMMUNICATION work view. Account context and explicit single-activity review remain available. Authenticated rejection is tested. |
| Linking omits earlier messages | Linking queues bounded conversation-history backfill. Existing unlinked projections gain accountId/accountSort and resolve their linking issue; original dates are retained. History before activation is still outside automatic capture scope. |
| Work views filter only one global page | Matching occurs on the server across bounded source pages, with view and ownership filters. An unfinished search always returns a cursor and explicit continuation UI. Tests find a callback after 120 unrelated tasks. |
| Audit records never reach account history | Writes now use the existing Activity model in the same transaction as the business change. No second AUDIT ledger is created. Real call-outcome tests verify Activity persistence. |
| Transactions exceed 100 writes | Responsibility commits schedule bounded role-sync batches. Task completion no longer includes unbounded former-assignee notifications; notification reads retire those stale records. Tests cover 120 tasks and 120 historical notices. |
| Rejected attachment leaves empty document | The complete download and host/size checks precede document creation. Unsupported redirects are tested against the actual importer. |
| Document-arrival notification lost while unlinked | Not reproduced in the supplied working tree: it already queues a durable COMMENT before marking the portal batch. A new test proves paused and unlinked comments remain retryable. Sweep reporting now says queued, not sent. |
| QUEUED initial reply absent from owner alarm | Added QUEUED to the stalled-reply detector, with a regression test. QUEUED remains pending, not sent. |
| Cleanup checkbox reset on resume | Originally preserved on resume; superseded September 10 by always-automatic cleanup with no separate setting. |
| Weak concurrency assertions | Exact assignment assertions replace the cross-file wildcard match. The backend synthesis gate verifies resolved reserved concurrency for the worker, lead-reply and portal-sweep functions. |

The shared worker's reserved concurrency remains one. The review withdrew that finding, and it is independent of the retry/capture defects fixed here.

New regression coverage executes the worker dispatcher and scheduled handler, Front ingestion/classification, Dialpad aggregation and callback projection, review commands, attachment importer, producer, website retry controller and deployment probe. Provider services are controlled test doubles; live payloads, scopes, channel routing, iframe headers and email tracking still require the [rollout acceptance checks](../COMMUNICATIONS-RUNBOOK.md).

Relevant primary references: [AWS transaction cancellation reasons](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html), [Dialpad call events and call flow relationships](https://developers.dialpad.com/docs/call-events).

## Repository verification

Initial September 9 verification: **1,888 tests passed across 97 files**; CRM frontend/backend type checks passed; website type checks passed with no errors or warnings; CRM production build passed; website production build passed (156 pages); backend synthesis and its concurrency assertions passed; `git diff --check` passed. The CRM build retains its bundle-size advisory, and the website checker retains six existing hints.

The build-readiness probe was tested with controlled schemas and responses. It has not been exercised against a real in-progress Amplify deployment. Live rollout and provider acceptance remain pending.

## Second review: corrections and verification

The second supplied review identified two defects in the first remediation. Both were reproduced in the code and corrected. Its published agent totals and unseen findings are not independently verified here.

| Finding | Correction and regression evidence |
| --- | --- |
| Readiness query dispatched through absent `event.info` | `leadIntakeReady` requires `readinessContract: 1`; the Lambda dispatches on that argument. The website probe sends it. A non-writing test invokes the generated resolver shape (`arguments`, `identity`, `source`, `request`, `prev`), with no `info`. |
| Transfers only deduplicated when the linking event arrived first | Known provider relationships now union previously captured call records atomically, retaining raw source records as redirects. Connected legs win over missed legs; association links, earliest timestamps and call details survive. Durable repair jobs collapse duplicate automatic callbacks in bounded batches and retain the earliest deadline. Strong reads of known callback keys avoid depending solely on the account index. Tests capture both legs first, in both orders, then supply the relationship/answered event; they also preserve custom promises and reject conflicting association links with a visible issue. |
| Failed verification prevents callback projection | A failed Dialpad lookup still projects a known missed call into callback work, preserves its original deadline, records an issue and retries verification. Successful verification resolves that issue. |
| One provider or malformed record traps reconciliation | Front and Dialpad capture independent bounded pages. Front conversations receive separate replayable jobs; message projection failures retain durable item receipts. Malformed items are parked visibly. Dialpad stores each valid event before checkpointing; a failed capture cannot advance its cursor. Tests cover Front 429 alongside valid Dialpad history, a malformed item between valid calls, capture failure/recovery, and malformed Front history. |
| Transient AWS error permanently fails unsent email | Explicit transaction contention/throttling is retryable before sending. A persistence failure after a non-idempotent external send remains UNKNOWN; it cannot trigger an automatic duplicate. Both sides of that boundary execute in regression tests. |
| Concurrent reminder retirement creates transaction conflicts | Retirement is sequential. Verified stale notices are excluded even if retirement meets transient contention, and the remaining durable notice is retried on the next read. The test measures in-flight transactions for 50 reminders sharing one workflow. |
| Expired mailbox and preflight authorization failures | Invalid mailbox authorization raises a recoverable provider error. Operation failure counts include preflight failures, using exponential delays capped at one hour. Shared provider authorization cooldowns prevent every queued item from probing the same broken token; changed credentials bypass the old cooldown for validation. Mailbox cooldowns are separate so mailbox repair does not suspend unrelated Front ingestion. |
| Last legacy settings AUDIT write | Settings and standard Activity metadata commit together. Credential update intent and completion record field names only; values stay in Secrets Manager. Tests assert transactional Activity capture and absence of credential values. Secrets Manager and DynamoDB remain separate systems: a failure between them leaves the credential-update intent for operator review. |
| Re-linking restarts full history walk | Saving an unchanged association/purpose link is a no-op. The link backfill has one stable job identity; repeated linking does not reset its completed cursor or overwrite manual routing. |
| Worker budget exit skips health/reconciliation | Each tick gives both providers a bounded reconciliation opportunity before draining due work. The due loop stops at 75 seconds, leaving time for an in-flight operation and health persistence within the 120-second Lambda limit. Budget exhaustion exits through health finalization. The backlog regression checks a fresh heartbeat and reconciliation invocation. |
| Sidebar purpose and blank settings placeholder | Conversation changes reset the purpose and draft state; repeated updates for the same conversation preserve current edits. Pending settings show a loading explanation when the error string is empty. Both behaviors have UI tests. |
| Producer regression mock enforces its own guard | The mock now evaluates the actual condition supplied on the status update. Removing the SENDING condition permits the incorrect overwrite and fails the SENT-race assertion. |
| Concurrency constraint lacked explanation | The infrastructure now documents why reserved worker concurrency must remain one. The existing synthesis assertion still checks the resolved value. |

Second-pass repository verification: **1,910 tests passed across 97 files**; CRM frontend/backend and website type checks passed; both production builds passed (website: 156 pages); backend synthesis passed; `git diff --check` passed. Existing bundle-size advice and six website checker hints remain.

These are local repository checks with controlled provider responses. Neither this pass nor the earlier pass deployed, activated the integration, or sent customer messages. A real Amplify cutover and the connected Front/Dialpad acceptance matrix remain required. Call records can only be combined after Dialpad supplies a relationship; contradictory association links stay visible for explicit review rather than being guessed.


## Third review: history recovery and bounded repair traffic

The supplied third review confirms the original blockers, call unions, redirect boundaries, worker ordering and provider isolation. Its accidental scratch harness was already removed by its author; no such file was treated as an implementation defect here.

The three requested corrections are implemented:

1. Stable conversation jobs can be restarted after their retry cap. Re-saving an unchanged link repairs missing workflow/conversation binding and missing or failed history without overwriting manual routing. Healthy completed jobs remain unchanged. Admins also have an explicit conversation-history restart for both link and periodic jobs.
2. Admins can restart either provider's reconciliation cursor in Settings. This clears pagination only, retains the unfinished capture window, and checks the stored cursor version in the same transaction as Activity auditing. Previously captured records deduplicate normally. Neither reset can retry outbound delivery.
3. Periodic Front history walks wait 30 minutes after a successful completion before starting again. Active jobs keep their cursor; failed jobs require deliberate recovery. A shared history reset helper gives the two conversation job entry points the same rules without rewriting the unrelated delivery state machine.

The website readiness probe now stops after 20 minutes so it can report its own dependency failure within the hosting build budget. Regression coverage executes capped-job failure and recovery, unchanged-link repair, expired-cursor recovery, access/version checks, repeated reconciliation cycles, both UI recovery actions and the timed deployment wait.

Third-pass repository verification: **1,920 tests across 97 files**, CRM frontend/backend and website type checks, both production builds (website: 156 pages), backend synthesis and `git diff --check` all passed. The staging rollout outcome is recorded separately in the runbook. No additional broad review round is planned; the next evidence should come from controlled staging traffic.
