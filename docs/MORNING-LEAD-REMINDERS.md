# Morning lead reminders — September 10, 2026

The user confirmed that scheduled reminders should arrive at 9 a.m. and clearly explain why a conversation has returned and what the agent or deal champion should do.

## Staff workflow

At 9 a.m. Eastern on business days, due lead work surfaces with a short internal Front comment: **Why this is back**, **Next step**, a brief **Original request** preview when available, responsible teammate, and the actual deadline. The sidebar shows the same explanation and a primary **Record outcome** button. The preview preserves an explicit request such as “please call me about the documents” without guessing that every text needs a text response. The staff member handles the request, records what happened, and sets the next follow-up. Safe inbox cleanup is requested automatically after that outcome.

New messages and calls still appear when they arrive. Scheduled reminders are separate from incoming activity. Original response deadlines and deliberate promises remain unchanged: an after-hours request can still be due at 5 p.m., but its reminder arrives at 9 a.m. that day. Unfinished work escalates to the champion at 9 a.m. on the following business date. This replaces the old escalation time of another eight staffed hours after the deadline.

## Implementation and recovery

- `reminderAt` separates the reminder schedule from `dueAt`. Follow-up, response, callback, carrier, document and custom tasks use the same morning scheduling policy. Dates before 9 a.m., weekends and holidays use the last available business morning before the commitment. Escalation is the next business morning after the due date.
- The minute worker processes a 9:00–9:09 Eastern batch, allowing ordinary processing delay. A missed batch or a provider retry outside that window waits until the next business morning. Work stays visible and becomes overdue against the original deadline. This is not an exact-second delivery guarantee.
- New same-day work created after that morning remains visible immediately; it does not generate an afternoon scheduled reminder. Actual inbound communication can still reopen its conversation immediately.
- A bounded, resumable migration updates 25 existing open tasks per tick without changing their actual commitments or clearing prior notification receipts. It repeats after a quiet hour to catch old in-flight writes during deployment, and reruns when the configured holiday calendar changes. Unchanged tasks are not rewritten. New writes and dispatcher reads use the same policy.
- Reminder comments and reopens use the existing durable outbox. The explanation must be confirmed before the reopen. Task completion, edits, reassignment, closure and superseding escalation suppress stale pending reminders. A lease checks both the current workflow and task versions. An ambiguous comment result is held for review rather than resent.
- Already queued legacy reminder reopens without explanations are retired. Existing tasks and their next morning escalation remain tracked.
- Human emails with custom promises, recorded outcomes and terminal lead transitions now request safe cleanup. Unanswered requests, uncertain sending, missing owners and synchronization guards still block archive. Old conversations with uncaptured history are a separate unresolved migration limitation.

## Verification

Automated coverage checks morning timing, unchanged 5 p.m. deadlines, DST, weekends, holidays, existing-task pagination, reminder explanation before reopening, stale task suppression, afternoon retry deferral, immediate new inbound activity, and cleanup after manual email/outcome/bind. The browser preview checks the real sidebar at 260, 340 and 440 pixels, including the outcome form.

Live 9 a.m. provider delivery must still be observed in staging after deployment; simulated test clocks do not count as live acceptance. Production rollout remains separate.

Repository checks: **2,052 tests across 105 files passed**, frontend and backend type checks passed, the CRM build and 156-page website build passed, and backend synthesis passed. Chrome verified the sidebar at all three preview widths and the outcome form. These checks do not establish live morning delivery.

The initial change (`1864eee`) deployed in CRM job **188** and website job **187**. A read-only staging check of TEST Cedar at approximately 5:34 p.m. verified its original September 10, 5 p.m. deadline was unchanged, its escalation and next queue time moved to September 11, 9 a.m., and its original 5 p.m. notification receipt remained intact. No new afternoon reminder was produced by migration. All seven open staging tasks had 9 a.m. Eastern reminder and escalation timestamps.

The final implementation (`aafe13f`, including the original-request preview and its account-scope guard) deployed successfully in CRM job **190** and website job **189**. The preview's 157 focused tests, CRM build, and backend type check passed; the final scope guard then passed 144 workflow tests and the backend type check. The full 2,052-test run above preceded those final focused changes.

After the final deployment, Chrome verified the actual TEST Cedar conversation in Front: **Why this is back**, the original request **“TEST: please call me about the documents.”**, **Respond to the prospect**, **Record outcome**, and the 9 a.m. reminder explanation all rendered together without opening activity history. A second read-only backend check confirmed that its original deadline, prior notification receipt, and next September 11, 9 a.m. escalation were still intact. No outcome was recorded and no prospect message was sent during this verification.

The first live morning comment and reopen remain to be observed. These staging checks do not establish production readiness, and `main` was not changed.
