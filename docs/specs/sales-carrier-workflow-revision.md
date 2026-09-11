# Sales, managers and carrier work

## Final revision specification — business decisions confirmed

September 10, 2026. **Specification only; these revisions are not implemented or deployed.** This document replaces conflicting ownership, escalation, reporting and routine task-entry proposals in earlier Front/CRM planning documents. Existing staging verification remains evidence for the implementation tested at that time.

For the pre-implementation business review, see [reminders by role and the complete workflow email catalog](reminder-behavior-review.md). It explains triggers, satisfaction evidence, manager/owner escalation and the value of each internal report. It also makes explicit that weekly informational updates should not generate unnecessary two-day prospect chases and that starting renewal preparation is distinct from completing the renewal.

The operating rule is simple: **Salespeople handle prospects. Deal champions handle carrier work and become the client's main contact after binding. Managers make sure their people keep up, and escalate to the owner when work remains unhandled. The communication and business records document the work.**

An agent should spend their day replying, calling, texting and selling. A champion should spend their day marketing accounts and obtaining quotes and carrier confirmations. The system should supply the next step, the reminder and the record without asking either person to maintain a second task diary.

## 1. Confirmed decisions and policy defaults

### Confirmed by the owner

- Every lead has a salesperson and a deal champion. A person may hold both responsibilities.
- While an account is a lead, the salesperson owns client/prospect communication, including collecting information and presenting options.
- The champion owns carrier communication, marketing, quotations and carrier work toward binding. While an account is a lead, a champion contacts its prospect only when the salesperson asks for help.
- A sales manager is assigned to each salesperson in Team settings, not to each lead. Late sales work escalates to that manager, never automatically to the champion.
- Overdue carrier work escalates to a designated carrier/marketing manager.
- Salespeople and sales managers receive daily lead reports and automated reminders relevant to their responsibilities. Champions receive carrier-side and post-bind renewal reminders, including direct renewal client contact. Prospect contact requires an explicit salesperson help request.
- Scheduled reminders and these reports arrive at **9 a.m. Eastern on business days**. New inbound messages remain visible when received.
- The initial no-reply follow-up is after two business days. Responses and callbacks are due within one business day. Escalation begins on the next business morning after a missed deadline.
- For a silent prospect, the first two follow-ups use two-business-day intervals; subsequent follow-ups use five-business-day intervals. Each interval after the first starts with actual outreach, not with a reminder being sent.
- **Salespeople manage leads only.** Their daily work, follow-up reminders and sales-manager escalations cover lead work. After binding, renewal management and related client communication belong to the deal champion; do not retain sales as the operational owner or send sales reminders about bound-client renewals.
- After binding, the champion contacts the client directly about renewals. No salesperson help request or sales intermediary is required for that renewal communication.
- After binding, the champion is also the main contact for non-renewal service and coordinates certificates, policy changes, billing questions and claims routing with the appropriate specialists. Sales remains focused on leads.
- Begin renewal preparation 90 calendar days before expiration, honor carrier-specific submission deadlines, and target usable quotes 14 calendar days before expiration. These are agency planning targets, not carrier guarantees.
- A genuine completed outbound call attempt counts as timely outreach even when unanswered. It does not establish that the person's question or an underlying business requirement is resolved.
- **Next year:** deliberately advance the lead's incumbent expiration exactly one calendar year and resume salesperson outreach 90 calendar days before the new date. Suspend ordinary chasing in between; no agent-selected action date is required.
- Both sales and marketing managers escalate unhandled work to the agency owner. Preserve the one-business-day manager recovery window and the 9 a.m. escalation schedule.
- Email, text and call activity automatically records contact and advances matching routine work. No required “What happened?”, routine completion form or agent-selected follow-up date.
- Front cleanup is automatic when the conversation is safe to close. Archiving or snoozing never changes the team's commitment.
- Eligibility controls who appears in assignment choices; it does not grant or remove CRM permissions.

### Resolved policy choices

The core role decisions and the six remaining operating policies are confirmed. The [business decision record](sales-carrier-business-decisions.md) records the owner's choices, including the annual incumbent-date rollover that replaces the earlier “Revisit at renewal” proposal. These policies are specified here; they are not yet implemented or deployed.

| Decision | Confirmed policy |
| --- | --- |
| Overdue carrier work | Escalate to a designated carrier/marketing manager |
| Silent prospect | First follow-up after two business days, second after another two business days from actual outreach, then five-business-day intervals |
| Sales scope | Salespeople manage leads only. Binding ends ordinary sales lead work and escalation; renewal responsibility belongs to the champion |
| Bound-client renewal contact | Champion communicates directly with the client |
| Other client service after binding | Champion remains the client's main contact and coordinates with specialists |
| Renewal preparation / usable-quote target | 90 calendar days / 14 calendar days before expiration, respecting earlier carrier requirements |
| Unanswered outbound call | Counts as outreach effort; unresolved requests remain tracked |
| Catch a lead next year | Advance incumbent expiration one calendar year; salesperson outreach returns 90 calendar days before the new date |
| Unhandled manager escalation | Owner receives the next escalation after the manager's one-business-day recovery window |

Confirmed routine targets are one business day for first contact on a manually entered lead and presentation of ready quotes; two business days for carrier and renewal-information follow-ups; and a weekly prospect update while carrier work progresses. Normal substantive communication satisfies the update. Existing carrier lead times and fixed requirements take precedence. These are agency policies, not dates agents choose for each task.

Actual manager names, owner/fallback identity, coverage, staff delivery addresses and the agency calendar are setup data to validate before activation. Remaining internal implementation conventions are specified below; no additional business-policy choices are pending from this decision pass.

## 2. A normal working day

**Salesperson:** Open the morning lead report or Front. See “Reply to Oak Ridge about the documents” or “Follow up with Cedar; no reply since Tuesday.” Open the original conversation and reply, text or call. The system records the contact, resolves the matching response reminder, schedules any next follow-up and cleans up the conversation when safe. No separate log is required. Bound clients are not kept on this lead reminder list.

**Sales manager:** Open one morning report covering direct reports. See who has overdue work, the actual request, the last human contact or attempt, and the next action needed. Open the conversation, ask the salesperson to handle it, take over that particular response, or reassign the salesperson. Merely reading or acknowledging an escalation does not close the underlying obligation.

**Deal champion:** Open the carrier work list or morning report. See accounts needing marketing, expiring coverage without usable quotes, carrier requests and outstanding bind confirmations. Work in the existing quote, document, carrier and bind screens. Their saved business records and actual carrier communications advance the work automatically.

**Owner on the road:** Rely on managers for ordinary missed commitments. If a manager has not gotten the required work handled within one business day of escalation, it appears in the owner's next 9 a.m. exception report. An owner who is also a manager gets one combined report. Healthy work does not produce duplicate owner reminders.

## 3. Responsibility and routing

| Work | Responsible person | Escalation / collaboration |
| --- | --- | --- |
| First lead contact; prospect email/text; return prospect call | Salesperson | Their sales manager |
| Chase a prospect's documents, facts, signatures or decision | Salesperson | Their sales manager; champion sees the carrier work that is blocked |
| Explain or present a new-business quote; maintain prospect updates while marketing proceeds | Salesperson | Their sales manager |
| Approach carriers; submit a risk; respond to underwriting questions | Deal champion | Designated carrier/marketing manager |
| Chase a carrier response or quote; renewal marketing; carrier bind confirmation | Deal champion | Designated carrier/marketing manager |
| Obtain missing prospect information needed by a carrier | Salesperson | Champion requests the needed information through an internal handoff |
| Manage renewals after binding, including client emails/calls and collecting renewal information | Deal champion | Carrier/marketing manager |
| Non-renewal client requests after binding | Deal champion as the main client contact; specialists perform their assigned work | Carrier/marketing manager; owner if the manager does not resolve the escalation |
| Help with one client conversation at the salesperson's request | Requested champion or approved covering teammate | Salesperson retains client accountability and their manager remains the escalation destination |
| Unknown association on a call/text or missing contact details | Designated intake coordinator | Coordinator's configured operational backup; do not leave it in an ownerless list |
| Failed integration, undelivered internal report or incomplete synchronization | Designated integration administrator | Named operational backup; staff see the effect and next useful action |
| Required work remains unhandled after manager escalation | Sales or marketing manager accountable for recovery | Agency owner at 9 a.m. after one business day |

Route by both **business context** (open lead opportunity, renewal or existing-client service) and **communication side** (client or carrier). Do not label a bound client's email as carrier communication merely because its owner is a champion. Likewise, a champion's temporary help with a lead remains client-side lead work under sales accountability.

### Team settings

1. Retain salesperson and champion eligibility. Add sales-manager eligibility and one **Sales manager** selector on each salesperson's Team record. Managers can have multiple direct reports. A manager may also sell or act as a champion.
2. Keep this relationship out of account forms and lead creation. Resolve a lead's current sales manager through its salesperson at the time of reporting and dispatch.
3. Use an admin-controlled assignment record. Do not add a manager field to the ordinary self-editable UserProfile path. Validate writes on the server and audit them through the established activity system.
4. Reject self-management and reporting cycles. A selling manager reports to another designated manager or to the agency's configured owner fallback. The agency owner is the terminal accountable person, not their own escalation recipient.
5. Split the current single default into **Default salesperson** and **Default deal champion**. Preserve the currently selected person in both fields during migration; Brian remains the intended production default until changed by an admin. No round-robin or automatic workload redistribution is introduced.
6. Admins can designate temporary coverage with start/end dates. Missing, disabled or unavailable owners route to their configured backup and create an assignment exception. Managers receive unresolved sales coverage gaps. Preserve existing relationship ownership unless a person deliberately reassigns it.
7. Validate manager/backup mappings for every active salesperson before enabling the revised escalation flow. An enquiry must still be captured if a mapping subsequently breaks; the configured fallback receives the exception.
8. Keep Front and Dialpad identifiers behind deliberate edit controls, with validation and normal app styling. Ordinary users see names and readable phone numbers.

The designated carrier/marketing manager and their operational backup are agency Team settings, not extra account fields. If the manager is also the champion on an item, route unresolved oversight to their designated backup rather than notifying them twice or declaring the item escalated to themselves.

### Front assignment

While the account is a lead, client conversations normally belong to the salesperson or designated sales cover; carrier conversations belong to the champion or champion's cover. Do not transfer a prospect's conversation to a champion because sales is late. After binding, client conversations and renewal work belong to the champion under the handoff in section 10. Routing a specialist's work does not silently remove the champion's responsibility as the client's main contact.

An escalation is a separate oversight obligation linked to the salesperson's existing work. Deliver it directly to the manager in their own report and CRM notifications. Reopening a Front conversation assigned to somebody else is not proof that the manager was notified. Do not silently steal the conversation or lead assignment to manufacture delivery.

Manager actions are **Open conversation**, **Handle this response**, or **Change salesperson**. Handling a response gives scoped temporary coverage; changing salesperson is an explicit existing business assignment action. Either action retains the original deadline and history. Completed manager contact counts as actual client contact; no “escalation complete” form follows it.

## 4. Automatic timing

Business time is 9 a.m.–5 p.m. Eastern, Monday–Friday, excluding agency holidays. Use the established eight-staffed-hour calculation for a one-business-day response, with daylight-saving handling. A reminder date and a contractual/business deadline are different facts.

| Situation | Automatic next step | Morning reminder / escalation |
| --- | --- | --- |
| New website lead with the initial AI email successfully sent and no subsequent prospect response | Salesperson makes the first human follow-up after two business days | 9 a.m. on the second business date; sales manager next overdue business morning |
| New manual/import/phone/email lead with no recorded contact or unanswered request already tracked | First human contact within one business day; do not create a second task if captured activity already establishes the appropriate next step | Due business morning; manager next overdue business morning |
| Substantive prospect reply, text or missed call/voicemail while a lead | Reply or return the call within one business day of the first unanswered request | 9 a.m. on the due business date; sales manager next overdue business morning |
| Bound client sends a reply, text or missed call/voicemail | Champion responds or returns the call within one business day and coordinates any specialist work | 9 a.m. on the due business date; marketing manager next overdue business morning |
| Substantive carrier request | Champion responds within one business day | Due business morning; carrier escalation recipient next overdue business morning |
| Successful human outreach while waiting for a prospect | Next follow-up follows the cadence selected in section 1 | 9 a.m.; count cadence steps from actual contact, never from reminder delivery |
| Carrier outreach awaiting a response | Champion follow-up after two business days, or sooner when an existing carrier/term deadline requires it | 9 a.m.; fixed submission and expiration deadlines remain unchanged |
| Usable new-business quote becomes ready for the prospect | Salesperson reviews/presents it within one business day; champion retains any remaining carrier requirements | Salesperson's due morning, then sales manager if overdue |
| Usable renewal quote becomes ready for the bound client | Champion reviews/presents it within one business day | Champion's due morning, then marketing manager if overdue |
| Outbound call does not connect | Record completed outreach effort and schedule the next attempt; a missed-call return attempt gets a next-business-morning retry before ordinary prospect cadence resumes | Preserve the unresolved request; a timely attempt is not an overdue staff failure. Escalate a missed next attempt or a still-unfulfilled business promise |
| Lead waiting on carrier work, with no outstanding prospect response | Prospect progress update after five business days without a human client update | Salesperson's 9 a.m. report; normal communication satisfies this without an extra status email |
| Work remains overdue after the first escalation | Keep the obligation in the responsible person's and manager's subsequent morning reports | One consolidated edition each business day until handled; no one-shot disappearance |
| Manager escalation remains unhandled for one business day | Owner intervention | Owner's next 9 a.m. exception report; no reset from reassignment, acknowledgement or delivery retries |

**Example:** A request arrives Thursday after business hours. Its response deadline is Friday at 5 p.m. Friday's reminder arrives at 9 a.m.; it does not reopen again at 5 p.m. If unresolved, it appears in the manager's Monday 9 a.m. escalation report, assuming no holiday.

For deadlines before 9 a.m., on a weekend or holiday, surface the work on the preceding business morning. New inbound activity after the morning batch remains immediately actionable in Front/CRM; it does not cause an afternoon scheduled reminder. Late dispatch outside the established 9:00–9:09 window remains queued for the next business morning, with the missed delivery visible to operations. Never rewrite the deadline to hide the delay.

The morning report and the existing work list show the same current obligation. A daily report must not create a fresh task or duplicate comment on every iteration. On the first due morning, Front can reopen the relevant conversation and add one concise internal explanation. Subsequent days retain the same task/card; re-surface a still-unhandled conversation at 9 a.m. if someone archived or snoozed it. Send a new internal explanation only for a material change such as escalation or changed source information.

An unsuccessful outbound call counts as completed outreach effort, not an answered question. Separate the obligation to try contacting the person from their unresolved request. Record when the attempt met the outreach deadline, retain the original request and any actual business promise, and create the next attempt automatically. Escalate missed effort or stalled requirements, not the mere absence of a response from the prospect. Reports distinguish **No contact attempted** from **Tried calling; waiting to reach client**. Read receipts, drafts, automated introductions, provider failures and simply opening the dialer do not count as human outreach attempts.

After timely outreach, cleanup may close a conversation that is waiting on the other party when the next attempt is durably scheduled and no immediate business obligation blocks closing. Do not keep a salesperson's inbox open solely because an unanswered call left the original question unresolved. A failed send, new request or missed retry still resurfaces correctly.

For the approved no-reply cadence: initial outreach → first follow-up at +2 business dates; actual first follow-up → second follow-up at +2 business dates; actual second and later follow-ups → +5 business dates. A substantive prospect reply ends that no-reply episode. After the team answers it, any new waiting-for-reply episode starts with the two-day policy again. The business-date count excludes holidays. There is no automatic prospect message at any of these steps. Binding ends this prospect cadence.

When carrier work is progressing and the prospect owes no response, use the weekly update policy instead. An informational update must not create an unnecessary two-day “no reply” chase. If a specific prospect document/decision is outstanding, that obligation still uses its appropriate prospect cadence. Derive these distinctions from existing requests and business context; do not add a routine per-email tracking checkbox. The [reminder behavior review](reminder-behavior-review.md) explains these cases to staff.

## 5. Contact is the record; business milestones remain real

- A sent substantive email/text or connected, ended call completes matching contact work. A genuine ended outbound attempt also fulfills the required outreach effort, with its unanswered result retained and its next attempt scheduled. It must not be represented as a connected call or resolved question. Drafts, failed messages, automatic replies and calls still ringing do not satisfy outreach.
- Match within the account, client/carrier side and relevant contact/request. An email to one board member must not erase a different person's unanswered request; a carrier reply cannot clear a client task.
- Actual messages can satisfy a matching cross-channel request using verified contact links. Do not guess that a property manager's shared phone number identifies a particular association.
- A new client reply cancels the obsolete waiting-for-reply reminder and creates response work. Repeated messages about an already-unanswered request do not postpone its original deadline.
- A delivered initial AI email remains visible as an automated introduction. It does not produce a misleading “last human contact” date or fulfill a new substantive client question.
- Document receipt, a carrier submission, a quote, client authorization and a carrier bind confirmation are distinct facts. A courtesy email cannot mark all of them complete.
- Reuse existing document, quote, policy and bind records as the authoritative business evidence. Save the real work once in its normal screen; do not ask staff to repeat the same fact in a follow-up form.
- A usable quote automatically creates the appropriate presentation work: salesperson for new business, champion for a bound client's renewal. Presenting an identified quote through the normal proposal/communication flow supplies evidence of presentation. An unrelated courtesy email cannot mark a quote presented. After presentation, track the requested client's decision with the applicable follow-up cadence.
- A message containing a quote attachment is not automatically a verified usable quote. Existing ingestion/extraction may prepare the normal quote record; uncertain facts require review of that record, not an additional outcome diary.
- A no-reply prospect stays active with its next touch until a deliberate business disposition or the explicit **Next year** rollover in section 10. Silence alone never advances expiration, defers the lead or marks it lost. The next-year behavior is a dated lead-cycle change, not a new status menu or a free-form action scheduler.
- An explicit lost/not-fit decision stops ordinary prospect chasing. Binding uses the existing bind process. It does not erase unresolved coverage, delivery or client-service issues.
- Client acceptance creates the champion's carrier bind work through the existing authorized bind process. An email saying “looks good” is not itself authorization to mark coverage bound. Required business approval remains part of doing the bind, not a separate follow-up diary.
- Read receipts remain a helpful signal, never proof that the prospect understood, agreed or no longer needs contact.

### Showing contact clearly

Each lead work row shows **Last client contact**, date/time, direction and channel; the compact detail identifies whether it was a human reply, an attempt or the AI introduction. Reports separately calculate **Last human client outreach**. Incoming messages, AI and carrier activity must not make that metric look current. “None recorded” and “Sync delayed” must be distinguishable. Opening the row shows the original evidence rather than a second log.

## 6. Carrier marketing, quotes and binding

Use existing renewal MarketingTask, appetite, Quote and Policy records. Add the ownership and reliable business rules they lack; do not build another parallel marketing ledger.

### When carrier work appears

| Trigger | Champion's next action | What satisfies it |
| --- | --- | --- |
| New lead has enough underwriting information to approach carriers | Market the risk to appropriate carriers | Recorded, matching carrier submission; incomplete client information creates the client-side request described below |
| Client renewal preparation reaches its 90-day checkpoint | Begin the renewal with the information request or other actual current-term work needed | Actual renewal-information request or already recorded qualifying renewal work, such as a submission where sufficient facts exist; automatically creating an empty renewal record alone does not complete this step |
| Renewal enters its marketing window | Prepare and submit the renewal | Matching current-term submissions, with outstanding carrier work still tracked |
| Incumbent expiry is approaching with no usable quote | Obtain quotes for uncovered required lines | Verified quote records for the correct risk, term and lines |
| Carrier requests information | Respond to underwriting or ask sales to obtain client facts | Actual carrier response and the relevant saved business evidence |
| Submission is waiting for a carrier answer | Follow up with that carrier | Actual carrier communication; lack of a usable quote remains tracked separately |
| Client accepts an option / bind request is ready | Complete carrier requirements and obtain confirmation | Existing authorized bind workflow and carrier confirmation; sending a request alone is insufficient |
| Binding confirmed | Finish outstanding carrier/policy delivery work | Saved policy and required carrier documents; any client-delivery requirement is included in the explicit post-bind service handoff |

Begin renewal preparation 90 calendar days before the actual policy expiration, or earlier if a carrier's timetable requires it. For carrier submissions, retain the established lead-time rules: matched appetite-guide lead time, then the carrier's configured fallback, then 30 calendar days. Open the carrier submission task 14 calendar days before its computed submission deadline. The 90-day preparation checkpoint and the carrier-specific submission date are separate commitments. When these dates fall outside business days, show the reminder on the preceding business morning without changing the coverage date.

The 90-day initiation step is not a demand to finish the renewal that day. Starting actual renewal work satisfies initiation, while receipt of information, submissions, usable quotes and binding remain independently tracked through their normal business records. If qualifying work for that term already exists, do not create a duplicate “start renewal” prompt. Neither a courtesy message nor closing the initiation step can clear the later requirements.

**Confirmed quote target:** a usable quote 14 calendar days before expiration, or earlier when a recorded carrier requirement demands it. Show “No usable quote” in the champion's upcoming work once marketing opens, make it due at that target, and escalate on the following business morning. Carrier submission deadlines remain separate and can be earlier. These are agency planning targets, not guarantees of available coverage. Agents do not set routine task dates. If an opportunity arrives inside the normal window, flag the shortened timeline rather than inventing overdue work from before the team received it.

New business without an incumbent expiration starts carrier work when ready to market; a missing or unknown target coverage date becomes an owned request for sales to obtain it. Missing underwriting information, zero appetite matches and a passed expiration are visible exceptions. Do not silently skip the account because an eligibility filter produced no carriers or because its term has just lapsed.

### What “quoted” means

- Evaluate the specific lead risk or renewing policy, target term and requested lines. Add an explicit link where existing account/date fields cannot identify these reliably.
- `DRAFT` is preparation; `SUBMITTED` is marketed; neither is a quote received.
- `QUOTED` and `PRESENTED` may satisfy quote availability when the necessary terms are recorded and the quote is still applicable. `BOUND` satisfies only the risk/term/lines actually bound. Declined, lost, superseded, expired or incomplete terms do not establish a usable option.
- Identify carrier, target effective term, covered lines and the premium/terms required by the normal quote record. Quote offer validity, when supplied by the carrier, is separate from the policy's coverage expiration date; do not invent a validity period from the record's creation time. Missing risk/term linkage is a normal quote-review issue, never an automatic match to every renewal on the account.
- A quote for property does not clear missing D&O or umbrella options. A quote from another carrier may satisfy account-level quote availability, but must not falsely complete a specific carrier's outstanding request.
- A record's creation date alone is insufficient evidence. Correct the current date-only shortcuts in both the renewal sweep and report helpers so they use the same rule.
- Carrier submissions, quote availability and binding have separate derived milestones but do not require three separate staff checklists. Existing business actions supply those milestones.
- Declining one carrier is not the same as disqualifying the lead. An “out of appetite” result is evidence of that carrier outcome; if all options are exhausted, the champion receives a market-placement exception and sales receives the client decision/update work.

### Prospect information needed by marketing

The champion uses **Request client information** from the carrier request or quote context. Select the missing requirement or forward the actual carrier request internally; the source is carried into a salesperson-owned request automatically. Do not send carrier-only notes or private underwriting discussion to the client.

The salesperson asks the client for the information in their normal conversation. Contact closes the request-to-contact step; the actual information/document requirement stays visible until received and verified. The champion sees “Waiting on client information — [salesperson]” on the affected carrier work. No deadline is extended merely because the task is blocked.

This handoff is for leads. Bound-client renewal information follows the champion-owned renewal process in section 10; do not generate sales lead reminders for that work.

## 7. Asking a champion for client help

This is the deliberate exception to normal role boundaries **while the account is a lead**. The champion's post-bind renewal responsibility is a separate lifecycle rule.

1. In a client conversation, the salesperson chooses **Ask champion for help**. The current request, account, recipient and deadline are attached automatically; an optional instruction can clarify the help needed.
2. The champion receives one scoped **Client help requested by [salesperson]** item and appropriate temporary Front handling. They do not inherit the salesperson's entire client book or future client follow-ups. The request itself is the internal handoff record.
3. Keep the work classified as client work even when a champion is doing it. The salesperson remains accountable, and the salesperson's manager receives overdue client escalation. No fresh deadline is created by the handoff.
4. Actual matching client contact by the helper completes the covered communication work and records who helped. The salesperson sees the activity automatically. Future routine client follow-up returns to the salesperson, and temporary conversation routing is restored.
5. A declined/unavailable help assignment immediately remains visible to the salesperson; it is not treated as completed or accepted coverage. Existing deadlines continue. Scheduled reminders still follow the morning rule.

A person eligible for both roles can act in the role appropriate to that particular work. Eligibility alone does not create a help request. An unsolicited historical client email from a champion is still recorded truthfully, but does not change future ownership or imply a permanent delegation.

## 8. Daily reporting and reminder delivery

### One readable morning edition per person

At 9 a.m. on business days, send each salesperson and manager one concise internal report to their verified business email, with the same report available in the CRM. Champions receive their carrier edition. Combine sections when somebody has multiple roles; deduplicate the same obligation appearing as both their own work and their team's work.

Use the existing Front integration as the fixed transport for these new workflow reports, with a dedicated **internal reporting conversation/channel configuration**, separate from prospect threads. Verify recipient routing and delivery in staging. No customer receives an internal report, staff performance detail or escalation. Do not introduce an email-provider switch or silently fall back to an unrelated sender.

Classify generated reports and escalation delivery as internal system activity. Their own provider webhooks must not create leads, satisfy contact obligations, start follow-up loops or update last human contact. Delivery through Front is subject to the same verified sender, environment and test-recipient protections as other outgoing mail.

Keep the report short on mobile: action counts, a few highest-priority items and a link to the complete work list. Every outstanding item remains in the full list and downloads; a shortened email must disclose “and N more.” One report is not N separate task emails. Routine task escalation also appears in the manager's CRM notifications, with the original client conversation linked.

| Recipient | Report contents | Primary action |
| --- | --- | --- |
| Salesperson | Lead replies/callbacks due, overdue lead work, prospect follow-ups, first human contact needed, requested prospect information and progress updates; last human outreach and upcoming count | Open the actual conversation, place the call, or open the account when no conversation exists |
| Sales manager | Direct reports' lead due/overdue counts, oldest unattended prospect request, escalations, attempts already made, missing ownership/coverage and work blocked by failures | Open the original item; handle or reassign where necessary |
| Deal champion | Marketing due, incumbent/renewal expiry and uncovered lines, usable quote availability, carrier responses/follow-ups, bound-client requests and specialist coordination, outstanding bind requirements; explicitly requested prospect help in its own small section | Open client/carrier conversation, submission, quotes or bind workflow |
| Carrier/marketing manager | Overdue carrier, renewal and champion-owned client commitments and market-placement exceptions, with actual expiry and last relevant activity | Open the underlying work and arrange recovery |
| Agency owner | Work still unhandled after the manager's one-business-day recovery window, missing coverage and owned system/delivery exceptions | Open the original obligation and arrange recovery; combine with any personal manager report |

Salespeople and sales managers receive a daily edition even when nothing is due: “Nothing overdue; X upcoming” is useful only if coverage and synchronization checks passed. Champions and the marketing manager receive a morning edition when they have actionable work or an exception; their CRM report remains available on quiet days. Do not send them an empty reminder merely to prove a scheduler ran. Counts must distinguish unique accounts from action counts and disclose their as-of time.

**Example salesperson item:** “Oak Ridge — reply needed. The client sent the loss runs yesterday and asked about next steps. Reply today. Last human outreach: Tuesday, 10:12 a.m. [Open conversation]”

**Example manager item:** “Alex: 1 missed outreach. Oak Ridge has waited since Tuesday; no human outreach recorded. Alex remains responsible. [Open conversation]” A timely unsuccessful call is shown as an attempt with its next retry, not as missed outreach. A separate unresolved promise may still need escalation even when outreach occurred.

**Example champion item:** “Cedar — obtain D&O quotes. Incumbent expires October 1. Property quoted; D&O still missing. Quote target September 17. [Open quotes]”

### Reporting rules

- Resolve managers and report membership from current admin-controlled team relationships. Never let the client supply an arbitrary manager ID or report scope. Apply existing CRM access rules without treating manager eligibility as a new broad permission.
- Provide **My work** and, for assigned managers, **My sales team**. Agency-wide oversight remains available under existing authorized access. Do not email somebody every agency account because they are eligible to manage people.
- Do not equate message volume with performance. Report response timeliness, overdue age, coverage gaps and meaningful contact; show attempts and blocked work honestly.
- Include incomplete capture/sync as “Some activity is delayed — these counts may be incomplete,” with an owned operational issue. Never claim all leads are covered because a query failed or only one page was read.
- Allow CSV download from each report/dashboard view, including full paginated scope, applied filters, readable staff names, dates with timezone and as-of/completeness information. No raw integration IDs. Mitigate spreadsheet-formula injection in exported text.
- Consolidate overlapping sections of the current 7 a.m. marketing digest and 7:20 a.m. owner rollup into this 9 a.m. workflow report. Preserve unrelated finance/licensing reporting behavior and audiences; do not globally reschedule unrelated jobs as a side effect.
- Separate report construction from durable delivery, with one edition per environment, recipient and business date. Retries must not flood an inbox. An uncertain send must be reconciled rather than blindly resent. Recipients and open-task state are revalidated before dispatch.

## 9. Simple screens

Keep the current three work views: **Needs attention**, **Upcoming**, **All open**. They are filters, not a growing menu of workflow statuses. Show role-appropriate work by default; optional team/report controls stay separate.

Needs attention contains unanswered requests, due/overdue work and blockers that require that person to act. Upcoming contains future dated commitments; a carrier label alone must not make every future item appear urgent. All open is the complete current scope. A renewal waiting for its future marketing window is upcoming, not an alarm.

Each work item answers four questions in ordinary language:

1. **Why am I seeing this?** The unanswered request, missing quote or approaching marketing deadline.
2. **What do I do?** Reply, call, request information, submit, review a quote or finish carrier binding work.
3. **Who is responsible?** The person's name, with a manager or helper only when relevant.
4. **When?** A readable deadline and last relevant contact; the system chooses the routine reminder.

Provide one primary action linking to the actual work. Display the source request directly when useful. The Front sidebar should be compact enough that the next step is visible without scrolling through settings or a history log.

Remove residual routine “Add action,” “Edit due date,” “Complete with outcome” and “What happened?” entry points, including legacy API paths that could recreate an obsolete routine flow. Preserve existing explicit business decisions and exceptional legacy promises without inviting staff to choose arbitrary dates. Do not add a “snooze CRM commitment” replacement.

Optional notes remain optional. Integration diagnostics, raw payloads and repair controls stay in advanced admin tools. If cleanup is blocked, say the specific reason and action, such as “A client reply still needs an answer” or “Email sync is delayed; review this conversation before closing it.” Say an administrator was notified only when delivery is confirmed. A bound account with no pending work should not display an unexplained generic warning.

## 10. Coverage throughout the lifecycle

### Every lead enters the system with a next step

All six creation-only sources remain: **Google Ad Website, Organic Website, Phone, Email, Meta Ad, Property Manager**. Website attribution distinguishes organic and Google advertising; staff cannot later change lead source casually. Explicit creation and ingestion paths must carry the same guarantees.

Creation saves the lead, salesperson, champion and the appropriate first communication commitment or owned intake exception durably. Include website forms, manual entry, import/extraction, known incoming calls/emails and existing active leads. A missing Front conversation cannot prevent a task or report; use the CRM account link until a conversation is created.

A website lead whose initial AI email is still queued or failed also needs an owned first-response/delivery exception. Do not treat queue acceptance as contact or wait forever for automation. Surface human first-response work within one business day when no introduction has actually been sent, and preserve the existing human-takeover fence so a late AI job cannot send a duplicate introduction after a teammate handles it.

For new in-person prospects the unavoidable input is a short lead capture: contact, association and source. The system cannot record an encounter it never received. It should not require a second handoff form afterward. Existing recorded contact supplies context when available.

Unknown or ambiguous contacts stay in an intake coordinator's timed queue. Linking them later must backfill history and preserve the original unanswered-request date, without inventing a later deadline. No shared phone number should cause an automatic association guess.

### Next year: advance expiration and catch the lead automatically

This is an explicit business decision to pursue a lead's next incumbent term. It replaces the earlier proposal to set a “Revisit at renewal” action.

1. Provide one deliberate **Next year** control on the lead/account and Front sidebar. It advances the saved lead incumbent expiration exactly **one calendar year from its existing value**. The user does not choose a task date or write an outcome paragraph. Briefly show the new expiration and calculated return date so the result is clear.
2. Derive `salesReturnDate = newIncumbentExpiration − 90 calendar days`. At 9 a.m. on that business date, put the lead back in its current salesperson's Front work and morning report with **Reach out about the upcoming renewal**. If the threshold is a weekend or agency holiday, use the preceding business morning, consistent with other dated reminders. Missed outreach follows salesperson → sales manager → owner escalation.
3. Between rollover and that date, suspend ordinary prospect chasing and weekly progress prompts for the deferred opportunity. Keep the lead, source, owners and history. Show it in Upcoming with its new expiration and return date; do not mark it lost, duplicate it as a new lead or invent a new status dropdown.
4. Record the previous date, new date, actor, time and current-cycle reference in the existing activity history. Recalculate future marketing/quote milestones for the new incumbent term and supersede only the obsolete chase/marketing targets for the deliberately deferred opportunity. Suppress obsolete queued initial-email operations for that cycle using the existing conditional send fence. Preserve already-sent messages and old quotes/submissions as historical evidence; do not change them to “quoted,” “bound” or “lost” just to stop reminders. Returning at 90 days prompts the salesperson; it does not send another AI introduction automatically.
5. A substantive new prospect request remains actionable immediately. Rollover cannot erase a pending client question, active bind requirement, separate coverage opportunity or earlier explicit promise. Those items keep their own evidence and obligations. After they are handled, the future return checkpoint remains unless the lead's business state actually changes.
6. The return checkpoint is durable and included in the independent coverage sweep. Reassignment routes the future return to the current salesperson without changing its date. A missed job is recovered from the saved date, never by adding another year. No worker automatically rolls silent leads forward each year.

**Example:** incumbent expiration **December 1, 2026** → Next year → **December 1, 2027**. The salesperson is reminded at **9 a.m. Eastern on September 2, 2027**, exactly 90 calendar days before the new date, assuming the normal agency calendar.

Implementation conventions: use date-only calendar arithmetic, not `365 days` or elapsed milliseconds. Preserve month/day; for February 29 rolling into a non-leap year, use February 28. If the original expiration is missing, require that business fact before rollover rather than inventing it. If adding exactly one year still leaves the return threshold in the past, surface it on the next eligible 9 a.m. batch and flag the stale date; never loop forward several years silently. A duplicate click/retry of the same operation must return the same updated date, not advance it twice. Save and validate the previous date/version for concurrency safety.

This updates the **lead's incumbent planning date** as requested. It does not amend an issued Policy's coverage dates or assert that the incumbent carrier has actually renewed coverage. Preserve provenance so the next conversation can verify the upcoming term without losing the historical expiration.

### Every active lead stays covered

A bounded, paginated coverage sweep compares actual active accounts with workflow and business obligations. It checks owners, manager/backup routing, first human contact, next client touch, annual-rollover return dates, unanswered requests, carrier marketing eligibility, missing required facts and synchronization health. Every applicable client and carrier side has either an actionable commitment or a dated next check; “waiting” alone is not coverage. A deferred lead with a valid next-year return checkpoint is covered; the sweep must not recreate weekly chasing before that window.

Repair a missing routine commitment from its actual source and policy; do not reset it to today. Uncertain repair becomes an owned exception. Preserve existing valid dates, contact evidence and explicit decisions. Never let the twelfth retry, a disabled employee, a filtered-out carrier or a missing account-read result silently remove live work.

Escalations stay visible every business morning until the required work is handled or its actual business obligation is legitimately resolved. Both sales and marketing managers escalate to the agency owner when required work remains unhandled after one business day of manager escalation: include it in the next 9 a.m. owner exception report and subsequent editions until recovered. For example, manager escalation Monday at 9 a.m. leads to owner escalation Tuesday at 9 a.m. if the required work is still unhandled, absent a holiday. Acknowledging, forwarding or reassigning does not reset this clock. Anchor the owner date to the scheduled manager escalation, not a read receipt or delayed retry. Expose delivery failures truthfully rather than mislabelling them as manager inaction. Avoid self-escalation/duplicate reports when the owner also fills a manager role.

Managers arrange eligible temporary coverage once in Team settings when a teammate is away. They remain accountable for coverage; an absent owner is not grounds to suspend lead deadlines. Missing manager/backup configuration creates an owned agency-fallback exception, with the original work preserved.

Independently monitor the scheduler/processing path and the coverage sweep. A worker cannot certify its own continued operation just by writing a heartbeat when it happens to run. Failed internal-report delivery and missing daily editions are also owned operational exceptions. Current app health can change immediately; staff reminder delivery still uses the 9 a.m. rule.

### Binding and existing clients

**Confirmed:** Salespeople manage leads only. Binding retires ordinary salesperson lead work and its sales-manager escalations. Retain the original salesperson for history and production attribution, not as the operational owner of the bound client's service. The champion becomes the client's main contact for renewals and non-renewal requests and coordinates with specialists. The designated carrier/marketing manager oversees this work and escalates to the owner when needed.

Create or verify the durable champion-owned renewal record from the actual bound policy and term. Schedule preparation 90 calendar days before expiration, alongside the carrier-specific submission and 14-day quote targets. A healthy bound client has a future renewal checkpoint, not indefinite two-day prospect chasing. Missing policy/expiration/ownership facts create a champion-owned handoff exception.

Preserve unfinished carrier/bind/document obligations. An unanswered request does not become “answered” because the account converted. Transfer applicable renewal and client-service work to the champion with its sources and deadlines intact. The champion routes specialist execution to a named person/team using the existing work context and remains responsible for coordinating the client's response; forwarding to a shared inbox alone is not a completed handoff. Include certificates, policy changes, billing questions, claims routing and outstanding policy/document delivery. Specialist business records and communications supply progress; no second outcome diary is required.

**Confirmed client contact:** the champion obtains renewal information and handles the bound client's replies/callbacks directly, coordinating specialist answers where needed. Apply one-business-day response timing and marketing-manager escalation. This is the post-bind exception to the lead-stage rule requiring a salesperson's help request; sales does not receive routine client-service work. Existing specialist processes continue underneath the champion's clear client ownership.

Renewal-information chase timing is two business days while a specific requirement is unanswered. Actual outreach advances the chase; receipt of the required information completes the requirement. Carrier submission, quote and expiration targets continue independently. Do not carry the indefinite prospect cadence into every healthy client relationship.

Partial binding must not stop follow-up for remaining new-business coverage. Apply completion to the specific risk/term/lines; if the current account-wide LEAD/CLIENT stage cannot represent remaining lead work, retain a lead-context obligation linked to the outstanding quote/risk rather than falsifying the policy state. Reuse the existing quote/account screens; a new separate pipeline product is not required. Sales reports contain that still-open new-business work, not ordinary renewal work on the bound portion.

## 11. Implementation contract

These are internal engineering requirements, not additional staff-facing fields.

| Area | Required change |
| --- | --- |
| Team routing | Admin-only manager relationships, backup coverage, separate default salesperson/champion, carrier escalation destination and operational exception owners |
| Work contract | Separate **client/carrier domain** and **lead/renewal/service business context** from assignee identity and eligibility. Link the opportunity or policy/renewal/service work. Distinguish outreach effort from request resolution. Retain accountable owner, scoped helper/specialist, source, original deadlines, next reminder, manager/owner escalation dates and completion evidence |
| Escalation | Resolve current salesperson → sales manager → owner or champion → marketing manager → owner at dispatch. Preserve underlying work; replace champion-only logic in worker, reminder validation, role synchronization, notifications, UI guidance and next-wake scheduling |
| Contact processing | Preserve draft guards, ended-call evidence, verified per-contact matching, inbound ordering, outbound evidence and fixed milestone deadlines. Credit genuine unanswered attempts toward outreach, schedule retries, preserve unresolved requirements, and support cleanup while waiting for the other party. Add domain-safe helper/manager contact and distinct outreach/contact metrics |
| Annual lead rollover | Versioned, idempotent incumbent-date update by exactly one calendar year, existing activity audit, term-specific supersession of obsolete chasing, and a durable salesperson return checkpoint at new expiration minus 90 calendar days. No generic action/date form and no automatic recurring annual deferral |
| Intake | Create initial work/owned exception for every creation path, not only website automation. Avoid a window where Account exists but nobody is responsible for following it up |
| Marketing | Reuse MarketingTask/Quote/Policy records. Link term/risk/lines, distinguish submission from usable quote, map carrier work to current champion, stop date-only “quoted” shortcuts |
| Reporting | Role/team-scoped snapshots, complete pagination, counts plus completeness, durable deduplicated editions and verified internal delivery; server-generated full-scope exports |
| Coverage | Resumable account-to-obligation census, assignment/manager gaps, source-based task repair, overdue re-dispatch and independently monitored delivery/processing |
| Interface | Keep three work views, compact action guidance, automatic activity records, manager team view and protected advanced configuration |

Retain stable event/operation IDs, transactional version checks, the existing contact fence, bounded writes, replay safety, signed webhooks, strict provider scopes, no credential forwarding and safe send reconciliation. A throttle or failed read is a retry/issue, never proof of deletion or a duplicate event. All history joins and reports paginate; transactions must remain below provider limits.

A change in salesperson, manager, champion or temporary cover updates future recipients and pending deliveries with version checks. Old assignments must not receive newly generated reports after reassignment. Historical notifications keep their actual recipient/evidence. An already delivered email is not represented as recalled.

Do not infer binding or agreement from communication sentiment. Do not send automated prospect chase emails/texts as part of this revision. Preserve the existing single initial AI email, readable website-submission email and same-conversation behavior. Authentication, invitations, unrelated financial functionality and production sender selection are not redesigned here.

## 12. Migration and acceptance

### Safe revision sequence

1. Build against the confirmed business policies and decision record. Prepare compact examples of salesperson, manager, champion and owner reports plus the next-action sidebar and Next year control for design review. Business decisions are resolved; staff mappings and operational configuration still need validation.
2. Add backward-compatible backend contracts first. Keep the website and CRM compatible during independent Amplify deployments. New required fields need additive deployment and verified readiness before enforcing them.
3. Configure actual team managers, carrier escalation recipient, operational owners, backups and internal-report recipients. Do not invite staff or invent manager assignments to make validation pass.
4. Backfill in resumable, conditional batches: preserve roles and deadlines; map client/carrier purpose and lead/renewal/service context; create missing first work; connect marketing obligations; turn one-shot escalations into continuing manager/owner oversight. Credit verified historical call attempts without pretending questions were answered. Do not auto-roll old leads to next year or manufacture client-help requests.
5. Migrate old report schedules and notification receipts without resending already delivered work or clearing unresolved tasks. Keep an auditable migration summary, coverage counts and rollback compatibility.
6. Deploy and verify staging. Observe real morning delivery and overdue escalation with distinct people. Only then assess production rollout separately. This specification does not authorize production deployment.

### Required acceptance cases

| Test | Expected result |
| --- | --- |
| Two salespeople have different managers but share a champion | Each manager sees only their direct report's escalation edition; champion gets no routine client reminder |
| Salesperson is late replying | Sales work remains theirs; correct manager receives next overdue morning escalation and sees it on later mornings until handled |
| Manager views, acknowledges or reassigns the escalation | Required work remains tracked and owner-escalation date is unchanged; administrative acknowledgement is not client/carrier completion |
| Sales or marketing manager leaves required work unhandled | Owner receives the next 9 a.m. escalation after one business day; it persists in consolidated reports until recovered, with no self-escalation loop |
| Salesperson attempts an unanswered callback | Timely outreach is satisfied automatically, original unresolved request survives, next retry is scheduled, and neither staff-failure escalation nor cleanup blocking occurs solely because nobody answered |
| Champion receives a carrier request | Carrier work goes to champion; sales manager receives no carrier escalation merely because sales owns the account |
| Salesperson asks champion for client help | One scoped client-help item, original deadline, sales-manager accountability; helper reply records completion and future client ownership returns to sales |
| Carrier needs client documents | One salesperson-owned client request plus the champion's linked blocked requirement; contact alone does not claim documents arrived |
| A client email is drafted, fails, then is actually sent | Draft/failure do not fulfill the task; the actual send does, once, without an outcome form |
| Connected call / ended unanswered attempt / in-progress call / duplicate call legs | Actual contact and attempts advance their correct obligations once; in-progress calls do not; no duplicate callbacks or false resolved questions |
| Reply arrives before reminder, or delayed events arrive out of order | Obsolete reminders are suppressed; sources/deadlines do not rewind; newer unanswered requests survive |
| Same manager/rep/champion person or changing manager | One combined report per person; no self-escalation loop; future delivery uses current routing and preserves original dates |
| Salesperson, champion or manager becomes unavailable | Configured cover receives work; unresolved ownership gap reaches the fallback; work never disappears |
| Manual, imported and each supported-source lead | Appropriate initial work and both lead roles exist; a missing conversation/contact becomes owned work |
| An old active account has no task | Coverage sweep detects and repairs from source dates, or raises a named exception |
| Shared property-manager number matches multiple associations | Owned intake triage, no guessed account; linking restores history and original request timing |
| Renewal has a draft, submitted, declined, old-term or incomplete quote | It is not reported as having a usable quote; correctly matched current-term quotes satisfy only covered lines |
| All carriers are filtered out or a term expires | Champion/placement exception survives; account is not silently skipped |
| Carrier quote is received but client has not been contacted | Carrier progress records correctly; required client presentation/update remains sales work |
| One line binds while other lines or requests remain outstanding | Only fulfilled acquisition/coverage work closes; remaining carrier/client obligations keep their owners |
| First follow-up and later cadence | Actual contacts advance the selected cadence; ignored reminders do not reset the clock or advance the attempt count |
| Next year on incumbent expiration December 1, 2026 | Date becomes December 1, 2027; ordinary chasing pauses and salesperson work returns September 2, 2027 at 9 a.m. Eastern; source, owners and history are retained |
| Annual rollover across leap year, weekend/holiday, missing or stale date | Calendar-year arithmetic and defined business-morning handling; no fabricated date or silent multi-year jump |
| Duplicate rollover request, concurrent date edit or replay | One versioned rollover, no accidental extra year; previous date and actor retained in the existing activity history |
| Deferred lead is reassigned or the return job is interrupted | Correct current salesperson receives recovered 90-day outreach; coverage sweep detects a missing checkpoint without recreating early weekly chasing |
| Deferred lead receives a new request or has a separate open promise/bind obligation | Immediate work remains visible and its deadline/evidence survive; rollover does not hide obligations or amend an issued policy |
| Client renewal preparation and quote target | Champion preparation at 90 days, carrier-specific submission timing, and usable-quote target at 14 days; actual quote status/term/lines determine completion |
| Normal substantive prospect reply during carrier marketing | It satisfies the weekly update without requiring a second status email |
| Informational update while waiting only on carriers | Weekly client-update cadence remains; no redundant two-day prospect-response chase appears unless the prospect actually owes a response |
| Champion begins renewal preparation at 90 days | Recorded initiation clears the start step; outstanding documents, carrier submissions, quotes and bind requirements retain their own evidence and deadlines |
| 9 a.m., holiday, DST and legacy 5 p.m. deadline | Correct morning delivery and next overdue morning escalation; no scheduled afternoon resurfacing |
| Front is archived/snoozed while a task is pending | Deadline is unchanged; due work resurfaces at 9 a.m.; automatic cleanup never hides a current unanswered request |
| No Front conversation, failed provider call, throttled task write, stopped worker | Work remains durable and owned; report exposes incomplete health; independent monitor detects the gap |
| Many pages of leads/tasks and a shortened report | Counts and downloads include full authorized scope; email truncation is disclosed |
| Morning dispatch at anticipated team and lead volume | Reports and due work fit the 9 a.m. dispatch window under provider limits; delayed work remains owned and visible rather than being dropped |
| Report send retries or has an uncertain result | One reconciled edition, no duplicate flood and no false delivery claim |
| Staff using the Front sidebar on a phone | Clear reason and one useful action; no raw IDs, routine date selection or repeated documentation |
| Existing clients after bind | Ordinary sales lead reminders stop; champion is the main client contact, owns the renewal checkpoint and coordinates outstanding service/specialist work |
| Champion contacts a bound client or hands work to a specialist | Activity remains client-side; champion retains client coordination and the specialist's work has a named owner. Escalation follows marketing manager → owner without reopening sales lead work |

Pass focused domain tests, integration/backend checks and UI builds appropriate to the implementation. Observe one genuine 9 a.m. report batch, a following business-day escalation, and continued visibility on another morning. A single-user or simulated-clock test cannot establish real team delivery. Use only authorized staging test recipients.

## 13. Current implementation gaps this revision closes

Reviewed against the local staging-line implementation on September 10, 2026:

- `shared/leadWorkflow.ts` models salesperson/champion, with no salesperson → manager relationship; escalation stops scheduling after its first delivery.
- `communications/worker.ts` routes escalated work to the champion and reopens/comments on a conversation without proving manager delivery.
- `communications/handler.ts` manual `createLead` saves the workflow but no first contact commitment.
- `communications/workflow.ts` ends all open lead tasks when an account becomes a client; replace that blanket cancellation with the explicit champion-owned client and renewal handoff above.
- Current unsuccessful-call handling does not yet separate satisfied outreach effort from an unresolved request; add the approved attempt credit, next attempt, cleanup behavior and truthful escalation.
- Annual incumbent-date rollover and the 90-day salesperson return need an explicit, durable lead-cycle operation; a generic custom task or automatic annual date bump does not meet the approved behavior.
- `renewal-tasks/handler.ts` and `dashboardStats.ts` contain quote-creation-date shortcuts that cannot establish usable current-term quotes.
- `task-digest` is a general inbox digest without an edition ledger; `ops-rollup` does not yet reconcile the new communication commitments and manager coverage.
- The automatic contact work already removes routine double entry and passed a controlled staging email test. Preserve that foundation; it does not prove the new manager, carrier or daily-report design is live.

**Definition of done:** The policy choices are resolved, managers can see and recover missed sales commitments, champions receive the correct carrier work, every applicable lead obligation remains owned and scheduled, and actual work updates the system without a second diary. Reports must prove both work coverage and data completeness. “Nothing falls through the cracks” is an operating requirement to test and monitor, not an absolute delivery guarantee.
