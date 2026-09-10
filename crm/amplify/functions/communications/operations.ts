import { archiveAllowed } from "./cleanup";
import { config } from "./config";
import { get, row, save, issue, commit, put, conflict, retryableStorage, check, type Row } from "./store";
import { front, ProviderError, assertRecipient, messageConversation, permittedConversation, type FrontMessage, verifyEmailChannel } from "./providers";
import { ensureWorkflow, recordOutbound } from "./workflow";
import { dataClient } from "./data";
import { textLeadAlerts } from "../lead-intake/alerts";
import type { LeadSummary } from "../lead-intake/sms";
import type { Submission } from "../lead-intake/handler";
import { renderIntakeBrief } from "../lead-intake/brief";
import { reminderWindow, nextReminderMorning, type Communication, type LeadTask } from "../../../../shared/leadWorkflow";

export interface Operation {
  type: "ATTACHMENT" | "IMPORT" | "EMAIL" | "COMMENT" | "SMS_ALERT" | "ARCHIVE" | "REOPEN" | "ASSIGN";
  state: "READY" | "LEASED" | "ACCEPTED" | "CONFIRMED" | "RETRY_WAIT" | "UNKNOWN" | "FAILED" | "SUPPRESSED";
  accountId: string; attempts: number; failures?: number; submissionId?: string; replyId?: string;
  conversationId?: string; recipient?: string; subject?: string; html?: string; text?: string;
  uid?: string; messageId?: string; error?: string; leaseUntil?: string; assigneeId?: string;
  lead?: LeadSummary; sourceMessageId?: string; attachmentId?: string; requestedBy?: string;
  reminder?: { taskId: string; noticeAt: string; recipientId: string; escalated: boolean };
  afterOperationId?: string;
}
export async function enqueueOperation(id: string, data: Omit<Operation, "state" | "attempts">) {
  const old = await get<Operation>(id);
  if (old) return old;
  const next = row("OPERATION", id, { ...data, state: "READY", attempts: 0 } as Operation, { accountId: data.accountId, dueAt: new Date().toISOString() });
  try { await save(next); } catch (e) { if (!conflict(e)) throw e; return (await get<Operation>(id))!; }
  return next;
}
async function transition(old: Row<Operation>, patch: Partial<Operation>, delay?: number) {
  const confirmed = patch.state === "CONFIRMED";
  const next = row("OPERATION", old.id, { ...old.data, ...patch, ...(confirmed ? { error: undefined, failures: 0, leaseUntil: undefined } : {}) }, { accountId: old.accountId, previous: old,
    dueAt: delay === undefined ? undefined : new Date(Date.now() + delay * 1000).toISOString() });
  const previousIssue = confirmed ? await get(`issue:${old.id}`) : undefined;
  const writes = [put(next, old)];
  // Resolve only this operation's warning, atomically with confirmed delivery.
  // Provider-wide gaps and unrelated issues still require their own review.
  if (previousIssue && !previousIssue.data.resolved) writes.push(put(row("ISSUE", previousIssue.id, { ...previousIssue.data, resolved: true, resolvedAt: new Date().toISOString(), resolution: "Operation completed successfully" }, { accountId: previousIssue.accountId, previous: previousIssue }), previousIssue));
  await commit(writes);
  return next;
}
export async function runOperation(candidate: Row<Operation>) {
  let op = await get<Operation>(candidate.id);
  if (!op || ["CONFIRMED", "FAILED", "SUPPRESSED", "UNKNOWN"].includes(op.data.state)) return;
  if (op.data.state === "LEASED") {
    if (op.data.leaseUntil! > new Date().toISOString()) return;
    const safe = ["IMPORT", "ATTACHMENT", "ARCHIVE", "REOPEN", "ASSIGN"].includes(op.data.type);
    op = await transition(op, { state: safe ? "RETRY_WAIT" : "UNKNOWN", error: "The previous attempt stopped before its result was saved" }, safe ? 5 : undefined);
    if (!safe) { await issue(op.id, "Delivery result needs review before any retry", op.accountId); return; }
  }
  let posted = false;
  let acceptedUid: string | undefined;
  try {
    if (op.data.state === "ACCEPTED") { await resolveAccepted(op); return; }
    const c = await config();
    if ((c.paused || !c.activatedAt) && op.data.type !== "SMS_ALERT") { await transition(op, { state: "RETRY_WAIT" }, 60); return; }
    if (op.data.type === "ATTACHMENT") {
      const { importAttachment } = await import("./attachments");
      op = await transition(op, { state: "LEASED", attempts: op.data.attempts + 1, leaseUntil: new Date(Date.now() + 180_000).toISOString() }, 180);
      await importAttachment(op.data); await transition(op, { state: "CONFIRMED" }); return;
    }
    const wf = await ensureWorkflow(op.data.accountId);
    let inboundSource: Row<Communication> | undefined;
    if (op.data.type === "REOPEN" && op.id.startsWith("op:inbound:")) {
      inboundSource = await get<Communication>(op.id.slice("op:inbound:".length));
      if (inboundSource && inboundSource.accountId === op.accountId && inboundSource.data.resolved) {
        await transition(op, { state: "SUPPRESSED", error: "This request was already answered" }); return;
      }
    }
    // Retire old queued reminder reopens: their old notices contain no reason.
    // The migrated task remains open and its next morning escalation is retained.
    if (op.data.type === "REOPEN" && op.id.startsWith("op:reopen:notice:") && !op.data.reminder) {
      await transition(op, { state: "SUPPRESSED", error: "Replaced by morning reminders" }); return;
    }
    let reminderTask: Row<LeadTask> | undefined;
    if (op.data.reminder) {
      const reminder = op.data.reminder;
      reminderTask = await get<LeadTask>(reminder.taskId);
      const recipient = reminder.escalated || reminderTask?.data.role === "CHAMPION" ? wf.data.championId : wf.data.salespersonId;
      const noticeAt = reminder.escalated ? reminderTask?.data.escalatedAt : reminderTask?.data.notifiedAt;
      if (!reminderTask || reminderTask.data.status !== "OPEN" || wf.data.disposition !== "ACTIVE" || recipient !== reminder.recipientId || noticeAt !== reminder.noticeAt || (!reminder.escalated && reminderTask.data.escalationAt <= new Date().toISOString())) {
        await transition(op, { state: "SUPPRESSED", error: "This action was completed, changed or reassigned" }); return;
      }
      const now = new Date().toISOString();
      if (!reminderWindow(now, c.holidays)) {
        await transition(op, { state: "RETRY_WAIT" }, Math.max(1, (Date.parse(nextReminderMorning(now, c.holidays)) - Date.now()) / 1000)); return;
      }
      if (op.data.afterOperationId) {
        const comment = await get<Operation>(op.data.afterOperationId);
        if (comment?.data.state !== "CONFIRMED") {
          if (comment && ["FAILED", "UNKNOWN", "SUPPRESSED"].includes(comment.data.state)) {
            await transition(op, { state: "SUPPRESSED", error: "The reminder explanation could not be confirmed; the CRM reminder remains visible" }); return;
          }
          await transition(op, { state: "RETRY_WAIT" }, 60); return;
        }
      }
    }
    if (op.data.type === "EMAIL" && (wf.data.humanTakeover || wf.data.disposition !== "ACTIVE")) { await transition(op, { state: "SUPPRESSED" }); await updateReply(op.data, "SUPPRESSED", "Handled by the team"); return; }
    let path = "", body: unknown, method = "POST";
    if (op.data.type === "IMPORT") {
      if (!c.frontInboxId || !c.frontChannelId) throw new ProviderError("Connect the Front sales inbox and email channel", 0, false);
      const submission = await get<Submission>(`submission:${op.data.submissionId}`);
      if (!submission) throw new Error("Submission record is missing");
      const email = String(submission.data.snapshot.contactEmail ?? "");
      await assertRecipient(email);
      const externalId = `hoa:${c.environment}:${op.data.submissionId}`;
      const brief = renderIntakeBrief({ snapshot: submission.data.snapshot, receivedAt: submission.data.receivedAt,
        accountId: op.data.accountId, accountName: wf.data.name, submissionId: op.data.submissionId!, environment: c.environment, crmBaseUrl: process.env.CRM_BASE_URL });
      path = `/inboxes/${c.frontInboxId}/imported_messages`;
      body = { sender: { handle: email, name: [submission.data.snapshot.contactFirstName, submission.data.snapshot.contactLastName].filter(Boolean).join(" ") || wf.data.name },
        to: [c.frontSender], subject: `Website enquiry — ${wf.data.name}`, body: brief.html, body_format: "html", external_id: externalId,
        created_at: Date.parse(submission.data.receivedAt) / 1000, metadata: { is_inbound: true, is_archived: false, should_skip_rules: true, thread_ref: externalId } };
    } else if (op.data.type === "EMAIL") {
      await assertRecipient(op.data.recipient ?? "");
      if (!wf.data.conversationId || !c.frontChannelId) throw new ProviderError("Waiting for the Front intake conversation", 0, false);
      await permittedConversation(wf.data.conversationId);
      await verifyEmailChannel();
      const messages = await front<{ _results: FrontMessage[] }>(`/conversations/${wf.data.conversationId}/messages`);
      if (messages._results.some(m => !m.is_inbound && m.author)) {
        await transition(op, { state: "SUPPRESSED" }); await updateReply(op.data, "SUPPRESSED", "A teammate already replied in Front"); return;
      }
      path = `/conversations/${wf.data.conversationId}/messages`;
      body = { channel_id: c.frontChannelId, to: [op.data.recipient], cc: [], bcc: [], sender_name: "Brian Cole", subject: op.data.subject,
        body: op.data.html, text: op.data.text, quote_body: "", should_add_default_signature: false, signature_id: null, options: { archive: false } };
    } else if (op.data.type === "COMMENT") {
      const cnv = op.data.conversationId ?? wf.data.conversationId;
      if (!cnv) throw new ProviderError("Waiting for a linked Front conversation", 0, false);
      await permittedConversation(cnv); path = `/conversations/${cnv}/comments`; body = { body: op.data.text };
    } else if (op.data.type === "ARCHIVE" || op.data.type === "REOPEN" || op.data.type === "ASSIGN") {
      const cnv = op.data.conversationId ?? wf.data.conversationId;
      if (!cnv) throw new Error("No linked Front conversation");
      await permittedConversation(cnv); path = `/conversations/${cnv}`; method = "PATCH";
      body = op.data.type === "ASSIGN" ? { assignee_id: op.data.assigneeId ?? null } : { status: op.data.type === "ARCHIVE" ? "archived" : "open" };
      if (op.data.type === "ARCHIVE" && !await archiveAllowed(op.data.accountId, cnv)) { await transition(op, { state: "SUPPRESSED", error: "Cleanup held because lead work or sync health needs attention" }); return; }
      if (op.data.type === "ASSIGN") {
        const link = await get<{ routing?: string }>(`front-link:${cnv}`);
        if (link?.data.routing === "MANUAL") { await transition(op, { state: "SUPPRESSED", error: "A teammate changed the conversation handler" }); return; }
        const member = await get<{ frontId?: string }>(`eligibility:${link?.data.routing === "CHAMPION" ? wf.data.championId : wf.data.salespersonId}`);
        if (!member?.data.frontId) throw new ProviderError("Map the current responsible teammate in Front", 0, false);
        body = { assignee_id: member.data.frontId };
      }
    }
    const leased = row("OPERATION", op.id, { ...op.data, state: "LEASED" as const, attempts: op.data.attempts + 1, leaseUntil: new Date(Date.now() + 180_000).toISOString() }, { accountId: op.accountId, previous: op, dueAt: new Date(Date.now() + 180_000).toISOString() });
    await commit([put(leased, op), ...(["EMAIL", "ASSIGN"].includes(op.data.type) || reminderTask ? [check(wf)] : []), ...(reminderTask ? [check(reminderTask)] : []), ...(inboundSource ? [check(inboundSource)] : [])]);
    op = leased;
    posted = true;
    if (op.data.type === "SMS_ALERT") {
      if (op.data.lead) {
        const result = await textLeadAlerts(await dataClient(), op.data.lead);
        if (result.failed) throw new ProviderError("One or more team lead alerts failed; review before retrying", 400, false);
      }
      await transition(op, { state: "CONFIRMED" }); return;
    }
    const result = await front<{ message_uid?: string; id?: string }>(path, method, body);
    if (["IMPORT", "EMAIL"].includes(op.data.type)) {
      acceptedUid = result.message_uid;
      if (!acceptedUid) throw new Error("Front accepted the request without a message UID; review required");
      const uidKey = `front-uid:${acceptedUid}`, previousUid = await get(uidKey);
      await commit([put(row("OPERATION", op.id, { ...op.data, state: "ACCEPTED", uid: acceptedUid }, { accountId: op.accountId, previous: op, dueAt: new Date(Date.now() + 10_000).toISOString() }), op),
        put(row("UID", uidKey, { operationId: op.id, accountId: op.accountId }, { accountId: op.accountId, previous: previousUid }), previousUid)]);
    } else await transition(op, { state: "CONFIRMED", messageId: result.id });
  } catch (error) {
    if (conflict(error)) return;
    const current = await get<Operation>(op.id);
    if (!current || current.version !== op.version) return;
    const message = error instanceof Error ? error.message : "Communication operation failed";
    if (acceptedUid) { await transition(current, { state: "ACCEPTED", uid: acceptedUid }, 30); return; }
    const accepted = current.data.state === "ACCEPTED";
    const safeImportRetry = current.data.type === "IMPORT" && posted && (!(error instanceof ProviderError) || error.status === 0 || error.status >= 500);
    const uncertain = !safeImportRetry && !accepted && posted && (!(error instanceof ProviderError) || error.uncertain);
    const authFailure = error instanceof ProviderError && [401, 403].includes(error.status);
    const retryable = !posted && retryableStorage(error) || authFailure || safeImportRetry || accepted && !(error instanceof ProviderError && error.status === 400) || (error instanceof ProviderError && (error.status === 0 && !error.uncertain || error.status === 429 || (!posted && error.status >= 500)));
    const state = accepted && retryable ? "ACCEPTED" : uncertain ? "UNKNOWN" : retryable ? "RETRY_WAIT" : "FAILED";
    const failures = (current.data.failures ?? 0) + 1;
    const delay = Math.max(error instanceof ProviderError ? error.retryAfter : 0, Math.min(3600, 60 * 2 ** Math.min(failures - 1, 6)));
    await transition(current, { state, error: message, failures }, retryable ? delay : undefined);
    if (state === "FAILED") await updateReply(current.data, "FAILED", message);
    if (authFailure) await issue("provider-auth", "Provider authorization needs repair. Queued deliveries are held and will retry after credentials are restored.");
    if (uncertain || !retryable || Date.now() - Date.parse(current.createdAt) > 300_000) await issue(current.id, message, current.accountId);
  }
}
async function updateReply(op: Operation, status: "SENT" | "SUPPRESSED" | "FAILED", note?: string, sentAt?: string) {
  if (!op.replyId) return;
  const result = await (await dataClient()).models.LeadReply.update({ id: op.replyId, status, note, sentAt, sentSubject: op.subject, sentBody: op.text });
  if (result.errors?.length) throw new Error("Could not update the reply record");
}
async function resolveAccepted(op: Row<Operation>) {
  const message = await front<FrontMessage & { message_uid?: string; error_type?: string; is_draft?: boolean }>(`/messages/alt:uid:${encodeURIComponent(op.data.uid!)}`);
  if (message.error_type) { await updateReply(op.data, "FAILED", message.error_type); await transition(op, { state: "FAILED", error: message.error_type }); await issue(op.id, "Front could not deliver this message", op.accountId); return; }
  const messageConversationId = messageConversation(message);
  if (!messageConversationId || !message.id || message.is_draft) throw new ProviderError("Front is still preparing the message", 0, false);
  const conversationId = (await permittedConversation(messageConversationId)).id;
  const wf = await ensureWorkflow(op.data.accountId);
  const linkedConversationId = wf.data.conversationId && (wf.data.conversationId === conversationId ? conversationId : (await permittedConversation(wf.data.conversationId)).id);
  if (op.data.type === "IMPORT") {
    if (linkedConversationId && linkedConversationId !== conversationId) throw new Error("The intake conversation conflicts with an existing lead link");
    const existingLink = await get(`front-link:${conversationId}`);
    if (existingLink && existingLink.accountId !== op.accountId) throw new Error("The Front conversation is linked to a different lead");
    const writes = [put(row("WORKFLOW", wf.id, { ...wf.data, conversationId, version: wf.version + 1 }, { accountId: wf.accountId, previous: wf }), wf)];
    if (!existingLink) writes.push(put(row("LINK", `front-link:${conversationId}`, { accountId: op.accountId, conversationId, purpose: "PROSPECT", routing: "SALESPERSON" }, { accountId: op.accountId })));
    await commit(writes);
    const assignee = wf.data.salespersonId ? await get<{ frontId?: string }>(`eligibility:${wf.data.salespersonId}`) : undefined;
    if (assignee?.data.frontId) await enqueueOperation(`op:assign:${conversationId}`, { type: "ASSIGN", accountId: op.data.accountId, conversationId, assigneeId: assignee.data.frontId });
  } else {
    if (message.is_inbound || conversationId !== linkedConversationId) throw new Error("The outbound message does not match the linked conversation");
    if (wf.data.conversationId !== conversationId) await save(row("WORKFLOW", wf.id, { ...wf.data, conversationId, version: wf.version + 1 }, { accountId: wf.accountId, previous: wf }), wf);
    const at = new Date(message.created_at * 1000).toISOString();
    const comm: Communication = { actorId: "crm:initial-ai", id: `comm:front:${message.id}`, provider: "front", providerId: message.id, accountId: op.accountId, conversationId,
      channel: "EMAIL", direction: "OUTBOUND", at, subject: op.data.subject, text: op.data.text, to: [op.data.recipient!], status: "SENT", version: 1 };
    const previous = await get<Communication>(comm.id);
    await save(row("COMMUNICATION", comm.id, { ...previous?.data, ...comm, classification: "SUBSTANTIVE" }, { accountId: op.accountId, previous, dueAt: previous?.dueAt ?? new Date(Date.now() + 900_000).toISOString() }), previous);
    await recordOutbound(comm); await updateReply(op.data, "SENT", undefined, at);
  }
  await transition(op, { state: "CONFIRMED", messageId: message.id, conversationId });
}
