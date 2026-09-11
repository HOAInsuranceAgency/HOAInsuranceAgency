# CRM workflow — UX/UI acceptance walkthrough

**Release candidate:** `codex/sales-carrier-workflow`, based on staging `6643b76`.

**Purpose:** An agent should see why work needs attention, do the real work, and move on. Emails, calls, texts, quotes and business documents provide the record. No routine outcome diary or personally selected reminder date.

## Start here

1. Open **WORKFLOW-UX-TEST-WORKSPACE.html** in Chrome. It is a portable, fictional preview of the actual components. No sign-in or installation is required.
2. Choose a role and a situation. Review **Front workspace**, **Daily report**, and **Reminder email**. The owner also has **Team settings**.
3. Repeat at **260, 340, 360 and 440 pixels**. Also check a full desktop window, keyboard-only navigation and 200% browser zoom.
4. Record each result in **WORKFLOW-UX-RESULTS.csv**. Use Pass, Fail, Blocked or Not run. Include the screen, role, steps, expected result and screenshot for a failure.
5. Complete the connected staging tests only after the release engineer fills in the deployment and setup record below.

The preview uses fictional people and a September 14, 2026, 9 a.m. Eastern report snapshot. Selecting an action may display a preview notice; it does not simulate a database transition. Links are intercepted. Reload resets the fixture. A visual pass is not proof that Front sent an email or Dialpad delivered an event.

## Connected-test readiness record

Fill these in before recording staging passes:

- CRM URL: https://staging.d2d4g940z91vj4.amplifyapp.com
- Deployed commit / Amplify job: __________
- Tester / browser / date: __________
- Salesperson A / sales manager A: __________
- Salesperson B / sales manager B: __________
- Champion / marketing manager / agency owner: __________
- Specialist / cover / unmatched-activity owner / integration owner: __________
- Separate verified Front internal-report channel: __________
- Confirmed operations-alert destination: __________
- Approved staging recipients: __________
- Connection checks pass; signed Front and Dialpad events received: __________
- Full account coverage check completed; no unexplained capture gaps: __________

Jake must supply/approve real staff mappings. Do not invite Ryan or any other staff member as part of these tests. Do not reuse one person for every role and call that proof of separate-manager delivery. Fictional preview identities are not sign-in accounts.

Previously approved prospect for controlled tests: **jake@jakegreasley.com**, **(617) 895-9530**. Staging sender: **jake+testing@protectmyhoa.com**. Shared texting line: **(508) 233-2261**. Verify these against saved staging settings before sending. Internal reports use verified staff sign-in addresses and their own staging allowlist entries; the prospect address is not a substitute staff identity.

## What should be obvious on every screen

- Why this account is here, what to do next, who is responsible, and when it is due.
- Sales handles leads. Champions handle carriers and become the main client contact after binding.
- Reply, call or text normally. No separate “What happened?” form, routine Complete button, or reminder-date editor.
- New incoming activity appears promptly. Scheduled reminders arrive at **9 a.m. Eastern on business days**. A real business deadline may still be 10 a.m. or 5 p.m.; its reminder comes that morning.
- Snoozing or archiving in Front never moves the team's deadline. Cleanup happens when it is safe.
- A call attempt is effort. A quote, a delivered certificate and bound coverage each require their own real evidence.

## A. Visual and interaction review

| ID | Follow these steps | Expected outcome |
|---|---|---|
| UX-01 | Salesperson → First contact due. Explain the screen without opening help. | Name, contact details, reason and first-contact instruction are clear. No technical IDs or duplicate documentation required. |
| UX-02 | Try all four narrow panel widths and 200% zoom. | Readable wrapping, no clipped actions or horizontal page scrolling; important controls remain reachable. |
| UX-03 | Tab through controls and expand disclosures. | Visible keyboard focus, descriptive control names, logical order; collapsed details do not overwhelm the main action. |
| UX-04 | Salesperson → Quote ready. Prepare quote email. | A draft is prepared for review; the preview clearly says nothing was sent. The actual system does not mark a draft as presented. |
| UX-05 | Champion → Client needs a certificate. | Screen says Client workspace; champion is the main contact. Ready document delivery is the clear action. Preparing another document is secondary. |
| UX-06 | Champion → Carrier needs information. | Carrier responsibility is clear. “Ask sales to obtain this information” is available, without making sales responsible for the carrier reply. |
| UX-07 | Sales manager → First contact due → Daily report. | Only that manager's direct report appears. Account, responsible salesperson, reason, deadline and recovery action are understandable. |
| UX-08 | Marketing manager → Renewal needs usable quotes → report/email. | Carrier/renewal work is clear; no routine prospect-chasing work is mixed into this role. |
| UX-09 | Owner → an overdue situation → report/email. | Persistent escalation is visible, with a link to the actual work. Merely reading the report does not resolve it. |
| UX-10 | Owner → Team settings; edit, then cancel. | Saved mappings are initially read-only. Manager eligibility, per-salesperson manager and temporary cover are understandable. Cancel discards the draft. |
| UX-11 | Healthy and connection-gap scenarios → report/email. | A healthy Front workspace shows a compact light-green checkmark with “All caught up” near the top and no empty Next action card. It says follow-up is tracked. Pending work, unresolved messages, missing owners, paused or unverified tracking never show the green confirmation. Healthy zero and a coverage gap remain distinct in reports. |
| UX-12 | Download a report and inspect the CSV. | Useful headings, actual rows, as-of/timezone/filter context; no cut-off preview falsely presented as the whole report. |

## B. Connected staging: an ordinary sales day

Use a new, clearly named `UX TEST` account for each independent scenario. Never bind a real policy or bill a real customer in a test.

| ID | Follow these steps | Expected outcome |
|---|---|---|
| SALE-01 | Create a manual lead with contact information. | Default salesperson and champion are assigned separately. First contact is due within one business day. Missing contact/ownership is visible and owned. |
| SALE-02 | Submit a new website enquiry while delivery is active. | One lead, readable internal submission, one actual AI introduction in the linked Front conversation. Queue acceptance alone is not reported as contact. |
| SALE-03 | Save a draft response, refresh, then abandon it. | The response obligation stays open; no phantom contact or presentation. |
| SALE-04 | Send a real reply to the controlled prospect in Front. | Sent email appears once; matching outreach is satisfied automatically. No outcome form. Follow-up is scheduled from actual contact. |
| SALE-05 | Have the prospect reply before the follow-up morning. | The waiting reminder is superseded by a response obligation. An old queued reminder does not reopen a completed episode. |
| SALE-06 | Leave a prospect unanswered after initial outreach. At each due morning, actually follow up. | Two follow-ups at two-business-day intervals, then weekly. Ignoring a reminder does not advance the sequence or reset lateness. |
| SALE-07 | Archive/snooze the test conversation before it is due. | CRM deadline is unchanged. At the correct 9 a.m. window it reopens, with one clear reason and next step. No scheduled afternoon resurfacing. |
| SALE-08 | Leave a due item unhandled on another morning. | It remains visible. The conversation does not accumulate a duplicate explanatory comment every day. A material escalation may add a new explanation. |
| SALE-09 | Place a call through Dialpad; first let it ring, then end it unanswered. | Ringing is not completed work. An ended attempt records effort. A missed-call return attempt gets a next-business-morning retry; the original question is not falsely marked answered. |
| SALE-10 | Complete a connected call, and send/receive a controlled shared-line text. | Correct account and actual time appear once; matching outreach advances automatically. Text sender is the shared main line. |
| SALE-11 | Salesperson asks champion to help with one prospect response; champion replies. | One scoped help assignment; original due date and sales-manager accountability remain. The reply counts automatically; future lead work remains sales-owned. |
| SALE-12 | Receive separate requests for two associations using one property-manager contact. | Ambiguous activity is assigned for review. The system does not guess from a shared number or satisfy the other association's work. |
| SALE-13 | Switch Front conversations while a draft preparation or edit is still pending. | No draft or save lands on the wrong account/conversation. |
| SALE-14 | Delay or replay a captured event using administrator tools in staging. | Replayed activity does not duplicate outreach, move dates backwards or clear a newer unanswered request. |

## C. Managers, cover and daily emails

Use distinct test identities for the connected tests. Accelerated test clocks are useful engineering evidence, but are not a substitute for at least one actual scheduled edition.

| ID | Follow these steps | Expected outcome |
|---|---|---|
| TEAM-01 | Assign two salespeople to different sales managers and the same champion. Let one sales deadline pass. | Only the appropriate manager receives that sales escalation. The champion is not the sales fallback. |
| TEAM-02 | Leave sales work overdue. | Manager receives escalation at 9 a.m. on the next business morning. If still unhandled after the manager's recovery day, owner receives it next business morning. Both keep visibility until work is handled. |
| TEAM-03 | Read/refresh the report or use “Handle this response.” | Read/administrative actions do not complete work or reset the original deadline. Actual contact is the completion evidence. |
| TEAM-04 | Repeat with an overdue carrier or renewal obligation. | Champion → marketing manager → owner; no sales-manager leakage. |
| TEAM-05 | Schedule temporary cover, change a manager, then end cover. While delivery is active, try removing a required manager or owner. | Delivery follows current responsibility, dates stay unchanged, and work returns after cover ends. No self-manager or circular-cover choices; incomplete routing cannot be saved while delivery is active. |
| TEAM-06 | Disable a responsible test identity or remove valid coverage. | No send to a disabled user; valid cover/management or an owned exception remains. No silent missing work. |
| TEAM-07 | Give one person multiple eligible roles. | At most one combined edition per person/environment/business date, without self-escalation duplicates. |
| MAIL-01 | Observe a real business-day 9 a.m. run. | Salespeople and sales managers get one daily report, including a healthy zero. Champions/marketing managers/owner/exception owners receive editions when their scope requires attention. |
| MAIL-02 | Read each role's actual email. | Why, next action, responsible name, due time, as-of time, counts, links and last relevant human contact are clear. AI email and mere inbound receipt are not mislabeled as human outreach. |
| MAIL-03 | Create more than 20 actionable items for one role in controlled fixtures. | Email explicitly shows there are more items. Current report and CSV expose the full authorized scope. |
| MAIL-04 | Retry the report scheduler after a successful send. | No second edition. A verified Front receipt marks delivery. Reading the report requires no acknowledgement. |
| MAIL-05 | Simulate an uncertain send in the engineering harness; review a corresponding staged case if needed. | No blind resend. Admin can link the original sent Front message; the server checks the edition and recipient. Wrong message is rejected. |
| MAIL-06 | Inspect the internal reporting inbox and CRM communication history. | Staff report messages never create prospect leads, satisfy outreach, or appear as client conversations. |
| MAIL-07 | Test a recipient outside the staging allowlist. | Sending is blocked with an owned delivery issue. No message reaches that recipient. |

## D. Carrier work, binding and client service

| ID | Follow these steps | Expected outcome |
|---|---|---|
| CARR-01 | Link a carrier conversation. Receive a carrier question. | Champion gets carrier work. Existing client-side work remains distinct. |
| CARR-02 | Correct an existing conversation from prospect to carrier/renewal context. | Open correspondence moves to the correct role and policy. Original deadline and completed history remain intact. |
| CARR-03 | Champion asks sales to obtain underwriting information. Sales sends the request. | Sales outreach is recorded; the underlying information requirement remains. Follow-up stays at two business days while information is owed. |
| CARR-04 | Send an informational prospect update while waiting only on carriers. | It satisfies the weekly prospect update. It does not create an unnecessary two-day chase for a reply the prospect does not owe. |
| CARR-05 | Add draft, submitted, declined, old-term and partial-coverage quotes. | None falsely satisfies the usable-quote target. Correct term, policy, coverage, premium and offer validity matter. |
| CARR-06 | Record a usable new-business quote. Prepare and actually send its quote email in Front. | Sales presentation is due within one business day. Actual matching sent quote marks presentation; an abandoned draft does not. |
| CARR-07 | Change quote terms after drafting, or remove its quoted facts from the draft before sending. | It does not silently mark the revised quote as presented. Staff review the current quote; no fabricated completion. |
| CARR-08 | Use Request binding on the approved quote; cancel once, then record actual client authorization in the normal quote flow. | Cancel does nothing. Authorization creates champion bind work, without marking coverage bound or sending a carrier email by itself. |
| CARR-09 | Send a carrier bind request; subsequently record confirmed binding through the existing bind form. | Sending the request alone does not close the bind milestone. The actual policy closes it. Review begins within one business day and never after the coverage effective date. |
| CARR-10 | Revise quoted terms after client authorization. | Old authorization does not approve changed terms. Review/re-authorization is required; no silent bind on stale approval. |
| CARR-11 | Bind one quote while another new-business quote remains open; then finish the remainder. | Partial bind preserves remaining sales work. Final acquisition handoff stops ordinary lead chasing; champion becomes main client contact. |
| SERV-01 | Bound client requests a certificate; champion acknowledges it. | Response effort is recorded, but requested certificate delivery remains open. |
| SERV-02 | Prepare the certificate through the request's button, then prepare its delivery email and send it in Front. | File is tied to the actual request. Confirmed matching file delivery satisfies it. Creating a file or abandoning its email does not. |
| SERV-03 | Repeat with a requested endorsement/policy document. | Same principle: actual associated document and delivery evidence; an unrelated upload cannot clear it. |
| SERV-04 | Champion assigns a specialist, who sends only an acknowledgement or forwards the request. | Champion keeps client accountability. Assignment/acknowledgement does not pretend the requested result was delivered. |
| SERV-05 | Complete a general service answer through normal correspondence. | Substantive answer can satisfy correspondence; a no-answer attempt or “I'll check” does not. Specific document/bind requirements retain their stronger evidence rules. |

## E. Renewals and next-year opportunities

| ID | Follow these steps | Expected outcome |
|---|---|---|
| REN-01 | Use a real policy term 90 days from the test date; allow the source-data sweep to run. | Champion has renewal preparation. Empty generated records alone do not say preparation was done. |
| REN-02 | Send the needed renewal-information request or record an actual carrier submission. | Initiation is satisfied; remaining information, submission, quote and bind work remains independently tracked. |
| REN-03 | Check carrier-specific submission requirements and a policy 14 days from expiration. | Carrier deadlines drive submissions; usable-quote target is 14 calendar days before expiration. Missing lines/ambiguous terms are owned exceptions. |
| REN-04 | Let the client or carrier owe renewal information. | Champion gets two-business-day follow-up. Marketing manager, then owner, handle missed obligations. |
| REN-05 | Test no eligible carrier, expired term and ambiguous renewal quotes. | Placement/context exception remains visible; no false all-clear or arbitrary policy match. |
| YEAR-01 | Lead incumbent expiration is December 1, 2026. Choose Next year and confirm the displayed dates. | Incumbent becomes December 1, 2027; salesperson returns September 2, 2027 at 9 a.m. Eastern. Source/owners/history stay intact. |
| YEAR-02 | Double-submit/retry the same rollover; separately edit the date concurrently. | One calendar-year move only. Conflicting edit is rejected for review. |
| YEAR-03 | Keep an unanswered request or authorized bind requirement open while deferring ordinary chasing. | Independent work remains tracked. Rollover does not change issued policy dates or erase requests. |
| YEAR-04 | Change salesperson during the deferred year, then reach return morning. | Current salesperson receives outreach; no new automated introduction; normal cadence resumes from actual contact. |
| YEAR-05 | Test leap day, weekend/holiday, missing expiration and stale expiration. | Feb 29 clamps to Feb 28; return uses the preceding business morning where needed. Missing date is requested; stale + one year does not secretly jump several years. |

## F. Coverage, regressions and release checks

| ID | Follow these steps | Expected outcome |
|---|---|---|
| SAFE-01 | Use an old active account absent from the due queue. | Full account census finds missing work or raises a named exception. A due-index-only check is insufficient. |
| SAFE-02 | Interrupt the worker, a provider request or a database write in engineering fixtures. Separately invalidate manager coverage. | Work remains durable; retries do not cancel it. Incomplete coverage is visible and independent monitoring detects the failure, including lost escalation routing. |
| SAFE-03 | Disconnect the operations alert destination in a controlled setup check. | Readiness fails; a CloudWatch alarm without a confirmed recipient is not accepted as an operating alert path. |
| SAFE-04 | Test Friday/holiday/DST and an existing 5 p.m. business deadline. | Scheduled work arrives in the 9 a.m. Eastern window. Real deadlines and escalation recovery days remain correct. |
| REG-01 | Test all website form variants and retry a failed edited submission. | One valid intake per submission; editable retries recover; readable Front brief and initial AI thread behavior remain intact. |
| REG-02 | Create leads from Google Ad Website, Organic Website, Phone, Email, Meta Ad and Property Manager. | Correct source choices; source is set at creation, then protected. Organic and ad website attribution remain distinct. |
| REG-03 | View lead work and activity. | Last contact date/time is visible and accurately distinguishes relevant human effort. Provider IDs stay protected behind deliberate administrative editing. |
| REG-04 | Download each dashboard report with filters applied. | Usable export matches the displayed report scope, including empty and larger results. |
| REG-05 | Check finance, licensing, invoices and existing policy screens. | Existing functions and unrelated reminders still work. Only overlapping sales/marketing report sections are consolidated. |

## Completion record

A UX review is complete when every visual case has a recorded result and each failure has a reproducible description. A connected release is accepted only when the staging cases have evidence or an explicitly recorded blocker, including distinct-role reports and a real scheduled 9 a.m. edition. Do not mark Not run as Pass.

Suggested issue format: **[ID] [role] [screen] — observed behavior**. Include test account, deployed commit, browser/width, steps, expected/actual result and screenshot. Identify whether the problem blocks work, gives a wrong result, or merely adds friction.

No production/main rollout is implied by this handoff.
