# Sales/carrier workflow release candidate

This revision implements the approved role split, morning reminders and daily editions. The UX review starts with `WORKFLOW-UX-TEST-WORKSPACE.html`; the complete acceptance matrix and blank result sheet are beside it.

## Implemented behavior

- A compact light-green “All caught up” confirmation appears near the top of a healthy account with no open work. It replaces the empty action prompt and stays hidden when tracking, responsibility or communication needs attention.

- Separate default sales and champion owners; administrator-managed per-salesperson managers, marketing manager, owner and scheduled cover. Eligibility does not grant permissions.
- Client-side lead escalation follows sales management. Carrier, renewal and bound-client service escalation follows marketing management. The owner receives persistent unresolved escalations. Acknowledgement/reassignment does not reset a business deadline.
- Actual communication supplies outreach evidence. Drafts, failed sends and ringing calls do not. Completed unanswered attempts count as effort, with retries that preserve the underlying question.
- Automated first contact, response, callback, two/two/weekly prospect cadence, weekly carrier-progress updates and two-day information follow-ups. No routine completion form or manual reminder-date editor.
- Renewal initiation at 90 days, carrier submission deadlines and usable quotes at 14 days, scoped to actual policy/term/coverage. Partial acquisition remains sales work after one line binds.
- Client authorization is recorded once in the normal quote workflow. It creates carrier-bind work without declaring coverage bound. Changed quote terms require renewed authorization. Existing confirmed policy creation supplies the binding evidence.
- Prepared quote/document emails use Front's native draft composer. The actual matching sent message supplies presentation/delivery evidence; document delivery checks the prepared artifact. An abandoned draft has no completion effect.
- Bound clients have the champion as main contact. Specialist coordination preserves that accountability. Acknowledgement/forwarding does not deliver a requested certificate or policy document.
- Next-year rollover updates the incumbent exactly one calendar year, schedules a 90-day return, preserves independent work and issued policies, and is fenced against duplicate/concurrent changes.
- One combined internal morning edition per person/environment/date, verified staff recipients, staging allowlist, current report/CSV, durable Front receipts and explicit uncertain-send recovery.
- Active delivery requires complete manager routing. Routing edits and activation are checked together so concurrent changes cannot remove the escalation path. The independent monitor also detects invalid routing, and the report discloses missing setup.
- Indexed account relationships and a paginated all-account coverage census; persisted work retries; independent monitor and an SNS-backed alarm path. The alert destination must be confirmed before readiness passes.

## Operational details made concrete

The first carrier-bind review is due within one business day of recorded client authorization, capped by the effective date. The effective date remains the business coverage deadline. For service requests without a separate business deadline, actual interim progress schedules the next coordination touch two business days later; the initial response deadline remains its own obligation. Specific certificates/documents still require delivery evidence.

General service correspondence uses conservative acknowledgement/forwarding detection. It does not infer coverage binding, claim settlement, a financial transaction or legal authorization. Specialist outcomes outside the connected systems are not magically observable; their relevant normal CRM business record or supported delivery flow must supply evidence. The UX matrix explicitly tests this boundary.

The quote/document preparation action is intentionally part of sending the work, not a second “done” form. If a user bypasses that preparation flow, edits away the quoted facts, or changes the underlying artifact, the system does not manufacture presentation/delivery proof. The corresponding business record remains the place to review the result.

## Staging setup still required for connected acceptance

1. Verify the deployed staging build against the reviewer pack’s release record. Existing integration sender, protected credentials and business-line configuration stay in their existing settings.
2. Refresh the staging page before reviewing. Refresh restored Jake’s existing administrator controls; a new account or permission change was unnecessary.
3. In Team settings, assign the actual sales managers, marketing manager, owner, cover and exception owners. Distinct-role test recipients must be explicitly chosen. No staff invitations are part of this handoff.
4. Connect a verified Front email channel in a separate internal reporting inbox, outside the monitored lead inboxes. Add approved verified staff addresses to staging's recipient allowlist.
5. Confirm an operations subscription on the generated `communicationAlertTopicArn`. The value appears in Amplify outputs and the integration's advanced connection details. The independent failure alarm is an operational outage signal; normal staff reminders/report editions remain at 9 a.m. Eastern.
6. Check connections and controlled signed events; let the full account coverage census complete. Resume staging delivery only when the intended recipients and channels pass.
7. Record a real 9 a.m. edition, subsequent management escalation and final owner escalation using distinct controlled identities. Unit-clock simulations and the fictional preview are not evidence of scheduled delivery.

Staging delivery was deliberately paused before this deployment, with an integration Activity entry and version-checked update. It must not be described as fully connected or production-ready while these setup/acceptance steps remain.

## Verification and handoff

The local suite has 2,157 passing tests across 109 files, including real handler/store-boundary scenarios for routing, persistent escalation, annual rollover, quote delivery, partial binding and information follow-up. Frontend/backend type checks, infrastructure synthesis and both app builds pass. Re-run the documented repository gates after any further code change.

Browser checks in the local component preview exercise fictional data: sales first contact, manager report scope, champion certificate draft preparation, protected team routing, narrow sidebar widths and report email rendering. The portable HTML has no credentials and sends no messages. Its bundle was generated successfully; automated browser review used the local development preview because the browser policy blocks opening local HTML files directly. The acceptance CSV deliberately starts at **Not run** so engineering evidence is not mistaken for your UX person's sign-off.

Production/main has not been changed. Production approval requires connected acceptance and review of real ownership, monitoring and sender configuration.
