import { retiredReminderOperation } from "./retiredTasks";
import { archiveAllowed } from "./cleanup";
import { contactCleanupSource, isInitialAiCleanup, isInitialAiCommunication } from "./initialAi";
import { config } from "./config";
import { resolveProducerEmail, ProducerEmailSetupError, type ProducerEmailIdentity } from "./producerEmail";
import { get, row, save, issue, commit, put, conflict, retryableStorage, check, absent, type Row } from "./store";
import { front, ProviderError, FrontPersonalAccessError, assertRecipient, messageConversation, permittedConversation, type FrontMessage } from "./providers";
import { ensureWorkflow, recordOutbound, enabledUser } from "./workflow";
import { dataClient } from "./data";
import { textLeadAlerts } from "../lead-intake/alerts";
import type { LeadSummary } from "../lead-intake/sms";
import type { Submission } from "../lead-intake/handler";
import { renderIntakeBrief } from "../lead-intake/brief";
import type { Communication, LeadWorkflow, Responsibility, TeamEligibility } from "../../../../shared/leadWorkflow";

class AssignmentError extends ProviderError {
  constructor(message: string) { super(message, 0, false); }
}
async function assignedSalesperson(userId: string | undefined) {
  if (!userId || !/^[a-zA-Z0-9_-]{1,128}$/.test(userId)) throw new AssignmentError("Assign an active salesperson to this lead before delivering its alert or Front assignment");
  const member = await get<TeamEligibility>(`eligibility:${userId}`);
  if (!member?.data.enabled || !member.data.salesperson) throw new AssignmentError("The assigned salesperson is no longer eligible. Choose an active salesperson for this lead in the CRM");
  try { await enabledUser(userId); }
  catch { throw new AssignmentError("The assigned salesperson could not be verified as active. Check their user access or reassign this lead in the CRM"); }
  return member;
}

/** Identity captured with the generated body; never guess a producer at send time. */
export async function assignedEmailProducer(userId: string | undefined) {
  const member = await assignedSalesperson(userId);
  const name = typeof member.data.name === "string" ? member.data.name.trim() : "";
  if (!name || name.length > 200 || /[\r\n\x00-\x1f\x7f]/.test(name)) throw new AssignmentError("Add the assigned salesperson’s name in Team settings before sending the initial email");
  const emailIdentity = await resolveProducerEmail(member.data);
  return { member, producerId: userId!, producerName: name, emailIdentity };
}

export interface Operation {
  type: "ATTACHMENT" | "IMPORT" | "EMAIL" | "COMMENT" | "SMS_ALERT" | "ARCHIVE" | "REOPEN" | "ASSIGN";
  state: "READY" | "LEASED" | "ACCEPTED" | "CONFIRMED" | "RETRY_WAIT" | "UNKNOWN" | "FAILED" | "SUPPRESSED";
  accountId: string; attempts: number; failures?: number; submissionId?: string; replyId?: string;
  conversationId?: string; recipient?: string; subject?: string; html?: string; text?: string;
  uid?: string; messageId?: string; error?: string; leaseUntil?: string; assigneeId?: string;
  producerId?: string; producerName?: string; emailIdentity?: ProducerEmailIdentity;
  lead?: LeadSummary; sourceMessageId?: string; attachmentId?: string; requestedBy?: string;
  // Legacy reminder metadata is retained so queued deliveries can be retired.
  reminder?: { taskId: string; noticeAt: string; recipientId: string; escalated: boolean; stage?: string; workflowVersion?: number };
  reminderGroup?: { day: string; role: Responsibility; recipientId: string; accountableId?: string; anchorTaskId: string };
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
  // Retire reminders queued by earlier deployments, including retries and old
  // per-task formats. This must run before pause, routing, or provider checks.
  // Keep new inbound activity and ordinary team comments on their existing paths.
  if (retiredReminderOperation(op.id, op.data)) {
    if (op.data.state === "LEASED" && op.data.leaseUntil! > new Date().toISOString()) return;
    await transition(op, { state: "SUPPRESSED", leaseUntil: undefined, error: "Scheduled task reminders have been removed from the CRM" });
    return;
  }
  // Never alter an active external attempt. Retire only cleanup that has not
  // started, or whose old lease has expired.
  if (op.data.state === "LEASED" && op.data.leaseUntil! > new Date().toISOString()) return;
  if (await isInitialAiCleanup(op.id, op.data)) {
    await transition(op, { state: "SUPPRESSED", leaseUntil: undefined, error: "The initial AI email leaves this conversation open for the salesperson" });
    return;
  }
  if (!['LEASED', 'ACCEPTED'].includes(op.data.state) && await get(`deleted-account:${op.data.accountId}`)) { await transition(op, { state: 'SUPPRESSED', error: 'Lead deleted' }); return; }
  if (op.data.state === "LEASED") {
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
      const leased = row('OPERATION', op.id, { ...op.data, state: 'LEASED' as const, attempts: op.data.attempts + 1, leaseUntil: new Date(Date.now() + 180_000).toISOString() }, { accountId: op.accountId, previous: op, dueAt: new Date(Date.now() + 180_000).toISOString() });
      await commit([put(leased, op), absent(`deleted-account:${op.data.accountId}`)]);
      op = leased;
      await importAttachment(op.data); await transition(op, { state: "CONFIRMED" }); return;
    }
    // Delivery follows a durable assignment. It must never manufacture a
    // default owner when an intake workflow has not been assigned yet.
    const wf = ["IMPORT", "EMAIL", "SMS_ALERT", "ASSIGN"].includes(op.data.type)
      ? await get<LeadWorkflow>(`workflow:${op.data.accountId}`) : await ensureWorkflow(op.data.accountId);
    if (!wf) throw new AssignmentError("Assign an active salesperson to this lead before delivering its alert or Front assignment");
    let assignee: Row<TeamEligibility> | undefined;
    let inboundSource: Row<Communication> | undefined;
    let cleanupSource: Row<Communication> | undefined;
    if (op.data.type === "REOPEN" && op.id.startsWith("op:inbound:")) {
      inboundSource = await get<Communication>(op.id.slice("op:inbound:".length));
      if (inboundSource && inboundSource.accountId === op.accountId && inboundSource.data.resolved) {
        await transition(op, { state: "SUPPRESSED", error: "This request was already answered" }); return;
      }
    }
    if (op.data.type === "EMAIL" && (wf.data.humanTakeover || wf.data.disposition !== "ACTIVE")) { await transition(op, { state: "SUPPRESSED" }); await updateReply(op.data, "SUPPRESSED", "Handled by the team"); return; }
    let path = "", body: unknown, method = "POST";
    if (op.data.type === "SMS_ALERT") {
      if (!op.data.lead) throw new ProviderError("The lead text alert is missing its lead details; review the intake record", 400, false);
      assignee = await assignedSalesperson(wf.data.salespersonId);
    } else if (op.data.type === "IMPORT") {
      assignee = await assignedSalesperson(wf.data.salespersonId);
      if (!c.frontInboxId || !c.frontChannelId) throw new ProviderError("Connect the Front sales inbox and email channel", 0, false);
      const submission = await get<Submission>(`submission:${op.data.submissionId}`);
      if (!submission) throw new Error("Submission record is missing");
      const email = String(submission.data.snapshot.contactEmail ?? "");
      await assertRecipient(email);
      const externalId = `hoa:${c.environment}:${op.data.submissionId}`;
      const brief = renderIntakeBrief({ snapshot: submission.data.snapshot, receivedAt: submission.data.receivedAt,
        accountId: op.data.accountId, accountName: wf.data.name, submissionId: op.data.submissionId!, environment: c.environment, crmBaseUrl: process.env.CRM_BASE_URL,
        assignedSalespersonName: assignee.data.name });
      path = `/inboxes/${c.frontInboxId}/imported_messages`;
      body = { sender: { handle: email, name: [submission.data.snapshot.contactFirstName, submission.data.snapshot.contactLastName].filter(Boolean).join(" ") || wf.data.name },
        to: [c.frontSender], subject: `Website enquiry — ${wf.data.name}`, body: brief.html, body_format: "html", external_id: externalId,
        created_at: Date.parse(submission.data.receivedAt) / 1000, metadata: { is_inbound: true, is_archived: false, should_skip_rules: true, thread_ref: externalId } };
    } else if (op.data.type === "EMAIL") {
      await assertRecipient(op.data.recipient ?? "");
      if (!wf.data.conversationId) throw new ProviderError("Waiting for the Front intake conversation", 0, false);
      await permittedConversation(wf.data.conversationId);
      const messages = await front<{ _results: FrontMessage[] }>(`/conversations/${wf.data.conversationId}/messages`);
      if (messages._results.some(m => !m.is_inbound && m.is_draft === false && m.author)) {
        await transition(op, { state: "SUPPRESSED" }); await updateReply(op.data, "SUPPRESSED", "A teammate already replied in Front"); return;
      }
      const producer = await assignedEmailProducer(wf.data.salespersonId);
      assignee = producer.member;
      if (!op.data.producerId || !op.data.producerName) throw new AssignmentError("Initial email held: its salesperson identity was not recorded. Review this queued email and handle the lead personally before sending");
      if (op.data.producerId !== producer.producerId || op.data.producerName !== producer.producerName) throw new AssignmentError("Initial email held: the assigned salesperson changed after this email was prepared. Review it and handle the lead personally before sending");
      const identity = op.data.emailIdentity;
      if (!identity || identity.signatureMode !== "FRONT") throw new AssignmentError("Initial email held: its sending mailbox and signature were not recorded. Review this queued email and handle the lead personally before sending");
      if ((["frontId", "channelId", "senderEmail", "signatureId", "signatureMode"] as const).some(key => identity[key] !== producer.emailIdentity[key])) throw new AssignmentError("Initial email held: the salesperson’s sending mailbox or signature changed after this email was prepared. Review it before sending");
      path = `/conversations/${wf.data.conversationId}/messages`;
      body = { channel_id: identity.channelId, author_id: identity.frontId, to: [op.data.recipient], cc: [], bcc: [], sender_name: op.data.producerName, subject: op.data.subject,
        body: op.data.html, text: op.data.text, quote_body: "", should_add_default_signature: false, signature_id: identity.signatureId, options: { archive: false } };
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
      if (op.data.type === "ARCHIVE" && op.id.startsWith("op:contact-cleanup:")) {
        // Front delivery may normalize the source while archiveAllowed awaits.
        // Re-read after preflight and fence this snapshot in the lease below.
        cleanupSource = await contactCleanupSource(op.id, op.data);
        if (!cleanupSource || await isInitialAiCommunication(cleanupSource.data)) {
          await transition(op, { state: "SUPPRESSED", error: cleanupSource ? "The initial AI email leaves this conversation open for the salesperson" : "Cleanup held because its contact source could not be verified" });
          return;
        }
      }
      if (op.data.type === "ASSIGN") {
        const link = await get<{ routing?: string }>(`front-link:${cnv}`);
        if (link?.data.routing === "MANUAL") { await transition(op, { state: "SUPPRESSED", error: "A teammate changed the conversation handler" }); return; }
        assignee = await assignedSalesperson(wf.data.salespersonId);
        if (!assignee.data.frontId) throw new AssignmentError("Map the assigned salesperson's Front identity in Team settings to assign this lead's email");
        body = { assignee_id: assignee.data.frontId };
      }
    }
    const leased = row("OPERATION", op.id, { ...op.data, ...(op.data.type === "ASSIGN" ? { assigneeId: assignee!.data.frontId } : {}), state: "LEASED" as const, attempts: op.data.attempts + 1, leaseUntil: new Date(Date.now() + 180_000).toISOString() }, { accountId: op.accountId, previous: op, dueAt: new Date(Date.now() + 180_000).toISOString() });
    await commit([put(leased, op), absent(`deleted-account:${op.data.accountId}`), ...(["IMPORT", "EMAIL", "ASSIGN", "SMS_ALERT"].includes(op.data.type) ? [check(wf)] : []), ...(assignee ? [check(assignee)] : []), ...(inboundSource ? [check(inboundSource)] : []), ...(cleanupSource ? [check(cleanupSource)] : [])]);
    op = leased;
    posted = true;
    if (op.data.type === "SMS_ALERT") {
      const result = await textLeadAlerts(await dataClient(), op.data.lead!, wf.data.salespersonId!);
      if (result.failed) throw new ProviderError("The assigned salesperson's lead text alert failed; review before retrying", 400, false);
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
    if (error instanceof AssignmentError || error instanceof ProducerEmailSetupError || error instanceof FrontPersonalAccessError || uncertain || !retryable || Date.now() - Date.parse(current.createdAt) > 300_000) await issue(current.id, message, current.accountId);
  }
}
async function updateReply(op: Operation, status: "SENT" | "SUPPRESSED" | "FAILED", note?: string, sentAt?: string, sentBody = op.text) {
  if (!op.replyId) return;
  const result = await (await dataClient()).models.LeadReply.update({ id: op.replyId, status, note, sentAt, sentSubject: op.subject, sentBody });
  if (result.errors?.length) throw new Error("Could not update the reply record");
}
async function resolveAccepted(op: Row<Operation>) {
  const message = await front<FrontMessage & { message_uid?: string; error_type?: string; is_draft?: boolean }>(`/messages/alt:uid:${encodeURIComponent(op.data.uid!)}`);
  if (message.error_type) { await updateReply(op.data, "FAILED", message.error_type); await transition(op, { state: "FAILED", error: message.error_type }); await issue(op.id, "Front could not deliver this message", op.accountId); return; }
  const messageConversationId = messageConversation(message);
  if (!messageConversationId || !message.id || message.is_draft !== false) throw new ProviderError("Front is still preparing the message", 0, false);
  const conversationId = (await permittedConversation(messageConversationId)).id;
  if (await get(`deleted-account:${op.data.accountId}`)) {
    if (op.data.type === 'EMAIL') await updateReply(op.data, 'SENT', 'Delivery was already accepted before lead deletion', new Date(message.created_at * 1000).toISOString(), message.text ?? op.data.text);
    await transition(op, { state: 'CONFIRMED', messageId: message.id });
    return;
  }
  const wf = await ensureWorkflow(op.data.accountId);
  const linkedConversationId = wf.data.conversationId && (wf.data.conversationId === conversationId ? conversationId : (await permittedConversation(wf.data.conversationId)).id);
  if (op.data.type === "IMPORT") {
    if (linkedConversationId && linkedConversationId !== conversationId) throw new Error("The intake conversation conflicts with an existing lead link");
    const existingLink = await get(`front-link:${conversationId}`);
    if (existingLink && existingLink.accountId !== op.accountId) throw new Error("The Front conversation is linked to a different lead");
    const writes = [put(row("WORKFLOW", wf.id, { ...wf.data, conversationId, version: wf.version + 1 }, { accountId: wf.accountId, previous: wf }), wf)];
    if (!existingLink) writes.push(put(row("LINK", `front-link:${conversationId}`, { accountId: op.accountId, conversationId, purpose: "PROSPECT", routing: "SALESPERSON" }, { accountId: op.accountId })));
    await commit(writes);
    // Queue even when the owner or Front mapping needs repair. The assignment
    // operation holds visibly and retries using the current persisted owner.
    await enqueueOperation(`op:assign:${conversationId}`, { type: "ASSIGN", accountId: op.data.accountId, conversationId });
  } else {
    if (message.is_inbound || conversationId !== linkedConversationId) throw new Error("The outbound message does not match the linked conversation");
    if (wf.data.conversationId !== conversationId) await save(row("WORKFLOW", wf.id, { ...wf.data, conversationId, version: wf.version + 1 }, { accountId: wf.accountId, previous: wf }), wf);
    const at = new Date(message.created_at * 1000).toISOString();
    const comm: Communication = { actorId: "crm:initial-ai", frontDraft: false, id: `comm:front:${message.id}`, provider: "front", providerId: message.id, accountId: op.accountId, conversationId,
      channel: "EMAIL", direction: "OUTBOUND", at, subject: message.subject ?? op.data.subject, text: message.text ?? op.data.text, from: message.recipients?.find(r => r.role === "from")?.handle ?? op.data.emailIdentity?.senderEmail, to: [op.data.recipient!], status: "SENT", version: 1 };
    const previous = await get<Communication>(comm.id);
    await save(row("COMMUNICATION", comm.id, { ...previous?.data, ...comm, classification: "SUBSTANTIVE" }, { accountId: op.accountId, previous, dueAt: previous?.dueAt ?? new Date(Date.now() + 900_000).toISOString() }), previous);
    await recordOutbound(comm); await updateReply(op.data, "SENT", undefined, at, message.text ?? op.data.text);
  }
  await transition(op, { state: "CONFIRMED", messageId: message.id, conversationId });
}
