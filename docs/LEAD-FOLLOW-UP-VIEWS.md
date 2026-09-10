# Simplified lead follow-up

September 10, 2026 · staging change `44c916a`.

## For staff

Open **Lead follow-up** and choose one of three views:

- **Needs attention:** prospect and carrier replies, callbacks, delivery corrections, and actions due today or overdue.
- **Upcoming:** scheduled work due after today that does not already require a response.
- **All open:** every open action.

**Responsibility** is a separate filter: all responsibilities, salesperson, or deal champion. **My leads** shows leads assigned to you. When combined with a responsibility, it shows work for the role you hold on that lead.

**Waiting on prospect** is a label beside an automatic follow-up. It is no longer a work view. The Timing column shows whether an action is overdue, due today, or upcoming; an escalated action also says Champion notified. Last contact remains visible.

Assignment and unlinked call/text cards appear below the actions in Needs attention and All open. These are shared team items and remain visible even when personal or responsibility filters are selected. Use Open lead to assign or Choose lead to take the next step. Each list retains its own pagination and retry controls.

**My reminders** is a separate expandable section below the work list. It shows reminders for the signed-in teammate's current open work.

## For administrators

Open **Settings → Front and Dialpad → Advanced tools → Connection issues and queues**. The three troubleshooting queues are Connection issues, Delivery queue, and Event processing. Existing delivery review and event replay controls remain available here. These queue reads and technical issue resolution require an administrator on the server as well as the UI. Staff retain activity linking and review of their own reminders.

## What the change preserves

Changing views or responsibility filters does not edit lead assignments, task due dates, escalation dates, or Front conversations. Snoozing in Front still cannot move a CRM commitment. Date grouping uses the agency's Eastern calendar. Old view names remain supported by the server for already-open browser sessions during deployment.

A bounded search that has more pages shows Continue searching instead of claiming there is no work. Failed reads show an error. Pagination responses from an older filter or refresh cannot replace the current result.

## Verification

- 2,024 tests across 105 files passed. New cases cover view membership, agency-date boundaries, ownership and responsibility filtering, bounded pagination, admin restrictions, readable labels, shared intake, reminders, and stale pagination responses.
- CRM frontend build/typecheck, backend typecheck, and infrastructure synthesis passed.
- Inspected the actual components in Chrome using isolated fictional fixtures at desktop and 390px widths. Verified the three choices, separate role filter, Waiting on prospect label, and shared assignment/linking cards. The narrow table scrolls inside its card.
- Updated both versions of the staging walkthrough and the operating guide to use the new locations.

## Live staging verification

CRM Amplify job **186** and website job **185** succeeded for `44c916a`.

- Chrome showed exactly Needs attention, Upcoming, and All open in the staff View selector. No technical queues appeared there.
- The response/callback fixture retained its September 10, 5 p.m. deadline and September 9, 10:37 p.m. last-contact time. Needs attention also included the manual action due later that evening.
- Upcoming showed four future follow-ups with Waiting on prospect labels. TEST Lead Brief 0910 retained September 14 at 9 a.m. for follow-up and September 10 at 8:47 a.m. for last contact. All open showed the combined six open actions.
- My leads plus Deal champion returned the appropriate empty task result for the current fixture set while the shared unlinked activity remained visible. Restoring All responsibilities restored the tasks.
- My reminders expanded and loaded successfully outside the View selector.
- The administrator opened Advanced tools → Connection issues and queues. Connection issues loaded; Delivery queue and Event processing loaded their empty results successfully.
- No assignments, action dates, call links, or provider settings were edited; no emails or texts were sent. The staff page was left open at Needs attention with My leads selected.
