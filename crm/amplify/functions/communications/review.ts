import { randomUUID } from "node:crypto";
import { get, put, row, commit, audit } from "./store";
import { ensureWorkflow, expected, makeTask, recordInbound } from "./workflow";
import { permittedConversation, front, messageConversation, type FrontMessage } from "./providers";
import type { Operation } from "./operations";
import type { Communication, LeadTask } from "../../../../shared/leadWorkflow";

export async function reviewOperation(input: { id: string; version: number; action: string; reason: string; uid?: string; verifiedNotSent?: boolean }, actor: string) {
  const old = await get<Operation>(input.id);
  if (!old || old.kind !== "OPERATION") throw new Error("Delivery operation not found");
  expected(old, input.version);
  if (!["UNKNOWN", "FAILED", "RETRY_WAIT", "ACCEPTED"].includes(old.data.state) || !input.reason?.trim()) throw new Error("Review an unresolved operation and record the reason");
  let state: Operation["state"] = "SUPPRESSED", uid = old.data.uid;
  if (input.action === "resolve") {
    if (!["EMAIL", "IMPORT"].includes(old.data.type) || !input.uid || !/^[a-zA-Z0-9_-]{1,200}$/.test(input.uid)) throw new Error("Enter the verified Front message UID");
    const message = await front<FrontMessage>(`/messages/alt:uid:${input.uid}`), cnv = messageConversation(message);
    if (!message.id || !cnv) throw new Error("Front has not resolved this message yet");
    const canonicalId = (await permittedConversation(cnv)).id;
    const wf = await ensureWorkflow(old.data.accountId);
    const linkedId = wf.data.conversationId && (wf.data.conversationId === canonicalId ? canonicalId : (await permittedConversation(wf.data.conversationId)).id);
    if (old.data.type === "EMAIL" && (message.is_inbound || canonicalId !== linkedId || !message.recipients?.some(r => r.role === "to" && r.handle.toLowerCase() === old.data.recipient?.toLowerCase()) || message.text?.trim() !== old.data.text?.trim())) throw new Error("The verified message does not match this queued email");
    if (old.data.type === "IMPORT" && !message.text?.includes(`:${old.data.submissionId}`)) throw new Error("The import does not match this website submission");
    state = "ACCEPTED"; uid = input.uid;
  } else if (input.action === "retry") {
    if (["ACCEPTED", "UNKNOWN"].includes(old.data.state) && !input.verifiedNotSent) throw new Error("Inspect Front first and confirm this message was not sent. An uncertain delivery must not be blindly resent.");
    state = "READY"; uid = undefined;
  } else if (input.action !== "suppress") throw new Error("Unknown review action");
  await commit([put(row("OPERATION", old.id, { ...old.data, state, uid, error: undefined, leaseUntil: undefined }, { accountId: old.accountId, previous: old, dueAt: state === "SUPPRESSED" ? undefined : new Date().toISOString() }), old), audit(old.data.accountId, actor, "Delivery reviewed", input)]);
}

export async function recordCallOutcome(input: { id: string; version: number; outcome: string; note: string; nextAction?: { title: string; dueAt: string }; taskId?: string; taskVersion?: number }, actor: string) {
  const comm = await get<Communication>(input.id);
  if (!comm || comm.kind !== "COMMUNICATION" || comm.data.channel !== "CALL" || !comm.accountId) throw new Error("Link this call to its lead first");
  expected(comm, input.version);
  if (!["HANDLED", "FOLLOW_UP", "DOCUMENTS", "NO_ANSWER", "WRONG_NUMBER", "UNRELATED"].includes(input.outcome) || !input.note?.trim()) throw new Error("Choose a call outcome and add a note");
  const wf = await ensureWorkflow(comm.accountId), resolving = ["HANDLED", "FOLLOW_UP", "DOCUMENTS"].includes(input.outcome);
  if (resolving && wf.data.disposition === "ACTIVE" && !input.nextAction) throw new Error("Record the next action or dated waiting commitment");
  const writes = [put(row("COMMUNICATION", comm.id, { ...comm.data, outcome: input.outcome, outcomeBy: actor, outcomeAt: new Date().toISOString(), resolved: resolving || input.outcome === "UNRELATED", version: comm.version + 1 }, { accountId: comm.accountId, previous: comm, dueAt: resolving || input.outcome === "UNRELATED" ? undefined : comm.dueAt }), comm), audit(comm.accountId, actor, "Call outcome recorded", input)];
  if (input.nextAction) {
    const task = await makeTask({ accountId: comm.accountId, ...input.nextAction, role: "SALESPERSON", kind: input.outcome === "DOCUMENTS" ? "DOCUMENTS" : "FOLLOW_UP", custom: true });
    writes.push(put(row("TASK", task.id, task, { accountId: comm.accountId, dueAt: task.dueAt })));
  }
  if (input.taskId) {
    if (!resolving) throw new Error("An unanswered attempt cannot complete prospect work");
    const task = await get<LeadTask>(input.taskId);
    if (!task || task.accountId !== comm.accountId || task.data.status !== "OPEN") throw new Error("Choose an open request from this lead");
    expected(task, input.taskVersion);
    writes.push(put(row("TASK", task.id, { ...task.data, status: "COMPLETE", reason: input.note, version: task.version + 1 }, { accountId: comm.accountId, previous: task }), task));
    for (const id of task.data.sourceIds ?? []) {
      if (id === comm.id) continue;
      const source = await get<Communication>(id);
      if (source?.accountId === comm.accountId) writes.push(put(row("COMMUNICATION", id, { ...source.data, resolved: true }, { accountId: comm.accountId, previous: source }), source));
    }
  }
  if (resolving && !wf.data.humanTakeover) writes.push(put(row("WORKFLOW", wf.id, { ...wf.data, humanTakeover: true, version: wf.version + 1 }, { accountId: comm.accountId, previous: wf }), wf));
  const noteId = `note:call:${randomUUID()}`;
  writes.push(put(row("COMMUNICATION", noteId, { id: noteId, provider: "crm", providerId: noteId, channel: "NOTE", direction: "INTERNAL", accountId: comm.accountId, at: new Date().toISOString(), text: input.note, actorId: actor, status: "SAVED", version: 1 }, { accountId: comm.accountId })));
  await commit(writes);
}

export async function linkActivity(input: { id: string; accountId: string; version: number; conversationId?: string; purpose?: string }, actor: string) {
  const old = await get<Communication>(input.id);
  if (!old || old.kind !== "COMMUNICATION") throw new Error("Communication not found");
  expected(old, input.version);
  if (old.accountId && old.accountId !== input.accountId) throw new Error("This activity already belongs to another account");
  await ensureWorkflow(input.accountId);
  const conversationId = input.conversationId ? (await permittedConversation(input.conversationId)).id : old.data.conversationId;
  const comm = { ...old.data, accountId: input.accountId, conversationId, workflowApplied: false, version: old.version + 1 };
  const key = `activity-link:${old.id}`, link = await get(key), triage = await get(`triage:${old.id}`), issue = await get(`issue:${old.id}`);
  const writes = [put(row("COMMUNICATION", old.id, comm, { accountId: input.accountId, previous: old, dueAt: old.dueAt }), old), put(row("LINK", key, { accountId: input.accountId, conversationId: comm.conversationId, purpose: input.purpose === "CARRIER" ? "CARRIER" : "PROSPECT" }, { accountId: input.accountId, previous: link }), link), audit(input.accountId, actor, "Activity linked", input)];
  if (conversationId) {
    const key = `front-link:${conversationId}`, existing = await get<{ accountId: string }>(key);
    if (existing && existing.data.accountId !== input.accountId) throw new Error("This Front conversation belongs to another association");
    if (!existing) writes.push(put(row("LINK", key, { accountId: input.accountId, conversationId, purpose: input.purpose === "CARRIER" ? "CARRIER" : "PROSPECT", routing: "MANUAL" }, { accountId: input.accountId })));
  }
  for (const previous of [triage, issue]) if (previous) writes.push(put(row(previous.kind, previous.id, { ...previous.data, resolved: true }, { accountId: input.accountId, previous }), previous));
  await commit(writes);
  // Replays repair the projection if the first linking request stops here.
  if (comm.direction === "INBOUND" && (comm.channel !== "CALL" || comm.status === "MISSED")) await recordInbound(comm, input.purpose === "CARRIER" ? "CARRIER" : comm.channel === "CALL" ? "CALLBACK" : "RESPONSE");
}
