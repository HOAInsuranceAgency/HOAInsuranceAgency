import { taskWakeAt } from "../../../../shared/leadWorkflow";
import { config } from "./config";
import type { HistoryJob } from "./history";
import { uniteCalls, combineLegs, callStatus, queueCallSync, type Call } from "./calls";
import { front, permittedConversation, messageConversation, FrontScopeError, type FrontMessage } from "./providers";
import { row, save, get, issue, hash, canonical, type Row } from "./store";
import { recordInbound, recordOutbound, ensureWorkflow, accountRows, makeTask } from "./workflow";
import { normalizePhone, businessDeadline, type Communication } from "../../../../shared/leadWorkflow";
import { dialpadBusinessLine } from "./phoneScope";
import { intakeReferenceFromHtml } from "../lead-intake/brief";

export type EventRecord = { provider: "front" | "dialpad"; payload: Record<string, unknown>; attempts: number; processedAt?: string; snapshot?: { message: FrontMessage; conversationId: string } };
export interface ConversationLink { accountId: string; conversationId: string; purpose: "PROSPECT" | "CARRIER"; routing?: "SALESPERSON" | "CHAMPION" | "MANUAL" }
type Json = Record<string, unknown>;
const object = (x: unknown): Json => x && typeof x === "object" && !Array.isArray(x) ? x as Json : {};
const str = (x: unknown) => typeof x === "string" || typeof x === "number" ? String(x) : "";
function eventAt(value: unknown) {
  const n = Number(value); const at = n > 10_000_000_000 ? n : n * 1000;
  return Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : new Date().toISOString();
}
export function classifyEmail(message: Pick<FrontMessage, "text" | "subject" | "metadata" | "attachments">): Communication["classification"] {
  const metadata = message.metadata ?? {};
  const automatic = metadata.auto_submitted || metadata.autoSubmitted;
  if (automatic && automatic !== "no") return "AUTOMATIC";
  if (/^(automatic reply|auto.?reply|out of office|delivery status notification|undeliverable)/i.test(message.subject ?? "")) return "AUTOMATIC";
  return message.text?.trim() || message.attachments?.length ? "SUBSTANTIVE" : "REVIEW";
}
export async function ingestFrontMessage(message: FrontMessage, conversationId?: string) {
  const cnv = conversationId ?? messageConversation(message);
  if (!cnv || !message.id) return;
  // Dialpad is authoritative for phone activity. Native call/SMS records are
  // linked in the sidebar, never imported as a second customer interaction.
  if (message.type && message.type !== "email") return;
  const id = `comm:front:${message.id}`, old = await get<Communication>(id);
  // Front lists shared drafts in message history. They are never sent activity.
  if (message.is_draft) {
    if (old && old.data.frontDraft !== false) {
      const { repairMisclassifiedDraft } = await import("./drafts");
      await repairMisclassifiedDraft(old);
    }
    return;
  }
  if (!message.is_inbound && message.is_draft !== false) throw new Error("Front message sending status could not be verified");
  const link = await get<ConversationLink>(`front-link:${cnv}`);
  const c = await config();
  if (!c.activatedAt || message.created_at * 1000 < Date.parse(c.activatedAt)) return;
  if (message.is_inbound && message.message_uid) {
    const uid = await get<{ operationId: string }>(`front-uid:${message.message_uid}`);
    // Front does not return external_id in message metadata, and its plain
    // text changes with body_format. Identify our import by its durable UID.
    // The reference is only a lookup fallback if saving the UID index failed;
    // matching text by itself must never suppress a real prospect message.
    const lines = message.text?.replace(/^<pre>/, "").trimStart().split("\n") ?? [];
    const prefix = `Reference: hoa:${c.environment}:`;
    const submissionId = (lines[0] === "Website submission" && lines[1]?.startsWith(prefix) ? lines[1].slice(prefix.length).trim() : undefined)
      ?? intakeReferenceFromHtml(message.body, process.env.CRM_BASE_URL);
    const operationId = uid?.data.operationId ?? (submissionId ? `op:intake:${submissionId}` : undefined);
    const operation = operationId ? await get<{ type: string; uid?: string }>(operationId) : undefined;
    if (operation?.data.type === "IMPORT" && operation.data.uid === message.message_uid) return;
  }
  const comm: Communication = { ...old?.data, id, provider: "front", providerId: message.id, accountId: link?.data.accountId,
    conversationId: cnv, channel: "EMAIL", direction: message.is_inbound ? "INBOUND" : "OUTBOUND", at: eventAt(message.created_at),
    attachments: message.attachments?.map(a => ({ id: a.id, filename: a.filename, content_type: a.content_type, size: a.size })), subject: message.subject, text: message.text?.slice(0, 50000), from: message.recipients?.find(r => r.role === "from")?.handle,
    to: message.recipients?.filter(r => r.role === "to").map(r => r.handle), actorId: message.author?.id, status: message.is_inbound ? "RECEIVED" : "SENT", frontDraft: false,
    classification: classifyEmail(message), purpose: link?.data.purpose, version: (old?.version ?? 0) + 1 };
  // Duplicate event delivery must not reopen a completed episode.
  if (old?.data.workflowApplied || old?.data.resolved) {
    if (old.data.frontDraft !== false) await save(row("COMMUNICATION", old.id, { ...old.data, frontDraft: false }, { accountId: old.accountId, previous: old, dueAt: old.dueAt }), old);
    return;
  }
  if (!old || old.accountId !== comm.accountId || old.data.conversationId !== cnv || old.data.status === "DRAFT" || old.data.frontDraft !== false) await save(row("COMMUNICATION", id, comm, { accountId: comm.accountId, previous: old,
    dueAt: old?.dueAt ?? (comm.direction === "OUTBOUND" ? new Date(Date.now() + 900_000).toISOString() : undefined) }), old);
  if (!link) { await issue(id, "Link this Front enquiry to the correct lead"); return; }
  const linkingIssue = await get(`issue:${id}`);
  if (linkingIssue && !linkingIssue.data.resolved) await save(row("ISSUE", linkingIssue.id, { ...linkingIssue.data, resolved: true }, { accountId: comm.accountId, previous: linkingIssue }), linkingIssue);
  if (link.data.purpose === "CARRIER") {
    if (comm.direction === "INBOUND" && comm.classification !== "AUTOMATIC") await recordInbound(comm, "CARRIER");
    else if (comm.direction === "OUTBOUND") await recordOutbound(comm);
    return;
  }
  if (comm.direction === "INBOUND" && comm.classification !== "AUTOMATIC") await recordInbound(comm);
  else if (comm.direction === "OUTBOUND") {
    await recordOutbound(comm);
    const ownUid = message.message_uid ? await get(`front-uid:${message.message_uid}`) : undefined;
    const ownReply = (await accountRows<{ type: string; uid?: string; state: string }>(comm.accountId!, "OPERATION")).some(o => o.data.type === "EMAIL" && (!!message.message_uid && o.data.uid === message.message_uid || ["LEASED", "ACCEPTED", "UNKNOWN"].includes(o.data.state)));
    if (comm.actorId && comm.actorId !== "crm:initial-ai" && !ownUid && !ownReply) {
      const wf = await ensureWorkflow(comm.accountId!);
      if (!wf.data.humanTakeover) await save(row("WORKFLOW", wf.id, { ...wf.data, humanTakeover: true, version: wf.version + 1 }, { accountId: wf.accountId, previous: wf }), wf);
    }
  }
}
async function frontEvent(event: Json, type: string) {
  if (!/inbound|outbound|message|delivery_failed|bounce/.test(type) && !["assignee_changed", "assign"].includes(type)) return;
  const conv = object(event.conversation), target = object(event.target);
  const cnv = str(conv.id) || str(object(event.payload).conversation_id);
  if (!/^cnv_[a-z0-9]+$/.test(cnv)) return;
  const link = await get<ConversationLink>(`front-link:${cnv}`);
  if ((type === "assignee_changed" || type === "assign") && !link) return;
  try { await permittedConversation(cnv); }
  catch (error) {
    if (error instanceof FrontScopeError) return { ignored: error.message };
    throw error;
  }
  if (type === "assignee_changed" || type === "assign") {
    if (link) {
      const actual = str(object(target.data).id || object(conv.assignee).id);
      const routed = (await accountRows<{ type: string; assigneeId?: string; conversationId?: string }>(link.data.accountId, "OPERATION")).some(o => o.data.type === "ASSIGN" && o.data.conversationId === cnv && o.data.assigneeId === actual && Date.now() - Date.parse(o.updatedAt) < 300_000);
      if (!routed) await save(row("LINK", link.id, { ...link.data, routing: "MANUAL" }, { accountId: link.accountId, previous: link }), link);
    }
    return;
  }
  if (/delivery_failed|outbound_failed|bounce/.test(type)) {
    await issue(`delivery:${str(event.id) || cnv}`, "An outbound message failed. Check the recipient and arrange the next contact.", link?.accountId);
    if (link) {
      const id = `task:correction:${cnv}`;
      if (!await get(id)) { const task = await makeTask({ id, accountId: link.data.accountId, title: "Correct failed email delivery", kind: "CORRECTION", conversationId: cnv }); await save(row("TASK", id, task, { accountId: task.accountId, dueAt: taskWakeAt(task) })); }
    }
    return;
  }
  if (!/inbound|outbound|message/.test(type)) return; // Archive and snooze are never business-date inputs.
  const msg = object(target.data).id ?? object(event.message).id;
  if (typeof msg === "string" && /^msg_/.test(msg)) { await ingestFrontMessage(await front<FrontMessage>(`/messages/${msg}`), cnv); return; }
  const messages = await front<{ _results: FrontMessage[] }>(`/conversations/${cnv}/messages`);
  for (const message of messages._results.slice().reverse()) await ingestFrontMessage(message, cnv);
}
export async function dialpadEvent(p: Json) {
  const c = await config();
  const target = object(p.target), contact = object(p.contact);
  const inbound = p.direction === "inbound";
  if (!["inbound", "outbound"].includes(str(p.direction))) throw new Error("Dialpad event direction needs review");
  const firstNumber = (x: unknown) => str(Array.isArray(x) ? x[0] : x);
  const line = dialpadBusinessLine(p);
  if (!line) throw new Error("Dialpad event has no identifiable business line");
  if (!c.dialpadNumbers.includes(line)) return { ignored: "Business line outside configured scope", line };
  const isCall = !!p.call_id;
  let providerId = str(isCall ? p.master_call_id || p.entry_point_call_id || p.call_id : p.id);
  if (!providerId) throw new Error("Dialpad event has no resource ID");
  const sourceAt = eventAt(p.date_started ?? p.created_date ?? p.event_timestamp);
  if (!c.activatedAt || Date.parse(sourceAt) < Date.parse(c.activatedAt)) return;
  if (isCall) providerId = await uniteCalls([p.master_call_id, p.entry_point_call_id, p.call_id, p.operator_call_id].filter(Boolean).map(str));
  const external = normalizePhone(str(p.external_number || contact.phone_number || contact.phone || firstNumber(inbound ? p.from_number : p.to_number)));
  const id = `comm:dialpad:${isCall ? "call" : "sms"}:${providerId}`, old = await get<Call>(id);
  const exact = await get<{ accountId: string; conversationId?: string; purpose?: "PROSPECT" | "CARRIER" }>(`activity-link:${id}`);
  const phone = external ? await get<{ accountId: string }>(`phone-link:${external}`) : undefined;
  const accountId = exact?.data.accountId ?? old?.accountId ?? phone?.data.accountId;
  const at = old?.data.at && old.data.at < sourceAt ? old.data.at : sourceAt;
  const legs = combineLegs(old?.data.legs);
  if (isCall) {
    const legId = str(p.call_id), previous = legs[legId];
    legs[legId] = { connected: !!(previous?.connected || p.date_connected || p.state === "connected"), ended: !!(previous?.ended || p.state === "hangup" || p.state === "voicemail" || p.date_ended) };
  }
  const status = callStatus(legs);
  const connectedLegs = Object.values(legs).filter(leg => leg.connected);
  const finished = isCall && (connectedLegs.length ? connectedLegs.every(leg => leg.ended) : Object.values(legs).every(leg => leg.ended));
  const comm: Communication & { legs?: typeof legs } = { ...old?.data, id, accountId, provider: "dialpad", providerId, conversationId: exact?.data.conversationId ?? old?.data.conversationId,
    channel: isCall ? "CALL" : "SMS", direction: p.direction === "inbound" ? "INBOUND" : "OUTBOUND", at, from: p.direction === "inbound" ? external ?? undefined : line,
    to: [p.direction === "inbound" ? line : external ?? ""], actorId: str(p.sender_id || target.id),
    status: isCall ? status : smsStatus(old?.data.status, str(p.message_status).toUpperCase(), p.direction === "inbound"),
    text: str(p.text || p.transcription_text || old?.data.text).slice(0, 50000), summary: str(p.recap_summary || old?.data.summary).slice(0, 20000),
    enrichment: isCall ? (p.transcription_text || p.recap_summary ? "Available" : old?.data.enrichment ?? "Transcript or summary unavailable or still processing") : undefined,
    purpose: exact?.data.purpose ?? old?.data.purpose,
    endedAt: finished ? [old?.data.endedAt, p.date_ended ? eventAt(p.date_ended) : undefined].filter((s): s is string => !!s).sort().at(-1) : undefined,
    version: (old?.version ?? 0) + 1, ...(isCall ? { legs } : {}) };
  await save(row("COMMUNICATION", id, comm, { accountId, previous: old,
    dueAt: isCall && status === "MISSED" ? old?.data.status === "MISSED" ? old.dueAt : new Date(Date.now() + 180_000).toISOString() : undefined }), old);
  if (!accountId) {
    await issue(id, "Choose the association for this Dialpad activity");
    const dueAt = businessDeadline(at, 1, c.holidays);
    if (!await get(`triage:${id}`)) await save(row("TRIAGE", `triage:${id}`, { communicationId: id, dueAt, at, phone: external, resolved: false }, { dueAt }));
  }
  if (isCall) await queueCallSync(providerId);
  if (accountId && (isCall || comm.direction === "OUTBOUND")) await recordOutbound(comm);
  if (accountId && !isCall && comm.direction === "OUTBOUND" && ["FAILED", "UNDELIVERED"].includes(comm.status)) {
    await issue(`sms-delivery:${id}`, "A text could not be delivered. Check the number and contact the prospect.", accountId);
    const taskId = `task:correction:${id}`, previous = await get<import("../../../../shared/leadWorkflow").LeadTask>(taskId);
    if (!previous || previous.data.status !== "OPEN") {
      const task = await makeTask({ id: taskId, accountId, title: "Correct failed text delivery", kind: "CORRECTION", conversationId: comm.conversationId });
      await save(row("TASK", taskId, task, { accountId, previous, dueAt: taskWakeAt(task) }), previous);
    }
  }
  if (accountId && !isCall && !comm.workflowApplied && comm.direction === "INBOUND") {
    if (/^\s*(stop|unsubscribe|cancel|end|quit)\s*$/i.test(comm.text ?? "")) { await issue(`optout:${id}`, "Prospect opted out of texts; respect the Dialpad contact preference", accountId); return; }
    await recordInbound(comm);
  }
  if (accountId && !isCall && comm.direction === "OUTBOUND" && comm.text?.trim() && ["SENT", "DELIVERED"].includes(comm.status)) {
    const wf = await ensureWorkflow(accountId);
    if (!wf.data.humanTakeover) await save(row("WORKFLOW", wf.id, { ...wf.data, humanTakeover: true, version: wf.version + 1 }, { accountId, previous: wf }), wf);
  }
}
export function smsStatus(previous: string | undefined, incoming: string, inbound = false) {
  if (inbound) return "RECEIVED";
  const rank: Record<string, number> = { PENDING: 1, SENT: 2, FAILED: 3, UNDELIVERED: 3, DELIVERED: 4 };
  return (rank[previous ?? ""] ?? 0) >= (rank[incoming] ?? 0) ? previous ?? "PENDING" : incoming;
}
export async function processEvent(record: Row<EventRecord>) {
  const p = record.data.payload;
  let outcome: { ignored: string; line?: string } | undefined;
  if (record.data.snapshot) {
    await permittedConversation(record.data.snapshot.conversationId);
    const snapshot = record.data.snapshot.message;
    // Old receipts predate the draft flag. Verify instead of guessing on replay.
    const message = !snapshot.is_inbound && snapshot.is_draft === undefined ? await front<FrontMessage>(`/messages/${snapshot.id}`) : snapshot;
    await ingestFrontMessage(message, record.data.snapshot.conversationId);
  } else if (record.data.provider === "front") outcome = await frontEvent(object(p.payload), str(p.type));
  else outcome = await dialpadEvent(p);
  await save(row("EVENT", record.id, { ...record.data, outcome, attempts: 0, processedAt: new Date().toISOString() }, { previous: record }), record);
}

/** Linking old conversations imports history in bounded, replayable pages. */
export async function backfillConversation(candidate: Row<HistoryJob>) {
  const job = await get<typeof candidate.data>(candidate.id); if (!job?.dueAt) return;
  const cnv = (await permittedConversation(job.data.conversationId)).id;
  const page = await front<{ _results: FrontMessage[]; _pagination?: { next?: string } }>(job.data.next ?? `/conversations/${cnv}/messages?limit=25`);
  if (!Array.isArray(page._results)) throw new Error("Front message history needs review");
  const linkVersion = (await get(`front-link:${cnv}`))?.version ?? 0, deadline = Date.now() + 20_000;
  for (const incoming of page._results.slice().reverse()) {
    if (Date.now() >= deadline) return; // Durable item receipts resume this same page.
    if (!incoming?.id || typeof incoming.id !== "string" || !Number.isFinite(incoming.created_at)
      || incoming.text != null && typeof incoming.text !== "string"
      || incoming.attachments != null && (!Array.isArray(incoming.attachments) || incoming.attachments.some(a => !a?.id))
      || incoming.recipients != null && (!Array.isArray(incoming.recipients) || incoming.recipients.some(r => !r || typeof r.handle !== "string"))) {
      await issue(`front-history:${cnv}:${hash(canonical(incoming))}`, `Front history in ${cnv} returned a malformed message`); continue;
    }
    const message = incoming && { id: incoming.id, created_at: incoming.created_at, is_inbound: incoming.is_inbound, is_draft: incoming.is_draft, type: incoming.type,
      text: incoming.text?.slice(0, 50000), subject: incoming.subject, recipients: incoming.recipients, author: incoming.author,
      message_uid: incoming.message_uid, conversation: { id: cnv }, attachments: incoming.attachments?.map(a => ({ id: a.id, filename: a.filename, content_type: a.content_type, size: a.size })),
      metadata: { auto_submitted: incoming.metadata?.auto_submitted, autoSubmitted: incoming.metadata?.autoSubmitted, external_id: incoming.metadata?.external_id } };
    const key = `front-history:${cnv}:${message.id}:${linkVersion}:draft-v2:${message.is_draft ? "draft" : "sent"}`, old = await get<EventRecord>(key);
    // Persist the exact item before projection. A poisonous message remains
    // replayable while the rest of the page and subsequent pages progress.
    const event = old ?? await save(row<EventRecord>("EVENT", key, { provider: "front", payload: {}, snapshot: { message, conversationId: cnv }, attempts: 0 }, { dueAt: new Date().toISOString() }));
    if (!event.data.processedAt) {
      try {
        // The conversation was already verified once for this page.
        await ingestFrontMessage(message, cnv);
        await save(row("EVENT", event.id, { ...event.data, processedAt: new Date().toISOString() }, { previous: event }), event);
      }
      catch (e) { await issue(key, e instanceof Error ? e.message : "Front message needs review", job.accountId); }
    }
  }
  await save(row("CONVERSATION_BACKFILL", job.id, { ...job.data, draftAware: true, next: page._pagination?.next, attempts: 0, error: undefined, firstFailureAt: undefined, completedAt: page._pagination?.next ? undefined : new Date().toISOString() }, { accountId: job.accountId, previous: job, dueAt: page._pagination?.next ? new Date().toISOString() : undefined }), job);
}
