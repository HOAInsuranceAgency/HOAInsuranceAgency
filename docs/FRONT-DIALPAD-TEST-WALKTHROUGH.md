# Front, Dialpad & CRM: staging test walkthrough

Use this guide in order. Each numbered test includes what to do and what should happen. Mark it **Pass**, **Fail**, or **Blocked** and record the test lead and time. An expected result is a test target, not a claim that the live feature has already passed.

**Setup snapshot September 9, 2026 (historical):** the new Front email channel is connected and all CRM connection checks pass. Jake is the default salesperson and deal champion. Delivery is paused, automatic cleanup is off, and all five call and five text event subscriptions in Dialpad are disabled. There is no verified Dialpad event receipt yet. This guide does not activate anything.

Plan for a first session of roughly **60–90 minutes**, additional time with the team for phone coverage, and a later check across real business deadlines. The short timer test does not replace the business-day test.

## Before you begin

### 01 — Prepare your test contacts and screens

1. Open the [staging CRM](https://staging.d2d4g940z91vj4.amplifyapp.com/), [staging website](https://staging.dx1256wpowwzz.amplifyapp.com/), Front, and Dialpad. Keep the CRM's **staging** address visible.
2. In Front, use **HOA Insurance Agency LLC → CRM Staging** for email. Phone activity uses the existing **HOA Dialpad** inbox.
3. Choose a separate email mailbox you control to play the prospect. In [Settings → Front and Dialpad](https://staging.d2d4g940z91vj4.amplifyapp.com/settings/?tab=integrations), choose **Edit settings**, add that address under **Test email recipients**, and save. Keep the sender as **jake+testing@protectmyhoa.com**. The current permitted recipient is that same address; a separate recipient makes reply and Seen tests meaningful.
4. Choose a mobile phone you control to play the caller/text recipient. Write it in your test notes. The shared sender, **(508) 233-2261**, is a real business line, not the test recipient.
5. Prepare a harmless sample PDF and a sample spreadsheet. Use names such as **TEST Oak HOA**, **TEST Pine HOA**, and **TEST Cedar HOA**, or put TEST in the contact name when a form does not ask for an association name. Use only your test contact details.
6. Inbox cleanup runs automatically while delivery is active. Review test 30 before starting; eligible test conversations may archive as soon as their next follow-up is recorded. No staging invitations are needed for the single-person tests; do not invite Ryan. Tests requiring a second CRM user stay Blocked until an already authorized participant is available.

**Expected:** staging retains Jake in both default roles, the new recipient is saved, connection checks still pass, and delivery stays paused. Native Front/Dialpad sends are real sends and do not inherit the CRM email-recipient restriction; check the recipient before each manual send.

### 02 — Complete the native connection checks

1. Have the integration administrator enable the **existing staging Dialpad event subscriptions** for the lines participating in the test. This is a provider setup step, not a CRM checkbox. Their identifiers are already recorded in the rollout runbook; no new API keys or duplicate subscriptions are needed.
2. In Front's settings for **jake+testing@protectmyhoa.com**, verify **Track sent emails** is on for the newly created channel. Old-channel settings do not establish this. [Front's tracking instructions](https://help.front.com/en/articles/2034)
3. Send a manual email from that staging sender to the separate test mailbox, with subject **TEST CONNECTION — email**. Reply from the test mailbox. Verify both directions in **CRM Staging**.
4. Call the main line from the test mobile, answer through the normal phone interface, and call the test mobile back. Send a text from the shared main line to the test mobile, then reply.
5. With the relevant teammates, repeat the native call checks for each individual number listed in test 24. Confirm the shared text's actual sender and delivery status in Front/Dialpad.
6. Have the administrator confirm that recent, signed events from **both Front and Dialpad** reached staging. An enabled app or a passing access check is not sufficient.

**Expected:** native email, voice and shared texting work, and both event sources have a recent receipt. Before first activation, these events are not projected into normal CRM communication history. Repeat the formal scenarios after activation; do not count the native checks as the CRM history tests.

**If blocked:** stop here for live delivery tests and record the missing connection. Dialpad subscriptions cover traffic on the selected business lines, not only your test mobile; arrange a test window with the team. Individual numbers need their own native voice connections if their calls are to appear in Front. Native personal-number SMS channels are not promised. [Front's Dialpad guide](https://help.front.com/en/articles/2891264)

### 03 — Start staging delivery

1. Open **Settings → Front and Dialpad → Advanced tools → Connection issues and queues → Delivery queue** and review any already queued test leads. Starting delivery can release them. Use the lead's **Handle personally / cancel pending AI reply** or admin delivery review for an unwanted queued test; do not submit it again.
2. In **Settings → Front and Dialpad**, click **Check connections**.
3. Expand **Delivery**. After completing test 02, select **I verified email, calls, and shared-line texts with test contacts**.
4. Click **Start delivery**. Cleanup is automatic; there is no separate switch.
5. Record the activation time. Create fresh test messages/calls after this time.

**Expected:** activation succeeds, delivery is running, and eligible conversations are tidied automatically. CRM deadlines remain unchanged. If activation reports a missing signed test event, return to test 02. Passing the connection check alone does not bypass that requirement. Pre-activation messages and calls are not a historical import test.

## Settings and lead intake

### 04 — Confirm team selection and protected connection values

1. In **Settings → Team**, confirm Jake has both **Salesperson** and **Deal champion** checked.
2. Verify Front and Dialpad IDs display as reference text, not editable table fields. Click **Edit connections**.
3. Check that the dialog contains the current values and Save is disabled until a change is made. Enter an invalid sample value, such as `not-an-id`, and verify validation blocks saving. Click **Cancel**.
4. Reopen the dialog and verify the original values remain. Close it without saving.
5. In integration settings, open the default-owner dropdown. Verify Jake is offered. Cancel the edit.
6. Create a disposable lead using the CRM's **New lead** form. Leave its role selections empty to exercise the saved default, or deliberately choose Jake for both. Open the saved lead's **Overview → Lead follow-up** and check both assignments.

**Expected:** IDs require deliberate editing and an explicit save; canceling discards changes. Existing mappings remain intact. Eligibility determines dropdown choices and does not change sign-in permissions or CRM access. A manually created lead receives the selected/default responsibilities; it does not automatically run the website's intake/initial-AI-email sequence.

### 05 — Submit a lead and receive the AI email in the same Front conversation

1. Open the [staging contact form](https://staging.dx1256wpowwzz.amplifyapp.com/contact/). Use first name **TEST**, last name **Oak**, your permitted test email, and this message: **This is a staging test. We need an HOA insurance review. Please contact this test address only.**
2. Submit once. Find **TEST Oak** in CRM Leads and open **Overview → Lead follow-up**.
3. Verify the original form answers/contact details and Jake in both roles. Find the related **Website enquiry** conversation in **CRM Staging**.
4. Leave this browser confirmation open and wait for the reply. With no uploads, the normal reply window is **eight minutes**, followed by background processing and generation time. Allow a few additional minutes; it is not an instant-send promise.
5. Check the test mailbox, the Front conversation, and CRM **Communication history**. Use **Refresh** as needed.

**Expected:** one lead, one labelled website-submission record in Front, and one initial AI email in that same Front conversation. The email's display name is **Brian Cole** and its staging From address is **jake+testing@protectmyhoa.com**. There is no separate FormSubmit copy or AWS fallback email for this flow. The confirmed outbound email produces a **Follow up with prospect** action. Receipt/acceptance alone must not be presented as confirmed sending.

**Check content too:** the email should match the submitted context and contain no invented policy, quote or binding claim. Exact AI wording can vary. Verify any document-upload link opens the staging website.

### 06 — Submit with documents and finish the upload window

1. Open the [staging assessment](https://staging.dx1256wpowwzz.amplifyapp.com/get-started/). Use a new TEST contact and your permitted email.
2. After submission, upload the sample PDF and spreadsheet. Wait until both say **Received**, then select **Done uploading**.
3. Open the lead's **Documents** tab. Confirm both files are present and readable. Follow the PDF's processing status.
4. Wait for the initial AI reply and confirm it appears once in the same intake conversation. Check whether it uses readable document context accurately.
5. On another assessment, choose **Skip, send my summary** instead of uploading.

**Expected:** Done/Skip closes the upload window early. PDF/image processing may delay the reply; a spreadsheet is attached without waiting for OCR. If the browser is simply left open, the window closes after eight idle minutes after the last upload. Files remain saved even if extraction fails; the reply must not pretend unreadable content was understood. Invalid file types or files over 25 MB show an error rather than a successful upload.

### 07 — Exercise all five website entry points

Submit once through each row below, with a distinct test identity or address. Reuse test 05/06 results where applicable. Search by contact email, recorded address, source and time if the form chooses the lead name automatically.

| Entry point | What to exercise | Expected source/context |
| --- | --- | --- |
| [Contact](https://staging.dx1256wpowwzz.amplifyapp.com/contact/) | Name, email and message | Contact answers preserved |
| [Instant assessment](https://staging.dx1256wpowwzz.amplifyapp.com/get-started/) | Property details and optional uploads | Assessment answers preserved |
| [Full quote application](https://staging.dx1256wpowwzz.amplifyapp.com/quote/) | Complete the form with fictional test details | Full application answers preserved |
| [Homepage coverage calculator](https://staging.dx1256wpowwzz.amplifyapp.com/) | Complete calculator, then submit its email form | Address, unit count and shown coverages preserved |
| [Association-specific HO-6 form](https://staging.dx1256wpowwzz.amplifyapp.com/associations/114-elm-street-condominium/) | Use a TEST contact and test email; retain the page's association context | Personal/HO-6 lead, unit details and association context preserved |

**Expected for every row:** one lead per deliberate submission, Jake defaults, a labelled Front intake, and one AI reply in its conversation. Where a form offers uploads, those continue to work. A new deliberate enquiry is not the same as retrying a failed request.

### 08 — Retry and interrupted submission

1. During a normal test submission, press Submit twice quickly. Verify the button cannot create two enquiries while the request is pending.
2. For the interrupted-response case, have the integration administrator simulate a lost response on a test form after its request may have reached the server. Retry the **same answers in the same browser tab**, including after a reload where supported.
3. Repeat with corrected answers after a failed attempt.

**Expected:** an unchanged retry returns the same lead/receipt without a second AI email or team alert. Corrected answers are accepted as a new submission identity; if the earlier request already committed, its lead can still exist. The visitor must not be permanently locked out. Mark the interruption portion Blocked until a controlled simulation is available; submitting a brand-new form twice is not this test.

### 09 — Optional internal new-lead text alert

1. In **Settings → Team → Team members**, confirm your own **Lead texts** preference and enter a mobile number you control if you want this alert tested. Verify there are no unintended opted-in staging recipients.
2. Submit one new website test enquiry, then perform the unchanged-retry check from test 08.

**Expected:** one internal new-lead alert per submission for each configured opted-in recipient; retrying does not produce another. Without a mobile number, an enabled checkbox alone sends nothing. This internal alert is separate from prospect texting through Dialpad and may occur even while CRM delivery is paused. Do not expect its sender to be the shared Dialpad line.

## Email and the Front sidebar

### 10 — Verify Seen without changing the follow-up date

1. Use a newly sent test email in the separate prospect mailbox. Record its current CRM follow-up deadline.
2. Open it in a mail client that loads images. Check the sent message in Front for a **Seen** indicator.
3. In CRM **Communication history**, expand the outbound email and select **Refresh Seen status**. Wait for background processing, then click the panel's **Refresh**.
4. Compare the displayed Seen result and check time with Front. Recheck the task deadline.

**Expected:** a Front Seen signal is reflected in CRM when available. Otherwise CRM says it has not checked, no signal was returned, or the status is unavailable—it must not assert the recipient has not read it. The deadline is unchanged and no email is resent. Image blocking and mail-provider privacy/proxy behavior affect open signals; this is not proof of human reading. [Front explains these limits](https://help.front.com/en/articles/2034).

### 11 — Reply normally and let the CRM update the work

1. From the test prospect mailbox, reply to TEST Oak's AI email: **Please clarify what documents you need.**
2. Verify the inbound message and response deadline appear in the lead workspace.
3. Send another message about the same unanswered request. Its deadline must not move later.
4. Reply as the salesperson in Front. Do not enter a note, outcome, or due date in CRM.
5. Refresh the lead workspace after background processing.

**Expected:** the sent email is the record. The matching response task closes automatically and a follow-up is scheduled for 9 a.m. Eastern on the second business date after sending. Eligible email conversations archive automatically. The original messages remain in history. Other contacts, carrier requests, and newer unanswered messages remain separate.

### 12 — Automatic replies do not count as prospect handling

1. Use a separate waiting test lead. Send a controlled reply with subject **Automatic reply: TEST availability** and a short out-of-office message, or use an actual automatic responder on the test mailbox.
2. Compare its existing waiting task and due time before and after processing.

**Expected:** the automatic response is recorded without creating a normal substantive response task or satisfying the prospect's outstanding request. The waiting deadline remains. This checks automatic-reply classification, not every possible provider's responder format.

### 13 — Take over before the initial AI email

1. Submit **TEST Takeover** through a form and immediately open its CRM lead, during the eight-minute window.
2. Choose **Handle personally / cancel pending AI reply** in the CRM, or **Conversation tools → Handle personally** in Front, before any AI send has started.
3. Wait beyond the normal reply window, then inspect the test mailbox, Front and delivery queue.
4. Send the human reply in Front. Verify the email is recorded and the next follow-up is scheduled automatically.

**Expected:** the queued initial AI reply is suppressed and no automatic first-contact email arrives. If a send was already dispatched or its result is uncertain, the notice must explain that cancellation is not recall. Check Front before sending a replacement yourself. A missed/unanswered call alone should not count as human resolution.

### 14 — Use the CRM inside Front

1. Select TEST Oak's email conversation in Front and open the **HOA CRM — Staging** sidebar app. Sign in with your existing staging CRM identity if prompted. If the panel feels cramped, drag its left edge to the left to give it more room.
2. Verify the correct lead name, contact, source, documents, quote context, salesperson, champion and next actions. Use **Open CRM account**, then expand **Account details** for **View all documents** and **View quotes & bind**. Expand **Recent activity** for the message history. Try **Lead team → Edit team → Cancel** and confirm both saved names stay unchanged.
3. Start an unsaved note or edit, then select TEST Pine's conversation. Verify the sidebar changes to Pine and does not apply Oak's unsaved content.
4. For a fresh unlinked test email, expand **Find or link a lead**, search its association/contact, select **Prospect**, and choose the correct result.

**Expected:** the sidebar follows the selected conversation, opens the correct staging account, and shares the same tasks as CRM. An unlinked conversation requires an explicit selection. If embedded sign-in asks for a private sign-in link, use your own unopened CRM sign-in email link there; do not paste it into a shared comment or test report.

### 15 — Internal notes and email attachments

1. In a test lead, add **TEST internal note — waiting for sample documents**, leaving **Also post as a Front comment** off. Save.
2. Add another note with that checkbox on. Check CRM history and Front's internal comments.
3. From the test prospect mailbox, reply with the harmless PDF attached. Once captured, expand the email in CRM and choose **Save to CRM documents**.
4. Open **Documents**, confirm the file, then repeat **Save to CRM documents** for that same source attachment.

**Expected:** the first note stays in CRM; the second also appears as an internal Front comment. Neither is a customer-facing email. The attachment enters the normal document workflow once; saving it again does not create a duplicate document. Unsupported/oversized or unavailable downloads should produce a visible issue, not an empty successful document. Test those failure cases with the administrator rather than modifying real files or links.

### 16 — Later document uploads notify the team in Front

1. Open the staging document-upload link included in a test AI email, as the prospect. Upload another harmless file.
2. Confirm it appears on that same CRM lead. Leave the portal idle for at least **ten minutes**. Allow roughly **20–30 minutes** when the new file needs fresh extraction: the grouped notification runs on the next scheduled check after processing. Larger or stalled files can take longer.
3. Check the lead's Front conversation for the document-arrival internal comment and its summary of received/outstanding documents.

**Expected:** the later upload is attached to the existing account and generates a grouped internal Front notification after the quiet/processing window. It does not create another lead or initial AI email. Several files uploaded together should be grouped. A missing upload link or missing notification is a test failure to record; do not substitute a production portal.

## Ownership, commitments and deadlines

### 17 — Let the CRM choose the next follow-up

1. Send a normal email or shared-line text on a linked test lead.
2. Verify its follow-up is scheduled automatically for 9 a.m. Eastern on the second business date after contact. There should be no routine due-date picker or completion form.
3. Create a separate test conversation, link it to the same lead with purpose **Carrier**, and send a controlled incoming question from your test mailbox.
4. Reply to that carrier conversation in Front.

**Expected:** the carrier response closes automatically and the next carrier follow-up belongs to the deal champion. Prospect and carrier work stay separate. Existing deliberately dated promises remain intact until handled; staff do not choose routine dates.

### 18 — Test the 9 a.m. reminder

1. Send a controlled incoming prospect request after business hours. Verify its response deadline is 5 p.m. on the next business day.
2. Archive or snooze the linked Front conversation beyond that date without changing the CRM deadline.
3. At 9 a.m. Eastern on that business day, allow a few processing cycles. Check **My reminders** and Front.
4. Read **Why this is back**, the original request, the next step, responsible teammate, and deadline. No completion form should be required.
5. Leave this test request unanswered through 5 p.m. It may become overdue, but there should be no new scheduled reminder at 5 p.m.

**Expected:** the morning reminder explains why the conversation returned. Reply, call, or text through the connected tools to handle it; the communication supplies the record and the next follow-up is automatic. Unanswered work escalates at 9 a.m. on the next business date. Do not change the computer clock or manipulate live dates to accelerate this test.

### 19 — Verify the real business-day schedule and escalation

1. Keep a separate lead untouched after its initial confirmed AI email. Do not reply or replace its automatic follow-up with a custom date.
2. Check the due date: **9 a.m. Eastern on the second business date after sending**. Revisit at that time, then on the next business date at 9 a.m.
3. Separately, receive a substantive email or missed call during working hours and record the original time. Verify its deadline uses **eight staffed hours**, 9 a.m.–5 p.m. Eastern, Monday–Friday, excluding configured holidays. The reminder is at 9 a.m. on the due date; escalation is at 9 a.m. on the next business date after the deadline.
4. Because Jake holds both roles, check that the reminder escalates without producing duplicate notifications to the same person. The task should show **Escalated**.

| Example, with no agency holiday | Expected due | Expected champion escalation |
| --- | --- | --- |
| AI email sent Wednesday, September 9 | Friday, September 11, 9 a.m. | Monday, September 14, 9 a.m. |
| Prospect reply Thursday, September 10, 2 p.m. | Friday, September 11, 2 p.m. | Monday, September 14, 9 a.m. |
| Missed call Friday, September 11, 4 p.m. | Monday, September 14, 4 p.m. | Tuesday, September 15, 9 a.m. |
| Request arrives after hours Friday | Monday, September 14, 5 p.m. | Tuesday, September 15, 9 a.m. |

**Expected:** weekends are skipped and the original unanswered request starts the clock. Current staging holidays are empty; enter actual agency holidays before testing holiday handling. Keep the computer timezone set to Eastern while entering test dates. Do not change the computer clock to accelerate this test.

### 20 — Prove personal cleanup cannot postpone team work

1. On a lead with an open response/callback task, record both owners and its due time.
2. In Front, mark the conversation read, snooze it, and archive it. Check the personal inbox view and shared inbox view separately.
3. Refresh the CRM after each action. Then wait for its 9 a.m. reminder, as in test 18.

**Expected:** the CRM owners, task and deadline remain unchanged. Due work stays visible to the team and its linked conversation reopens while delivery runs. Do not judge success solely by whether every personal inbox copy disappears; record personal and shared behavior separately.

### 21 — Separate ownership, Front handling and CRM permissions

1. With Jake in both roles, use **Use deal champion as Front handler**, then **Use salesperson as Front handler** in the lead/sidebar. Verify the mapped Front teammate and unchanged CRM deadlines.
2. With a second authorized staging teammate available, change only the deal champion and click **Save responsibilities**. Verify the salesperson and task dates stay unchanged.
3. Change a conversation's handler manually in Front. Verify that this does not replace either CRM owner. Use the role-routing buttons to deliberately return it to role-based handling.
4. As an admin, enable only one eligibility role for the second test teammate and verify they appear only in that role's dropdown. Restore the intended setting afterward. Their CRM access should not change.

**Expected:** owners are separate duties; the Front handler is separate again. Existing manual handling is respected until deliberately changed. Reassignment directs overdue work to its new responsible person without moving the deadline. The two-person portions are Blocked with only Jake in staging; do not create invitations just to bypass that limitation.

### 22 — Keep carrier work separate from prospect work

1. Keep an unanswered prospect task open on a test lead.
2. Send a separate controlled email representing a carrier question. In the Front sidebar, link that conversation to the test lead with **Conversation purpose → Carrier**.
3. Verify **Respond to carrier** appears for the deal champion and in **Responsibility → Deal champion**.
4. Complete the carrier task with a recorded outcome. Recheck the prospect task.

**Expected:** carrier work does not satisfy or postpone prospect response work. Both can exist on the same account with their own deadlines. Merely changing a Front handler is not the same as classifying a conversation as carrier work.

## Dialpad calls and texts

### 23 — Missed main-line call and voicemail

1. After activation, call **(508) 233-2261** from your test mobile and let it go unanswered. Leave **TEST callback request** as voicemail. Coordinate this with the team.
2. Find the call/voicemail in Dialpad and Front's phone inbox. In CRM, open **Lead follow-up → Needs attention → Link a call or text**.
3. Select **Link activity**, search TEST Oak, choose **Prospect or client**, and link it. Alternatively, use the linked lead's Front sidebar **Conversation tools → Link a call or text to this conversation**.
4. Check **Return prospect call**, its due time, communication history, and any later voicemail/transcript/summary update.

**Expected:** the unknown call enters review rather than automatically creating a sales lead. Allow several minutes for final missed-call reconciliation; the implementation schedules a concluded-call check after roughly three minutes. Linking yields callback work due eight staffed hours from the original call—not from linking or later transcription. Late enrichment does not restart the deadline. One logical customer call should not turn into one callback per ringing agent.

### 24 — Verify every monitored business number

Make a fresh controlled inbound and outbound call for each row. Capture the time, actual line, answering/calling teammate and CRM activity. Explicitly link the activity to the test lead if needed.

| Line | Number |
| --- | --- |
| Shared main line | (508) 233-2261 |
| Jake | (617) 702-4123 |
| Christina | (508) 545-9125 |
| Brian | (508) 257-1566 |
| Mike | (508) 538-4962 |

**Expected for each row:** CRM captures the correct direction, actual business line, external test number and actor where available. Dialpad's existing routing/caller-ID behavior is preserved. Front visibility depends on that number's native voice channel; API capture alone does not prove its Front channel is installed. Mark each untested line Blocked, not Pass because the main line worked.

### 25 — Answered call, multiple rings and transfer

1. Call the main line again. Have one teammate let it ring while another answers. When feasible, transfer the test call to another participating teammate.
2. Wait for the call to end and the provider's final details to arrive. Refresh CRM history and callback tasks.
3. Inspect any transcript or summary when available, without changing recording settings just for the test.

**Expected:** one reconciled customer call with an answered result. A teammate's missed ringing leg must not leave a false callback when someone answered. Transfer details enrich that call; ambiguous provider relationships remain visible for review rather than being confidently guessed. Missing AI/media does not block basic call capture. Answered status or an AI summary alone does not complete an open CRM request.

### 26 — Prospect texting from the shared main line

1. On TEST Oak's Front email conversation, open the CRM sidebar's **Send a text** section.
2. Enter your test mobile and **TEST message from HOA staging**. Click **Open draft in Front**.
3. Verify the draft's From is **(508) 233-2261** and To is your test mobile. Review, then send in Front. If the handoff fails, record it and test the native shared-line composer separately.
4. Reply from the test mobile: **TEST: please call me about the documents.** Link the inbound/outbound activities explicitly as needed.
5. In CRM, filter **Communication history → Texts** and inspect message bodies, directions, status updates and response work. Repeat an inbound text to an individual business number where supported and subscribed.

**Expected:** opening the draft does not send it. One text activity is enriched with delivery status; it is not duplicated for every status update. A substantive inbound text creates response work after linking. A delivered SMS does not mean read or resolved. Calls/texts remain separate from the email thread in Front, with combined history in the CRM.

### 27 — One phone number representing two associations

1. Keep TEST Oak and TEST Pine as separate leads with the same test phone contact.
2. Send two new texts/calls representing different associations. In **Link a call or text**, link one to Oak and one to Pine.
3. Inspect both histories and the remaining unlinked activity. Then leave a third new activity unlinked briefly.

**Expected:** choosing one activity does not assign all past/future traffic from that number to the HOA. No association is chosen from a phone match alone. The third item stays visible for triage with its original time; late linking must not give it a fresh business day.

### 28 — Combine the same request across channels

1. On TEST Oak, create an unanswered email request and a missed-call request about that same issue. Link both to Oak, retaining their original timestamps.
2. Under **Next actions**, select **Same request as another activity** on the two open response/callback tasks.
3. Enter why they are the same request and click **Combine and keep the earliest deadline**.
4. Keep an unrelated carrier or document task open and recheck it.

**Expected:** the combined request keeps the earliest applicable deadline and source activity. Redundant tasks close with a recorded reason; unrelated work remains. If linking already grouped the same episode into one task, record that result rather than inventing duplicates to combine.

### 29 — Let calls record attempts and completed contact automatically

1. Return a linked test prospect's call through Dialpad and let it go unanswered. Do not fill out a call outcome or note.
2. Verify the attempt appears in history and the existing unanswered callback keeps its original deadline. A first outbound attempt with no existing callback schedules a retry for the next business morning.
3. Make an answered test call and end it. Wait for the provider event to be processed.
4. Verify the matching response/callback closes, the completed call remains in history, and the next follow-up is two business days later at 9 a.m.
5. Verify unrelated contact/carrier work remains open. A ringing or still-active call must not count as completed contact.

**Expected:** Dialpad supplies the call record and available transcript/summary. No duplicate notes, completion form, or due-date entry are required. A linked completed call satisfies the contact reminder; it does not prove documents arrived or bind the lead. If a number cannot be matched to one lead, identify the correct lead before expecting automatic progression.

## Cleanup, outcomes and operational checks

### 30 — Verify automatic inbox cleanup

1. Confirm delivery is active in integration settings. **Inbox cleanup** shows **Automatic** and has no on/off control. Existing integrations work automatically even if cleanup was previously off. Activation checks still require recent signed events when starting or resuming delivery.
2. Use a clean test lead with both owners, confirmed delivery, no unresolved inbound request or communication issue, and a future follow-up. Choose **Clean up inbox when ready** in the CRM, or **Conversation tools → Tidy this conversation** in Front.
3. Verify the conversation archives while the CRM lead and dated commitment remain. Use a fresh outbound test with no open response/callback/custom task to check automatic cleanup after a new waiting follow-up is created.
4. On another lead with an unresolved reply or missed call, try the same cleanup action. Then test a due/overdue action.
5. Let the archived lead's commitment become due and verify it reopens. Compare the personal and shared Front views.

**Expected:** only eligible conversations archive. Unanswered requests, overdue work, missing owners, uncertain delivery or sync problems block cleanup. No CRM commitment is completed or postponed. A successful linked reply or completed call requests cleanup automatically. Existing unrelated work and sync checks still apply.

### 31 — Lost, not a fit, reopened and bound decisions

1. On a disposable test lead, open **Conversation tools → Lead status**, choose **Lost**, and click **Update lead status**. Verify obsolete work closes after background processing.
2. Use **Reopen lead**. Verify the next follow-up is scheduled automatically and no second initial AI email is sent. Repeat with **Not a fit** on another test lead.
3. Test binding only through the existing quote/bind workflow using a prepared fictional staging fixture.

**Expected:** these are explicit business decisions. Ordinary emails, texts, calls, Seen signals, and AI summaries cannot mark a lead lost or bound. Reopening restores automatic follow-up. Keep binding blocked until its staging fixture is ready.

### 32 — Pause and resume without losing enquiries

1. In integration settings, click **Pause delivery**. Submit one new website enquiry with your permitted test contact.
2. Verify the CRM lead is captured and its delivery remains pending in **Delivery queue**. Wait beyond the upload window; no initial prospect email should be sent while paused.
3. Review the queued lead, recheck connections, confirm the test checkbox, and choose **Resume delivery**, with the intended cleanup setting.
4. Wait for delivery and verify one initial email in the correct conversation.

**Expected:** pause holds queued CRM delivery, not lead capture. Resume processes the saved enquiry without a second form submission. Existing CRM commitments keep their original deadlines. Native Front/Dialpad messages and internal new-lead alerts are separate; pausing the CRM does not stop those. Queued reminders may reopen conversations after resume.

### 33 — Check every work view and the activity record

1. Open [Lead follow-up](https://staging.d2d4g940z91vj4.amplifyapp.com/lead-work) and visit each view below. Use **Refresh**, **My leads**, and any **Load more / Continue searching** control.
2. Open a listed lead and compare its task, role and deadline. Review the account's **Activity** tab for your responsibility changes, dated actions, outcomes and links.

| View or control | What belongs there |
| --- | --- |
| Needs attention | Replies, callbacks, carrier responses, delivery corrections, and work due today or overdue |
| Upcoming | Scheduled work due after today that does not already need a response |
| All open | Every open task |
| Responsibility filter | Choose salesperson or deal champion independently of the view; with My leads, show your selected responsibility |
| Waiting on prospect label | Shown beside automatic no-reply follow-ups; it is not a separate view |
| Shared team items | Assign a teammate and Link a call or text remain visible in Needs attention and All open, even with My leads selected |
| My reminders | Expand the separate section for current reminders addressed to you |
| Administrator troubleshooting | Connection issues, Delivery queue, and Event processing live under Settings → Front and Dialpad → Advanced tools → Connection issues and queues |

**Expected:** records agree with the lead panels. Confirmed/canceled delivery and processed events can disappear from actionable queues—that is not lost history. My leads is a work filter, not an access rule. An incomplete paginated search must offer a way to continue rather than falsely declaring there is no work. With only Jake, another owner's filtering requires a second-user test.

### 34 — Admin recovery, migration and access checks

Run these with the integration administrator using test records. You do not need to break live credentials, submit forged events yourself, or guess technical message identifiers.

| Scenario and steps | Expected outcome |
| --- | --- |
| **Review an issue:** inspect its source; open **Record review**, enter the resolution, and **Mark reviewed**. | The review is recorded. It does not send a customer message or substitute for completing the linked task. |
| **Uncertain delivery:** administrator creates a controlled uncertain-send fixture; inspect Front, then use **Delivery queue → Review delivery** to link verified delivery, cancel, or retry only after confirming it did not send. | Uncertainty is visible and there is no automatic duplicate customer send. A retry requires explicit evidence and notes. |
| **Failed event:** after its underlying cause is fixed, use **Event processing → Repair processing → Replay saved event** with a reason. | The saved event processes once; existing activities/tasks are not duplicated and original deadlines remain. |
| **Repair history:** after activation, use **Advanced tools → Repair missing history**, enter a reason, and restart the appropriate provider search. For one test conversation, let the administrator supply its verified reference and use **Retry conversation history**. | Missing in-scope history is recovered without resending emails. This does not promise recovery of historical SMS; inspect native history for an SMS gap. |
| **Temporary outage/rate limit:** administrator runs a controlled provider-failure fixture and restores it. | Pending delivery and commitments remain durable, issues/backlog are visible, cleanup is held during uncertainty, and recovery does not duplicate sends. |
| **Existing lead responsibilities:** use a reviewed staging batch with one missing assignment and one already-assigned lead; click **Fill missing lead responsibilities**, then further batches if offered. | The configured default fills missing duties without overwriting existing owners/dates or replaying historical first emails. This is a batch action, not a selected-lead-only button. |
| **Older Front conversation:** explicitly link a test conversation containing activity after activation. | In-scope history becomes visible on the lead; the same manager's other conversations remain separate. A cross-lead merge requires review. |
| **Access and event security:** use an existing authorized non-admin/second-user fixture and controlled duplicate, invalid-signature and wrong-scope events. | Admin settings remain protected; invalid events cause no task/send/history change; provider identities do not grant CRM access. |
| **SMS opt-out:** use a disposable consenting test contact and a coordinated opt-out test; inspect Dialpad preference and CRM issue. | An explicit STOP-style text is treated as a contact-preference issue, not ordinary sales-response work. CRM does not automatically text it back or bypass Dialpad's preference. |

**Expected:** each scenario has its own recorded result. Mark unavailable fixtures Blocked. These checks, two-person assignment, every business line, Seen availability, and the real business-day checks remain part of full acceptance even if the basic email test passes.

## Finish and report results

For each test, record **Pass / Fail / Blocked**, the TEST lead name, local time/timezone, expected result, actual result, and a CRM/Front link or screenshot where useful. Record each of the five forms and each business number separately. Do not include passwords, API keys or private sign-in/upload links.

If a message is missing or duplicated, preserve the test record and ask an administrator to inspect **Connection issues** and **Delivery queue** under **Settings → Front and Dialpad → Advanced tools → Connection issues and queues** before resubmitting or manually retrying it. A refresh and a few processing cycles are reasonable; persistent pending/error state is evidence to report, not a pass.

Keep the dedicated no-reply/calendar test active until its reminder and escalation have both been observed. After the agreed test window, **Pause delivery** to stop automated delivery and cleanup together. Have the administrator return temporary staging Dialpad subscriptions to the agreed disabled state; pausing the CRM alone does not disable provider capture. Leave test history available for review rather than bulk deleting it or changing real inbox snoozes.

**Ready for rollout review:** core email and document flow, explicit responsibilities, every required phone/text path, sidebar behavior, deadline/escalation protections, and cleanup/recovery checks all have passing evidence. Any blocked mandatory test remains an open acceptance item. Completing this guide does not deploy or activate production.

Implementation reference: [rollout and recovery runbook](COMMUNICATIONS-RUNBOOK.md). The linked provider help pages describe Front behavior; the CRM button names and expected workflow above were checked against the current implementation.
