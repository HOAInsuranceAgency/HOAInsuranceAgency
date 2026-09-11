# Road-selling readiness: sales ownership and carrier ownership

Assessment updated September 10, 2026 after the owner's responsibility clarification. **Specification only; no implementation or deployment in this assessment.**

The earlier recommendation that champions take over routine prospect contact was incorrect. **Salespeople own lead relationships, sales managers oversee their salespeople, and deal champions own carrier work and become the client's main contact after binding.** A champion helps a prospect only when the salesperson asks. Both sales and marketing managers escalate unhandled work to the owner.

The authoritative next-revision plan is [Sales, managers and carrier work](specs/sales-carrier-workflow-revision.md). It records confirmed rules, implementation changes and acceptance cases. The [six-policy decision record](specs/sales-carrier-business-decisions.md) now contains the owner's confirmed choices for service ownership, timing, call attempts, annual lead rollover and manager-to-owner escalation. No business-policy questions remain from this pass; implementation is still outstanding.

## What must change before relying on minimal owner oversight

| Requirement | Gap to close |
| --- | --- |
| Managers receive missed sales commitments | Add a salesperson → sales manager relationship in Team settings. Existing overdue routing goes to the champion and stops scheduling after one escalation. |
| Champions get carrier work, not routine prospect work | Keep client/carrier domain separate from the person doing the work. Add scoped client-help requests without permanently transferring sales responsibility. |
| Carrier escalation reaches the right leader | Add the designated carrier/marketing manager, with unavailable-recipient coverage and no self-escalation loop. |
| Managers remain accountable | Unhandled work reaches the owner's 9 a.m. report after the manager's one-business-day recovery window; forwarding or reassignment does not reset it. |
| Every lead has a next step | Cover manual intake, imports, every website/source path and older leads with missing commitments; assign intake and technical exceptions to named people. |
| Reports show real coverage | Deliver concise, role-specific 9 a.m. editions to salespeople, sales managers, champions and the marketing manager. Include continuing overdue work, last human contact and incomplete-sync indicators. |
| Carrier milestones reflect real progress | Reuse marketing, quote and policy records; distinguish draft, submitted, usable quote and bound coverage for the correct risk/term/lines. |
| Ordinary work updates the system | Preserve the automatic email/text/call record. Credit genuine unanswered attempts as outreach without claiming the request is resolved; no routine outcome paragraph or date choice. |
| Binding changes the work appropriately | Stop ordinary sales lead reminders; make the champion the client's main contact, coordinating specialists and renewal preparation at 90 days. |
| Deferred leads return automatically | Next year advances incumbent expiration exactly one calendar year and brings the lead back to sales 90 calendar days before the new date. Suspend ordinary chasing in between; retain history, owners and independent obligations. |
| Nothing silently disappears | Add independent processing/delivery monitoring and an account-to-obligation coverage check; preserve source deadlines through reassignment, retries, snoozes and repair. |

Confirmed prospect cadence: first follow-up after two business days, another two business days after that actual follow-up, then every five business days after actual contact. These are staff reminders, not automated prospect messages. Missed reminders do not advance the cadence or reset deadlines.

The owner confirmed that salespeople manage leads only. Their work, daily reports and reminders cover leads. Champions become the main client contact after binding, handle renewals, coordinate specialist service and escalate to the designated carrier/marketing manager. Managers escalate to the owner. Preparation starts 90 calendar days before expiration, usable quotes target 14 days before, and carrier-specific submission deadlines remain in force.

## What has actually been tested

The existing controlled staging email test verified automatic communication logging, a response matched to a linked inbound text, next-follow-up scheduling, sidebar refresh and Front cleanup without a separate outcome form. It does not establish the new management/reporting model or production readiness.

Before relying on the revision, verify distinct salespeople, managers and champions; an actual 9 a.m. batch; a following business-day escalation and continued visibility; all intake paths; carrier quote/renewal cases; unlinked calls; unavailable staff; failed sends; interrupted processing; and the post-bind handoff. The revision specification contains the full acceptance matrix.
