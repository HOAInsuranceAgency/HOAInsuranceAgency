# Manual business email handoff

This workflow prepares a private Front draft from the CRM quote packages, certificates, documents, account Activity, or the Front sidebar. A teammate reviews and sends it in Front. Creating a draft does not select a package, authorize or bind coverage, or establish that the recipient received it.

## Setup

Map each CRM teammate to their Front teammate under Settings → Team → Edit connections. The resolver verifies a connected personal email channel and applicable personal signature owned by that teammate. Select the channel/signature IDs if the available choices are ambiguous. The CRM login email and account's assigned producer do not substitute for the preparing teammate's mailbox.

The Front token needs private resource access, channel/signature/attachment/message reads, and draft read/write access, alongside the permissions already needed by the existing integration. Each teammate must opt into personal API access in Front. Front's private-resource namespace is broader than one teammate; the application authorizes the signed-in preparer and account explicitly. Do not add personal inboxes to general conversation ingestion as a workaround. Keep staging and production credentials separate and save them only in backend secrets.

## What is prepared

- **Proposal package:** a currently reviewed, complete option containing open QUOTED/PRESENTED offers, a frozen customer-facing proposal PDF, and up to 10 explicitly selected account carrier PDFs. The PDF includes recorded carrier/coverage/premium/term/limit/deductible information and binding disclaimers. It excludes commission and internal notes. Unsupported text that cannot be rendered clearly blocks preparation.
- **Certificate:** the generated certificate PDF. Explicitly enter the holder/requester in To and optionally the client in CC.
- **Document:** an authorized account upload or generated ACORD. Supported formats are PDF, JPEG, PNG, GIF, TIFF, WEBP, XLSX, DOCX, CSV and TXT, with matching metadata and file signatures. Generated finance agreements/resolutions stay in their finance workflow.

Combined attachments must not exceed 25 MB. Previews expire after 10 minutes. Changes to source records/files, reviewed package, assignment, teammate status or mailbox require a fresh preview. An existing thread must be a linked client conversation on the same account; recipients must already participate in it. Use a new unquoted conversation for a new holder or other new recipient. No recipient or CC is silently added.

## History and recovery

Prepared means Front returned a verified draft. Sent means Front recorded an outbound message; it does not confirm receipt or reading. A later failure remains visible. A known draft sent after material edits in Front is recorded as **Sent with changes**; the CRM labels its recipients as the original preparation, directs the teammate to Front for actual details, and does not mark the current quote presented. An uncertain dispatch or unverifiable sender/account remains held for review. Resending valid PRESENTED offers records another attempt and preserves the first presentation timestamp.

The CRM records its intent before calling Front. Repeating the same request ID never creates another draft. An uncertain POST is held for review; it is never blindly retried with another ID. Check Front status to reconcile a known draft or known linked conversation. For an uncertain new conversation whose response was lost, find the exact draft/message in Front and provide its `msg_…` ID or direct message link. The server verifies the original actor, From, recipients, reference, public facts and attachment hashes before adopting it. A conversation-only link is insufficient. If no matching draft can be found, keep the attempt in Needs review rather than sending a duplicate.

New private conversations are tracked only by their explicit attempt. They are not automatically linked into general CRM inbox ingestion. The original preparer checks their status; authorized account teammates can view safe attempt history. An active admin can reconcile an existing attempt for a reassigned or offboarded preparer using the stored original sender and exact-message verification. This recovery never sends mail or substitutes the admin’s mailbox. Account reassignment or a disabled teammate removes ordinary access immediately and also fences the draft-intent transaction.

## Release validation

Use synthetic account content and the staging recipient allowlist. Verify the actual draft in Front, including personal From, signature, exact To/CC, proposal and selected file bytes. Verify both standalone CRM and sidebar entry points. Keep delivery paused for background workflows during controlled draft tests.

Staging uses the retained business-account backend namespace `staging`, hosted by `codex-hoa-staging-migration`, with `amplify.staging-backend.yml` as its explicit build-spec override. Production uses `main` and the existing production build spec. Never deploy the retired source backend. Both deploy paths enforce the retained backend root, stateful resource identities, stream cursor generation, schedules and historical cutover evidence.
