# Front / Dialpad browser test results — September 9, 2026


## Current acceptance summary

Updated during the continued session, approximately 11:21 p.m. Eastern. **The initial AI email works in staging. Full rollout acceptance is not complete.** The earlier session notes below are historical; this table incorporates the later tests and fixes.

- Four initial AI emails sent to the authorized test prospect: the full quote, assessment with document, HO-6 enquiry, and coverage calculator. Each uses Brian Cole and the staging sender, in the same Front conversation as its imported form. The Contact fixture's email was deliberately canceled and remained suppressed after reopening.
- The AI email's Seen signal synchronized to the CRM. A real inbound test text was captured, held for an association decision, linked, and given a one-business-day response commitment.
- Reminder delivery, Front reopening despite a later snooze, pause/resume, explicit task outcomes, merging related requests, disqualification/reopening and a fictional bind were exercised through the UI.
- Raw teammate IDs are replaced with names. An additional discovered phone-activity ID display was fixed, with formatted numbers and meaningful text previews.
- Two functional defects discovered during acceptance were fixed and retested: successful delivery clears its own stale warning; verified imported forms no longer create false prospect-response tasks. Imported form HTML no longer renders as literal markup.
- **Still requires live acceptance:** a true external email reply, missed-call/voicemail and other business-line cases, another authorized teammate, actual business-day escalation, and cleanup after the reply/callback prerequisites. No production rollout occurred.

### Walkthrough coverage

“Pass” applies to the stated scenario. “Partial” means part of the walkthrough still needs evidence. Automated tests do not substitute for the missing live cases.

| # | Feature | Result and remaining coverage |
| --- | --- | --- |
| 01 | Test contacts/settings | Pass: authorized email/mobile, sender, Jake defaults and cleanup off. |
| 02 | Native connections | Partial: email delivery, Seen, two-way shared SMS, Jake's outbound call and signed receipts passed. Main-line inbound call pending. |
| 03 | Controlled activation | Pass: staging activation and later resume through the settings UI; no security gates removed. |
| 04 | Roles, defaults, protected IDs | Pass for Jake and the tested mappings. Invalid edits blocked; Cancel preserved values; role selections and defaults worked. Two-person behavior pending. |
| 05 | Initial AI email/threading | Pass: four authorized AI sends; intake and initial email share each conversation. |
| 06 | Initial document upload | Pass for PDF: received, OCR completed, extraction displayed evidence, AI email reflected the fictional document. Photo/spreadsheet and all timeout variants pending. |
| 07 | Five intake forms | Pass for capture across full quote, assessment, Contact, HO-6, calculator. Contact AI deliberately suppressed. Calculator retry produced exactly one account and one email. |
| 08 | Retry/interruption | Partial: a real first calculator failure recovered on unchanged retry, with one account. The first failure's cause was not established. Reload, changed-answer and injected interruption variants remain untested live. |
| 09 | Internal lead SMS alerts | Blocked: Jake has no internal-alert mobile configured. A completed no-recipient operation is not evidence that an alert was sent. |
| 10 | Seen | Pass: Cedar's AI email had a Front Seen signal at 10:35 p.m., reflected in CRM; checking it did not move the commitment. No-signal state also rendered accurately on test hoa. |
| 11 | External email reply | Pending: the earlier reply came from teammate jake@getgim.com. Need a genuine prospect mailbox outside Front. |
| 12 | Automatic replies | Not exercised live; requires a controlled auto-reply fixture. |
| 13 | Human takeover | Pass: Oak's initial email became SUPPRESSED after its waiting window and stayed canceled through disqualification/reopening. |
| 14 | Front sidebar | Pass for correct linked-lead context, switching context, unsaved-draft isolation, account/documents navigation, and shared-line draft handoff. Some navigation/role variants remain partial. |
| 15 | Notes/email attachments | Partial: CRM-only note and CRM-to-Front internal comment passed. Importing an inbound email attachment awaits external email. |
| 16 | Later portal upload | Pass for PDF: later upload and OCR completed; scheduled extraction ran at 11:10 p.m.; one grouped Front comment arrived at 11:20 p.m. The existing response task stayed open and no second initial email was sent. |
| 17 | Commitments | Pass for independent actions, edits with a reason, past-date rejection and preserved dates. |
| 18 | Reminder | Pass: in-app notification at 10:36:42 for a 10:36 commitment; linked Front reopen confirmed by 10:37:43. |
| 19 | Business-day schedule | Partial: no-reply due Friday Sep 11 at 9 a.m.; champion escalation stored Monday Sep 14 at 9 a.m. Actual day-boundary/escalation notifications not yet elapsed. |
| 20 | Snooze independence | Pass: Front snoozed until next morning; CRM deadline stayed 10:36 p.m.; reminder reopened Front and cleared the later snooze. |
| 21 | Separate owners/handling/access | Partial: both roles and Front handler display correct for Jake. Switched routing to champion, confirmed assignment, then restored salesperson routing without changing owners or deadline. Needs another authorized teammate; no invitations sent. |
| 22 | Independent carrier work | Partial: completing salesperson work left champion work open. Real carrier email classification remains pending. |
| 23 | Missed call/voicemail | Pending an inbound call from the authorized test phone. A text asking for a callback is not a missed-call test. |
| 24 | Every business number | Partial: Jake's individual outbound number verified. Main-line inbound and Brian/Christina/Mike line cases remain untested. |
| 25 | Answered/ringing/transfer | Partial: one connected outbound call in native Dialpad. Call-leg union, transfer and CRM outcome acceptance not exercised live. |
| 26 | Shared-line texts | Pass for native two-way SMS, real post-activation inbound capture, association linking, response task, and CRM-to-Front draft with correct sender/recipient. Test draft discarded. |
| 27 | Ambiguous phone matching | Pass: the shared test phone matched several leads and required explicit linking; only the chosen activity was linked. |
| 28 | Same request across channels | Pass for explicit combining of the staged enquiry task and real text request; earliest deadline preserved, one task retired, both communications retained. No automatic merge inferred. |
| 29 | Attempt versus resolution | Pending live CRM call/outcome fixture. Text/task outcomes do not establish call-outcome behavior. |
| 30 | Automatic inbox cleanup | Not enabled; external reply/callback prerequisites remain incomplete. Snooze reopening was tested independently. |
| 31 | Closed/reopened/bound | Pass on fictional fixtures: lost/reopened, disqualified/reopened, and existing quote bind flow. Bound Pine became a client and lead tasks retired. |
| 32 | Pause/resume | Pass: Elm captured and generated email while paused; resume sent once, created the proper follow-up and cleared its recovered warning. |
| 33 | Work views/activity | Partial: displayed work agrees with tested records, personal filter, actionable queue retirement and readable Activity names. Multi-user and substantial pagination cases pending. |
| 34 | Recovery/admin/security | Partial: reviewed an obsolete confirmed-delivery issue; scoped history retry retained Elm's one email and original task/date. Outage injection, uncertain send, failed-event replay, migration batch, non-admin access and STOP remain untested live. |

### Retained test records

| Fixture | Staging account | State |
| --- | --- | --- |
| Full quote: test hoa | [Open](https://staging.d2d4g940z91vj4.amplifyapp.com/accounts/4031f1e3-0075-4140-ae16-6a6746511661) | AI sent; Friday follow-up; obsolete warning reviewed with no resend. |
| Assessment: Cedar | [Open](https://staging.d2d4g940z91vj4.amplifyapp.com/accounts/7b1b11b0-eb7a-4170-87ae-97cc13733888) | AI sent and Seen; two PDF upload records; real text response due Thursday 5 p.m. |
| Contact: Oak | [Open](https://staging.d2d4g940z91vj4.amplifyapp.com/accounts/40bac49c-a98c-41fa-a202-5b229a60b075) | AI suppressed; disqualified then reopened with manual follow-up Thursday 10:54 p.m. |
| HO-6: Elm | [Open](https://staging.d2d4g940z91vj4.amplifyapp.com/accounts/f14c1514-153b-48d3-baf0-78ecefbdca29) | PERSONAL; association/unit context retained; AI sent after resume; Friday follow-up. |
| Coverage calculator | [Open](https://staging.d2d4g940z91vj4.amplifyapp.com/accounts/14253ad5-3b11-4bf0-b068-3743c4751cee) | 14 units, MA; one account after retry; AI sent at 10:57:43 p.m.; Friday follow-up. |
| Manual: Pine | [Open](https://staging.d2d4g940z91vj4.amplifyapp.com/accounts/2786e100-dd72-49a0-94d4-438ddd65253e) | CLIENT after fictional bind. Test Carrier QA; policy TEST-NOT-INSURANCE-PINE-0909; $1,000 GL, Sep 10, 2026–Sep 10, 2027, direct bill. No real coverage bound. |

### Remaining observations

- Imported forms are now valid rendered HTML, but the stored answer snapshot is still a technical JSON presentation; a friendlier form-summary design is a separate UI improvement.
- Some communication audit rows still summarize an edit without prominently displaying the detailed old/new date and reason. The saved audit exists; the raw actor-name display was corrected.
- The calculator's first submit displayed a retryable failure. The second unchanged attempt succeeded, and a read-only count confirmed exactly one calculator account. No cause was proven; do not describe this as a repaired defect.
- Existing old imports were not rewritten to conceal their original formatting or classification. Cedar's original false response task was deliberately combined with the related test SMS, retaining history and the earlier commitment.

### Validation and deployed changes

- **1,970 tests / 100 files passed**, including the new operation-recovery, trusted-import, name-resolution and provider-number display cases.
- Frontend typecheck, backend typecheck and synthesis passed during this session. The latest code passed the CRM and website deployment builds.
- Final code commit: `0175110`. CRM staging job **180** and website staging job **179** succeeded. Earlier fixes: `2c46903`, `b25f962`, `c8224d0`, `a7a752a`.
- Verified the final deployed text display: `(617) 895-9530` to `(508) 233-2261`, a readable message preview, and no incorrect “Handled by” claim for an unmapped inbound office event. Provider IDs and stored phone values remain intact.
- All eleven work views were opened. Waiting/response rows matched their leads; completed operations and processed events left the actionable queues. Due today, Overdue, Champion work, Needs assignment, Unlinked activity, Notifications, Delivery queue, Event processing and Communication issues were empty after the relevant test work was resolved. Empty views do not exercise populated pagination or a different user's filtering.

### Current staging state

Delivery is **active**, restricted to `jake@jakegreasley.com`; **automatic inbox cleanup is off**. Connection checks passed at approximately 11:04 p.m. Jake remains the default salesperson and deal champion. The main-line/office Dialpad call and SMS subscriptions remain enabled for the pending user-assisted call test; individual staff subscriptions remain disabled. This is an ongoing controlled test window, not production acceptance. End the temporary capture window when the remaining phone tests are complete.

No production branch was deployed. No forwarding rule, staff invitation, real insurance bind, or unrelated live-lead change was made. Test fixtures are retained for inspection. The native composer test draft was deleted without sending it.

## Historical session notes

First live browser session: approximately 9:12–9:39 p.m. Eastern. Tested in Chrome against staging. This is a partial acceptance record; the 34-test walkthrough is not complete.

## Test fixtures and boundaries

- CRM: https://staging.d2d4g940z91vj4.amplifyapp.com
- Authorized prospect: `jake@jakegreasley.com`, `(617) 895-9530`.
- Staging sender: `jake+testing@protectmyhoa.com`; channel `cha_gld22`.
- Manual fixture: [TEST Pine Browser QA 0909](https://staging.d2d4g940z91vj4.amplifyapp.com/accounts/2786e100-dd72-49a0-94d4-438ddd65253e).
- [Native test email in CRM Staging](https://app.frontapp.com/inboxes/teammates/20999898/inbox/all/117421069338).
- [Received copy addressed to the test prospect](https://app.frontapp.com/inboxes/teammates/20999898/inbox/all/117421079898).
- [Two-way shared-line SMS test](https://app.frontapp.com/inboxes/teammates/20999898/inbox/all/117421120666).
- Automated CRM delivery stayed paused; inbox cleanup stayed off; first activation was not performed. No website enquiry, initial AI reply, invitation, quote or bind was created during this session.
- One native test email, two native test texts (initial test and acknowledgement), one brief native outbound call, and one sign-in email to Jake's existing CRM account were sent. All prospect traffic used the authorized test contacts.

## Observed results

| Walkthrough area | Result | Evidence / limit |
| --- | --- | --- |
| 01 — Test recipient and settings | Pass for the tested setup | Replaced the previously saved `jake+tester@protectmyhoa.com` with the authorized prospect address through Edit settings. Save confirmed delivery remains paused. Connection checks passed at about 9:15 p.m. Jake remained the default for both roles. |
| 02 — Front email connection | Partial pass | Correct channel routes to CRM Staging; Track sent emails is enabled. Native email was sent and its received copy is addressed to `jake@jakegreasley.com`. A prospect reply reaching the staging conversation is still pending. |
| 02 / 26 — Native shared-line SMS | Pass for native two-way texting | Front shows sender `+15082332261`, recipient `+16178959530`, the exact test body, and inbound `TEST received.` in the same thread. Jake confirmed sending the reply. This does not establish post-activation CRM SMS history or response-task creation. |
| 02 / 24 — Native outbound call | Partial pass | Dialpad call `5086990555455488` connected and ended. Provider lookup reports outbound, external number `+16178959530`, actual business line `+16177024123`, and approximately 49 seconds connected. The call used Jake's individual number, despite Front's channel label being HOA Insurance Agency (voice). Main-line inbound calling/voicemail and other staff lines remain untested. |
| 02 — Signed provider receipts | Pass for receipt verification | Front received ordinary signed events. Dialpad first recorded receipts at 9:22 p.m.; a later real SMS event was accepted at `2026-09-10T01:31:42.033Z`, after the signing-key replacement noted below. No synthetic event was used as acceptance proof. |
| 04 — Eligibility and protected IDs | Pass | Jake is eligible for both roles and selectable as default. Front and Dialpad IDs are reference text. Edit connections starts with Save disabled; invalid values show specific validation and cannot be saved. Cancel followed by reopening preserved `tea_ci3mi` and `5655281245659136`. No eligibility or connection mapping was changed. |
| 04 — Manual lead defaults | Pass | Created the fixture with both role selections blank. Saved workflow selected Jake for both roles and retained the test contact. No website AI sequence was triggered. |
| 10 — Native Seen | Partial pass | Front displayed Seen on the native test email. CRM Seen polling remains untested because automated delivery has not been activated and this message predates activation. A Seen signal is not proof of human reading. |
| 14 — Front sidebar | Partial pass | Signed in directly inside the embedded panel using Jake's existing account. Explicitly linked only the native test email to the manual fixture as Prospect. Correct contact, owners, source, empty quote/document context and the same CRM next action appeared. Switching to the unlinked test SMS removed the previous lead and unsaved note. Navigation buttons and a second linked-lead switch remain untested. |
| 15 — CRM-only internal note | Partial pass | Saved a note with Also add to the Front email conversation unchecked. The note appears in CRM communication history and Activity. Front comment delivery and attachment imports remain untested. |
| 17 — Create/change commitments | Pass for tested controls | Added independent salesperson and champion/carrier actions. Changed a deadline with a reason. Missing reason blocked saving. A past date returned `Choose a future date for a new promise` and created no task. Activity records exist; display issues are listed below. |
| 18 — Short reminder | Partial pass | Commitment due `2026-09-10T01:26:00.000Z` (9:26 p.m. Eastern) produced a notification at `2026-09-10T01:26:41.776Z`. Observed in CRM Notifications and captured in a browser screenshot. This proves the in-app notification path while paused; linked Front reopening and business-day escalation remain untested. |
| 11 / 22 — Explicit outcome and independent tasks | Partial pass | Completed the salesperson reminder with an explanation and future successor, TEST wait for sample documents. The separate champion/carrier task remained open. Inbound email classification and carrier-message routing remain untested. |
| 31 — Lost and reopened | Partial pass | Lead lost completed the selected task and background processing canceled the remaining carrier action at `2026-09-10T01:30:41.448Z`. Refreshed UI showed Lead outcome: lost and no open tasks. Reopened with a future action/reason; the fixture is now active with human handling. Disqualified and bind scenarios remain untested. |
| 33 — Work queues | Partial pass | Needs response was empty; Due today showed the test reminder; Champion work showed only its carrier action; Notifications showed the due reminder. Delivery queue displayed two pre-existing RETRY_WAIT operations for `test hoa` (account `4031f1e3-0075-4140-ae16-6a6746511661`), left unchanged. Remaining filters, paging and review actions are untested. |

## Findings recorded at 9:39 p.m.

1. **Activity uses raw user IDs for communication changes.** The same Activity screen displays Jake Greasley for normal Account/Contact writes but a Cognito ID for communication actions. `store.ts` currently records `actorName: actor`. This should resolve the teammate's display name while retaining the immutable actor ID.
2. **Communication audit detail is not apparent in Activity.** The tested task changes show generic summaries such as Next action saved, while the visible row does not show the edited date/reason. The underlying audit payload should be checked against the Activity renderer so deliberate deadline changes are understandable to an administrator.
3. **Native voice sender requires verification by number.** Selecting HOA Insurance Agency (voice) produced a call from Jake's individual business number. This preserves the documented existing Dialpad caller-ID behavior; do not label it as a successful shared-main-line call test.

Browser automation note: direct filling of the native date field did not reliably update its React value. Normal date-field keyboard controls did, and the saved time was independently verified. This was not counted as an application defect. One stale Front settings URL referred to the removed email channel; reopening the current channel through Channels worked.

## Operational notes

- Enabled only the existing main-line/office call subscription `4762460190973952` and SMS subscription `5082771637706752` for the requested test window. The call scope is office `5077405326581760`, group calls only; SMS is the same office, both directions, delivery updates enabled, internal messages excluded. Individual staff subscriptions were not enabled. The two main-line subscriptions remain enabled for the inbound test already requested from Jake; CRM delivery remains paused and pre-activation traffic is not normal CRM communication history. Disable these subscriptions when the controlled test window is finished.
- Dialpad's update endpoint required the call-state list and did not preserve omitted target scope in an initial update. The intended office scope was immediately restored with explicit fields and verified. Future subscription updates must preserve all scope fields explicitly rather than submitting only `enabled`.
- A provider diagnostic accidentally included the old staging webhook signing secret in tool output. It was replaced in Secrets Manager and on the existing Dialpad webhook, verified to match without printing the replacement, and subsequently verified by a real signed SMS event. Other credentials and the callback URL were preserved. Do not copy the old diagnostic into another artifact.
- No production deployment, forwarding rule, staff invitation, call-routing change, recording-policy change or live-lead modification was made.

## Next steps identified at 9:39 p.m.

1. Complete the pending reply from `jake@jakegreasley.com` to the native test email and verify it reaches the CRM Staging conversation. Delivery and Seen alone do not prove the reply path.
2. Complete the requested main-line inbound test from `(617) 895-9530`, with a short test voicemail if unanswered. Verify both Dialpad and Front, then repeat after activation for CRM callback/task acceptance.
3. Review the two existing queued operations before first activation. Keep automatic cleanup off. Do not attest that all native checks are complete until the missing checks above pass.
4. Run fresh website submissions after activation to test the initial AI email, submission threading, upload windows, reply handling, read-status synchronization, callbacks, shared SMS history, and eventual inbox cleanup.
5. Continue the remaining walkthrough cases, including two-person ownership and actual business-day escalation. Do not mark all 34 tests passed from this first session.

The retained manual fixture has **TEST continue staging browser checks**, due September 10 at **9:31 p.m. Eastern**, owned by the salesperson. It is explicitly a test fixture and can be used in the next session.

## Continued session — starting 10:10 p.m. Eastern

User authorized continued lifecycle testing and fixing the raw ID display.

- Found the user's `TEST reply received.` in the received-copy conversation. Expanded headers show it was sent **from `jake@getgim.com`**, not the designated prospect address. It is a teammate outbound message; this does not prove a separate prospect reply reaches the staging channel. Requested a separate mailbox outside Front for a true inbound test. The earlier concern about reply routing remains unproven, not a confirmed defect.
- Reviewed the existing `test hoa` queue: both the saved form and generated AI email target the authorized prospect. Enabled controlled staging delivery around 10:19 p.m., with cleanup off, after native sender/call/shared-SMS and signed receipt checks. The UI's staging instructions were clarified to distinguish native checks from subsequent CRM acceptance; no backend activation/security gate was removed. Other staff-line tests remain outstanding.
- **AI email live send passed on `test hoa`.** Front conversation `cnv_1hxxvniy` contains the imported website submission and exactly one automated initial email, displayed as Brian Cole from the staging sender. CRM shows the outbound email at 10:21 p.m. and a follow-up due **September 11, 9:00 a.m.**.
- Submitted **TEST Cedar Lifecycle 0909** via the assessment form at approximately 10:19 p.m. Account: `7b1b11b0-eb7a-4170-87ae-97cc13733888`; Front conversation `cnv_1hxxvna2`. The form uses its property address as the account name. Uploaded a clearly fictional one-page PDF through Chrome's native file picker, saw Received, then chose Done uploading. CRM shows one 33 KB document, OCR done, correct extracted text, and an AI extraction summary explicitly recognizing the fictional document and 12 units. The AI email sent in the same conversation at 10:24 p.m. and accurately acknowledges the test document is not evidence of insurance.
- Browser upload automation's filechooser API returned `Not allowed`; its documented native picker fallback succeeded. Native date inputs require verifying the full displayed value: digit entry auto-advances date segments. No browser/network/storage injection was used to simulate successful intake.
- **Found and fixed a stale recovery warning:** `Waiting for the Front intake conversation` remained actionable after the email was confirmed. Commit `b25f962` atomically clears only the completed operation's warning and stale error; unrelated sync/provider issues remain. Also specifies Front's HTML body format instead of its Markdown default, which had displayed literal preformatted markup.
- **Found and fixed incorrect response work on fresh forms:** Cedar's imported submission was classified as a prospect reply because Front does not return external_id in message metadata and its text began with literal `<pre>`. This created a response task instead of the intended no-reply follow-up. Commit `c8224d0` recognizes our imported message by its durable UID/operation, with a verified fallback, and does not suppress genuine replies merely quoting the intake reference. Fresh post-fix acceptance remains required; Cedar's already-created task is retained as evidence pending deliberate review.
- **Raw ID display passed live:** commit `2c46903`, CRM staging job176 succeeded. Historical communication Activity entries now show Jake Greasley, and Who offers one identity-based Jake filter. Old audit records were not rewritten. Added lookup-failure/retry, pagination and same-name identity tests. `c8224d0` additionally replaces raw handler/AI actor identifiers with readable labels in communication history/sidebar.
- Submitted **TEST Oak Cancel 0909** via Contact at 10:29:43 p.m.; account `40bac49c-a98c-41fa-a202-5b229a60b075`. Chose Handle personally before the upload/generation window elapsed. UI confirms team takeover. Verify no initial email after the window; do not count clicking the button as the final result.
- Set Pine's existing action to **TEST snooze must reopen at deadline**, due **10:36 p.m.**, with an explicit test reason. Snoozed its linked native email until **September 10, 9 a.m.** Front displayed Snoozed / Waiting; CRM still showed the unchanged 10:36 p.m. task. Reopening verification is in progress.
- Prepared a fictional $1,000 General Liability quote on Pine with existing **Test Carrier QA**, effective September 10, 2026 through September 10, 2027, and prominent test-only notes. No real carrier action. Bind confirmation has not yet been submitted.

Validation so far in the continued session: all **1,962 tests / 100 files** passed after the first display fix. The subsequent delivery fixes passed focused workflow tests, backend typecheck, and synthesis. Latest intake-identification changes passed 114 focused tests plus backend typecheck and CRM build. CRM jobs176/177 succeeded; job178 for `c8224d0` was running at 10:35 p.m.


## Final continued-session results — 11:21 p.m. Eastern

- Pine's 10:36 p.m. commitment produced its in-app reminder at 10:36:42 and a confirmed Front reopen by 10:37:43, despite Front having been snoozed until the following morning. The fictional quote was subsequently bound through the ordinary UI; Pine became a client and its lead tasks retired.
- Oak's cancellation was independently checked after its generation window and again after disqualification/reopening: `SUPPRESSED`, no sent timestamp. Reopening retained human handling and an explicit future commitment.
- Elm's HO-6 form created the PERSONAL lead with its association and unit context while delivery was paused. Both import and generated-email operations remained waiting. Resume sent exactly one initial email in conversation `cnv_1hxy0k7u`, with a Friday 9 a.m. follow-up and Monday 9 a.m. escalation. Its temporary waiting issue resolved automatically. A scoped history retry did not duplicate its message/task or move the deadline.
- The calculator's first failed attempt was retried without changing answers. It created exactly one calculator account and one AI email, sent at 10:57:43 p.m., with a Friday follow-up. The first failure's cause remains unproven.
- Real inbound Dialpad text `6305271534624768`, received at 10:37:23 p.m. from the authorized mobile to the shared main number, contained “TEST: please call me about the documents.” It required an explicit association choice because the test phone matched multiple records. Linked it only to Cedar, then explicitly combined the staged enquiry request with this related text request. One task remains OPEN, due September 10 at 5 p.m.; the earlier form-classification task is CANCELLED and the communications remain in history.
- Cedar's AI email had a Seen signal at 10:35 p.m. visible in both Front and CRM. Refreshing Seen did not complete or postpone its response request.
- CRM's internal note appeared in the original AI conversation. The sidebar showed the correct linked lead, opened the correct account/documents, and created a private Front SMS draft from the shared channel to the authorized mobile. The draft was deliberately deleted without sending. Routing to the champion role was confirmed, then salesperson routing restored, leaving CRM owners and deadlines unchanged.
- Opened Cedar's private upload link from its AI email. Uploaded the same clearly fictional PDF into Recent building updates; the portal showed Received and CRM showed the second upload with completed OCR. The scheduled sweep started extraction at 11:10:31 p.m.; the account's new extraction completed at 11:10:41. At approximately 11:20 p.m. Front displayed exactly one internal notice listing the newly received file, unit count and outstanding documents. The existing callback/response task stayed OPEN for September 10 at 5 p.m. No manual invocation, timestamp change or extra initial email was used to force this result.
- Updated both walkthrough formats to explain that fresh extraction can make the grouped document notification take roughly 20–30 minutes, with longer waits for larger or stalled processing.

Staging remains active for the allowed test email with cleanup off and main-line capture enabled for the pending call test. The unanswered live prerequisites in the current coverage table remain open; this record is not a production sign-off.
