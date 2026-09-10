# The communication is the work record

September 10, 2026. This replaces the earlier manual completion/outcome and routine due-date flow in the Front integration specifications.

## Staff experience

Reply in Front, text from the shared line, or call through Dialpad. The actual communication remains in history. A matching sent reply or completed call closes the contact reminder automatically, schedules follow-up two business days later at 9 a.m. Eastern, and requests inbox cleanup. Staff do not retype what happened, fill in a call outcome, or choose a routine due date.

The visible Front sidebar refreshes automatically every 15 seconds after processing, pausing while a teammate edits responsibilities or writes an optional note.

An unanswered call is logged as an attempt. An existing unanswered callback retains its deadline; a first outbound attempt schedules a retry for the next business morning. New prospect replies create response work automatically. Carrier replies create the equivalent follow-up for the deal champion. The next reminder explains why it returned and what to do, with the original request alongside it.

Lost/not-a-fit decisions remain explicit under Conversation tools → Lead status. Binding uses the existing quote/bind process. Separate document or custom work can be marked done without a required note or date; its next follow-up is automatic. Optional internal notes remain available for information that is not in the conversation. Existing deliberate promises retain their dates. Snoozing in Front never changes a CRM commitment.

## Matching and recovery

- Progress requires a sent/delivered substantive message or a connected, ended call. Drafts, failed sends, automatic replies, ringing calls and calls still in progress do not satisfy a contact reminder. Provider delivery failures remain visible as issues/correction work.
- Matching stays within the same CRM account and prospect/carrier purpose. A linked conversation, matching external phone/email, or the email and phone saved on the same CRM contact identifies the person. Known different recipients in an email thread remain separate. Newer inbound requests and unknown/missing sources are not silently closed.
- Ambiguous or unlinked calls/texts still need the correct lead identified; the integration cannot safely guess which association a shared contact means.
- The task and source messages point to the actual handling communication. There is no synthetic call note pretending to describe the work.
- Existing open work is repaired from saved communications in resumable pages. Late inbound events are compared with already-recorded replies. Replayed sends cannot consume their own follow-up or move a newer commitment. Already-answered inbound events do not reopen the inbox again.
- Conditional, bounded transactions preserve recovery after partial failures and avoid the 100-write limit. Provider sending is unchanged; this feature does not send prospect messages itself.
- A contact reminder being satisfied does not establish coverage, confirm receipt of a document, or determine a deal outcome.

Call completion uses Dialpad's connection and end timestamps, with the existing call-leg grouping. See [Dialpad call events](https://developers.dialpad.com/docs/call-events).

## Verification

Automated checks cover reply-driven completion, SMS delivery, completed versus unanswered/in-progress calls, duplicate and out-of-order events, carrier separation, other contacts/accounts, preserved deliberate promises, interrupted writes, bounded histories, automatic dates, and the absence of routine completion forms. Deployment and browser verification are recorded below when complete. Real provider events and the 9 a.m. batch remain separate live acceptance checks.

Repository checks: **2,087 tests across 105 files passed**, along with the CRM build and backend type check. The 156-page website build and backend synthesis passed earlier in this change; both hosted application deployments also succeeded. No production configuration or branch was changed.

The first live check exposed a shared Front draft being classified as sent. Front includes an explicit `is_draft` flag in its [message object](https://dev.frontapp.com/reference/messages). Ingestion and saved history now retain and check that flag, reject unknown sending status, and repair earlier draft projections without discarding the original commitment. Drafts neither count as last contact nor permit cleanup. Tests cover draft-to-send transitions, stale replay, interrupted repair, and grouped requests.


## Staging deployment and live acceptance

- Implementation: `a5c8c40`; draft handling and contact pairing correction: `668d9b3`.
- Amplify CRM staging **192: SUCCEED**; website staging **191: SUCCEED**.
- Production/main remained `1b17a22d00227f6e23728b589a22b9f77d75a219`.

On September 10, the controlled Cedar test used the already-authorized prospect address `jake@jakegreasley.com` and staging sender `jake+testing@protectmyhoa.com`. Only one email was sent. The existing linked inbound text said “TEST: please call me about the documents.”

1. Before sending, the deployed history repair identified the old draft projection, removed its premature follow-up, and retained the original response commitment. Draft repair was observed at **6:38:45 p.m. Eastern**.
2. The sidebar showed the original text, the action to take, and automatic tracking guidance. It contained no routine completion/outcome form or date picker.
3. At **6:41:13 p.m.**, the test reply was sent with Front’s **Send as open** option. Front retained the message ID and updated its timestamp from draft creation to the actual send time.
4. At **6:41:43 p.m.**, the matching response task became **COMPLETE**, linked to the actual sent email. The inbound text was resolved by that same email. The next follow-up was automatically set to **Monday, September 14, 9 a.m. Eastern**, with champion escalation **Tuesday, September 15, 9 a.m.** if still outstanding.
5. The sidebar updated automatically. No Refresh, Complete, note, outcome, or date entry was used to produce this result.
6. At **6:42:45 p.m.**, cleanup was confirmed and Front displayed **Resolved in CRM Staging**. The sole open task was the Monday follow-up. **Zero internal notes** were created by this test.

Evidence: account `7b1b11b0-eb7a-4170-87ae-97cc13733888`, conversation `cnv_1hxxvna2`, sent email `msg_2tx9jehm`, inbound SMS `6305271534624768`. The response and source activity both point to the sent email as their completion evidence.

This verifies the live email-to-linked-text response path, automatic follow-up scheduling, sidebar refresh, and inbox cleanup. Call completion, unsuccessful attempts, failed sends, carrier separation, and replay/concurrency cases passed automated tests; this run did not place a new live call or send another text. The first real 9 a.m. reminder delivery and production cutover remain separate acceptance checks.
