# Honeycomb partial submissions

Implemented September 23, 2026 on `codex/honeycomb-submissions`, based on staging commit `778f7eb`. Staging only. This is the agent-controlled partial submission phase; completing the application still happens in Honeycomb's portal.

## Agent workflow

Both Lead and Client pages have a **Submissions** tab. An eligible estimate in **Quotes** has a **Start submission from this estimate** link. The tab can also start without a linked estimate when the property details are known.

Review the legal insured name, full property address and effective date. Account details prefill the form, but total insured value is deliberately not substituted for building replacement cost. Unknown optional fields stay unanswered. Confirm the review checkbox and create the partial submission. A durable queued/processing state is shown while the carrier responds, then the carrier submission ID, creation-time status and portal link are retained on the account. A carrier decline remains visible internally and does not convert the account or create a bindable CRM Quote. Existing customer-facing decline behavior is unchanged.

Lead-to-Client conversion keeps the same Account ID, so estimate and submission history follows the account automatically.

## Carrier contract

Source: [Honeycomb Swagger](https://swagger-api.honeycombinsurance.com/swagger.yaml), retrieved September 23, 2026.

- Endpoint: `POST /v1/submissions/partial`, signed using the existing staging HMAC credentials.
- The linking field is **`estimationId`**, not a CRM quote ID. Honeycomb instructs integrations to link only when the estimate's `isOkToSubmit` is true, and to resend all original estimation input data.
- The server loads the saved estimate, verifies it belongs to this account and is eligible, and preserves its exact address and submission data. Original rating fields are read-only in the form. The public estimate receipt's 15-minute expiry is not interpreted as carrier estimate expiry.
- A manual partial submission omits `estimationId`. The API requires an address; this CRM workflow additionally requires an insured name and effective date so agents review the account and policy term.
- A successful response or `409 DUPLICATE_SUBMISSION_FOUND` with a valid submission ID is retained. Portal links are constructed on the known HTTPS staging portal host.
- No state appetite list skips Honeycomb. Unsupported states and validation rejections are handled as carrier responses.

## Persistence and retries

`HoneycombSubmission` is private, readable by authenticated CRM staff, and writable only through server functions. Custom authenticated mutations queue work or record a recovery review. API-key callers cannot read these records or invoke those mutations. No credentials are sent to the browser.

Each account/effective-date pair has a deterministic record ID. Conditional transactions and worker claims prevent duplicate requests from double clicks, concurrent callers, browser transport retries and duplicate stream delivery. Repeating a start returns the existing record. The worker runs asynchronously because Honeycomb latency can exceed AppSync's request window.

A documented validation/auth rejection permits an explicit, version-checked retry, up to five attempts, with prior input/result/actor history retained. Timeouts, malformed success, ambiguous conflicts, 5xx responses and interrupted workers become **Check Honeycomb before retrying**. They never automatically repeat the carrier request. An agent must check the portal or Honeycomb support and record a note, then either link the existing submission ID or confirm none was created before an explicit retry. A worker still marked RUNNING after two minutes is shown and reviewed the same way; its Lambda timeout is 90 seconds.

The effective date stays fixed on a correction. Use New submission for another term. Multiple submissions for the same account and term are intentionally prevented by this first workflow; separate property submissions would require an explicit property identifier in the dedupe scope.

## Environment and validation

Both resolver and worker are disabled outside staging. Only the staging worker resolves branch-scoped Honeycomb secrets; the outbound client accepts the exact staging API host and disallows redirects. Backend synthesis checks these constraints for staging and main.

The full CRM suite passed (2,239 tests). A real signed staging request with synthetic data at Honeycomb’s documented example address successfully created a partial submission with a carrier ID and declined status. No customer account was submitted.

Focused tests cover preserved estimate inputs, cross-account rejection, authentication/staging guards, validation, duplicate requests and deliveries, explicit retries, timeout recovery, account conversion continuity, pagination, loading UI and safe portal links. CRM/backend type checks, the production frontend build and staging/main synthesis are part of validation. Browser review covers a 390px phone viewport and the create/loading/result flow using synthetic local fixtures.

Production requires separate credentials, explicit enablement, representative eligible fixtures and Honeycomb's approval/demo. Live status updates, full submission completion and automatic underwriting handoff are outside this phase.
