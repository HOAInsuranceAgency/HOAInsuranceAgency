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

Repository checks are being rerun after the live draft correction; final results appear below. The 156-page website build and backend synthesis also passed. No production configuration or branch was changed.

The first live check exposed a shared Front draft being classified as sent. Front includes an explicit `is_draft` flag in its [message object](https://dev.frontapp.com/reference/messages). Ingestion and saved history now retain and check that flag, reject unknown sending status, and repair earlier draft projections without discarding the original commitment. Drafts neither count as last contact nor permit cleanup. Tests cover draft-to-send transitions, stale replay, interrupted repair, and grouped requests.
