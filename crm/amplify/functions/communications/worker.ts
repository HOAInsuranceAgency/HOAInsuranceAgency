import type { DynamoDBStreamEvent } from "aws-lambda";
import { get, query, row, save, put, commit, issue, conflict, check, type Row } from "./store";
import { config } from "./config";
import { operationRow } from "./outbox";
import { runOperation, type Operation } from "./operations";
import { processEvent, dialpadEvent, ingestFrontMessage, type EventRecord } from "./events";
import { ensureWorkflow, recordInbound, enabledUser, accountRows } from "./workflow";
import { front, dialpad, ProviderError, providerTimestamp, type FrontMessage } from "./providers";
import type { LeadTask, Communication } from "../../../../shared/leadWorkflow";
import { scheduleReminders, taskWakeAt, followUpDeadline, reminderWindow, nextReminderMorning } from "../../../../shared/leadWorkflow";
import { leadActionGuidance } from "../../../../shared/leadActionGuidance";
import { migrateReminderSchedules } from "./reminders";
import { dataClient } from "./data";
import { callRoot, syncCall } from "./calls";

export async function dispatchTask(candidate: Row<LeadTask>) {
  let task = await get<LeadTask>(candidate.id);
  if (!task || task.data.status !== "OPEN") return;
  const c = await config(), now = new Date().toISOString();
  const scheduled = scheduleReminders(task.data, c.holidays);
  if (scheduled.reminderAt !== task.data.reminderAt || scheduled.escalationAt !== task.data.escalationAt) {
    scheduled.version = task.version + 1;
    task = await save(row("TASK", task.id, scheduled, { accountId: task.accountId, previous: task, dueAt: taskWakeAt(scheduled) }), task);
  }
  const wake = taskWakeAt(task.data);
  if (!wake) return;
  if (wake > now || !reminderWindow(now, c.holidays)) {
    const dueAt = wake > now ? wake : nextReminderMorning(now, c.holidays);
    if (task.dueAt !== dueAt) await save(row("TASK", task.id, task.data, { accountId: task.accountId, previous: task, dueAt }), task);
    return;
  }
  if (task.data.kind === "FOLLOW_UP" && !task.data.custom && task.data.conversationId) {
    const latest = await front<{ _results: FrontMessage[] }>(`/conversations/${task.data.conversationId}/messages?limit=1`);
    for (const message of latest._results) await ingestFrontMessage(message, task.data.conversationId);
    if ((await get<LeadTask>(task.id))?.version !== task.version) return;
  }
  const wf = await ensureWorkflow(task.data.accountId);
  const account = await (await dataClient()).models.Account.get({ id: task.data.accountId });
  if (account.errors?.length || !account.data) throw new Error("Could not verify the account; its commitment remains open");
  const { resolveTaskRoute } = await import("./routing");
  const routingRecord = await get("team-routing");
  const route = await resolveTaskRoute(task.data, wf.data);
  const manager = task.data.escalationAt <= now && route.managerId !== route.accountableId, owner = !!task.data.ownerEscalationAt && task.data.ownerEscalationAt <= now && route.ownerId !== route.accountableId;
  const recipient = owner ? route.ownerId : manager ? route.managerId : route.recipientId;
  if (!recipient) { await issue(task.id, "Choose an available manager or owner for this work", task.accountId); throw new Error("Responsible team coverage is missing"); }
  await enabledUser(recipient);
  const sources = await Promise.all((task.data.sourceIds ?? []).map(id => get<Communication>(id)));
  const guidance = leadActionGuidance(task.data, sources.flatMap(r => r && r.accountId === task!.accountId ? [r.data] : []), manager);
  const stage = owner ? "OWNER" : manager ? "MANAGER" : "DUE";
  const previousStage = task.data.ownerNotifiedAt ? "OWNER" : task.data.escalatedAt ? "MANAGER" : task.data.notifiedAt ? "DUE" : "";
  const next: LeadTask = { ...task.data, notifiedAt: task.data.notifiedAt ?? now, notifiedRecipientId: route.recipientId,
    ...(manager ? { escalatedAt: task.data.escalatedAt ?? now, escalatedRecipientId: route.managerId } : {}),
    ...(owner ? { ownerNotifiedAt: task.data.ownerNotifiedAt ?? now, ownerRecipientId: route.ownerId } : {}),
    lastReminderAt: now, nextReminderAt: followUpDeadline(now, 1, c.holidays), version: task.version + 1 };
  const writes = [check(wf), ...(routingRecord ? [check(routingRecord)] : []), put(row("TASK", task.id, { ...next, attempts: 0, error: undefined, firstFailureAt: undefined }, { accountId: task.accountId, previous: task, dueAt: taskWakeAt(next) }), task)];
  for (const target of new Set([route.recipientId, ...(manager ? [route.managerId] : []), ...(owner ? [route.ownerId] : [])].filter((id): id is string => !!id))) {
    const id = `notice:${task.id}:${target}`, old = await get(id);
    writes.push(put(row("NOTIFICATION", id, { recipient: target, accountId: task.accountId, taskId: task.id, title: guidance.action, why: guidance.why, instruction: guidance.after, dueAt: task.data.dueAt, urgency: stage, at: now }, { accountId: task.accountId, previous: old }), old));
  }
  const cnv = task.data.conversationId ?? wf.data.conversationId;
  if (cnv) {
    const reminder = { taskId: task.id, noticeAt: now, recipientId: recipient, escalated: manager, stage, workflowVersion: wf.version };
    let commentId: string | undefined;
    if (stage !== previousStage) {
      commentId = `op:reminder-comment:${task.id}:${stage}:${task.version}`;
      const member = await get<{ name: string }>(`eligibility:${route.recipientId}`);
      const deadline = new Date(task.data.dueAt).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      const text = `9 a.m. work reminder\n\nWhy this is back: ${guidance.why}\nNext step: ${guidance.action}\nResponsible: ${member?.data.name ?? "Team coverage needed"}\nDue: ${deadline} Eastern${guidance.preview ? `\nOriginal request: ${guidance.preview}` : ""}\n\n${guidance.after}${manager ? "\nThe manager's morning report includes this overdue work." : ""}`;
      writes.push(put(operationRow(commentId, { type: "COMMENT", accountId: task.data.accountId, conversationId: cnv, text, reminder })));
    }
    writes.push(put(operationRow(`op:reopen:${task.id}:${task.version}`, { type: "REOPEN", accountId: task.data.accountId, conversationId: cnv, reminder, afterOperationId: commentId })));
  }
  await commit(writes);
}
export async function refreshCommunication(candidate: Row<Communication>) {
  let comm = await get<Communication>(candidate.id);
  if (!comm || comm.kind !== "COMMUNICATION") return;
  if (comm.data.channel === "CALL") {
    if (comm.data.status === "MISSED" && !comm.data.resolved) {
      try {
      const call = await dialpad<Record<string, unknown>>(`/call/${comm.data.providerId}`);
      await dialpadEvent({ ...call, call_id: call.call_id ?? comm.data.providerId, state: "hangup" });
      if (call.operator_call_id && String(call.operator_call_id) !== comm.data.providerId) {
        const operator = await dialpad<Record<string, unknown>>(`/call/${call.operator_call_id}`);
        await dialpadEvent({ ...operator, call_id: call.operator_call_id, entry_point_call_id: comm.data.providerId, state: "hangup" });
      }
      } catch (e) {
        // Missing enrichment must not prevent a known missed call's deadline.
        comm = (await get<Communication>(`comm:dialpad:call:${await callRoot(comm.data.providerId)}`))!;
        if (comm.data.status === "MISSED" && comm.data.accountId && !comm.data.resolved) await recordInbound(comm.data, "CALLBACK");
        const current = (await get<Communication>(comm.id))!;
        await save(row("COMMUNICATION", current.id, { ...current.data, refreshError: e instanceof Error ? e.message : "Call verification unavailable" }, { accountId: current.accountId, previous: current, dueAt: new Date(Date.now() + 300_000).toISOString() }), current);
        await issue(`call-refresh:${comm.id}`, "Call verification needs attention. The callback deadline remains in effect.", comm.accountId);
        return;
      }
      comm = (await get<Communication>(`comm:dialpad:call:${await callRoot(comm.data.providerId)}`))!;
      const oldIssue = await get(`issue:call-refresh:${comm.id}`);
      if (oldIssue && !oldIssue.data.resolved) await save(row("ISSUE", oldIssue.id, { ...oldIssue.data, resolved: true }, { accountId: comm.accountId, previous: oldIssue }), oldIssue);
    }
    if (comm.data.direction === "INBOUND" && comm.data.status === "MISSED" && comm.data.accountId && !comm.data.resolved) await recordInbound(comm.data, "CALLBACK");
    const current = (await get<Communication>(comm.id))!;
    await save(row("COMMUNICATION", current.id, current.data, { accountId: current.accountId, previous: current }), current); return;
  }
  if (comm.data.status === "DRAFT") {
    await save(row("COMMUNICATION", comm.id, comm.data, { accountId: comm.accountId, previous: comm }), comm); return;
  }
  if (comm.data.provider !== "front" || comm.data.channel !== "EMAIL" || comm.data.direction !== "OUTBOUND") return;
  const age = Date.now() - Date.parse(comm.data.at), wf = comm.accountId ? await ensureWorkflow(comm.accountId) : undefined;
  const replied = comm.accountId && (await accountRows<Communication>(comm.accountId, "COMMUNICATION")).some(r => r.data.direction === "INBOUND" && r.data.conversationId === comm.data.conversationId && r.data.classification === "SUBSTANTIVE" && r.data.at > comm.data.at);
  const stopAutomatic = replied || age > 14 * 86400_000 || wf && wf.data.disposition !== "ACTIVE";
  if (stopAutomatic && !comm.data.seenRequestedAt) {
    await save(row("COMMUNICATION", comm.id, comm.data, { accountId: comm.accountId, previous: comm }), comm); return;
  }
  const result = await front<{ _results: { first_seen_at?: number | string }[] }>(`/messages/${comm.data.providerId}/seen`);
  const first = result._results.map(r => r.first_seen_at).filter((x): x is number | string => x !== undefined).map(providerTimestamp).filter(Number.isFinite).sort((a,b) => a-b)[0];
  await save(row("COMMUNICATION", comm.id, { ...comm.data, seenAt: first ? new Date(first).toISOString() : comm.data.seenAt, seenCheckedAt: new Date().toISOString(), seenRequestedAt: undefined, seenError: undefined },
    { accountId: comm.accountId, previous: comm, dueAt: stopAutomatic ? undefined : new Date(Date.now() + (age < 2 * 86400_000 ? 900_000 : 3600_000)).toISOString() }), comm);
}
export const handler = async (event?: Partial<DynamoDBStreamEvent>) => {
  if (event?.Records) {
    const batchItemFailures = [];
    for (const record of event.Records) {
      if (record.dynamodb?.NewImage?.__typename?.S === "Document" && record.dynamodb.NewImage.entityType?.S !== "ACCOUNT") continue;
      const id = record.dynamodb?.NewImage?.accountId?.S ?? record.dynamodb?.NewImage?.entityId?.S ?? record.dynamodb?.NewImage?.id?.S;
      if (!id || record.eventName === "REMOVE") continue;
      try { const { syncAccountLifecycle } = await import("./workflow"); await syncAccountLifecycle(id); }
      catch { await issue(`assignment:${id}`, "Lead responsibilities need repair after account creation", id).catch(() => {}); batchItemFailures.push({ itemIdentifier: record.dynamodb?.SequenceNumber ?? record.eventID! }); }
    }
    return { batchItemFailures };
  }
  const previousHealth = await get<{ at: string }>("health:worker");
  if (previousHealth && Date.now() - Date.parse(previousHealth.data.at) > 300_000 && (await config()).activatedAt) await issue("sync-gap", "Communication processing was interrupted. Review the missed interval, especially Dialpad SMS, before clearing sync health.");
  const start = Date.now(), counters = { handled: 0, failed: 0 };
  let cursor: string | undefined, lagging = false, callChecks = 0;
  const c = await config();
  await migrateReminderSchedules();
  try { await (await import("./coverage")).coverageSweep(); await (await import("./routing")).resolveIssue("coverage-census"); }
  catch (error) { lagging = true; await issue("coverage-census", error instanceof Error ? error.message : "Work coverage needs attention"); }
  if (c.activatedAt) {
    const { migrateContactProgress } = await import("./contactProgress");
    try {
      await migrateContactProgress();
      const warning = await get("issue:contact-progress-repair");
      if (warning && !warning.data.resolved) await save(row("ISSUE", warning.id, { ...warning.data, resolved: true }, { previous: warning }), warning);
    } catch (error) {
      lagging = true;
      await issue("contact-progress-repair", error instanceof Error ? error.message : "Contact history repair will retry");
    }
  }
  // Reserve reconciliation a turn even while due work is backlogged. Each
  // provider captures one independent page; a failure cannot starve the other.
  if (c.activatedAt && !c.paused) {
    const { reconcile } = await import("./reconcile");
    try { const result = await reconcile(); lagging = lagging || result.lagging; }
    catch (e) { lagging = true; await issue("reconcile", e instanceof Error ? e.message : "Reconciliation failed"); }
  }
  // Indexed due work only. Bound each run and resume naturally on the next tick.
  dueWork: do {
    const page = await query("due", "DUE", cursor, 30); cursor = page.nextToken;
    lagging ||= page.items.some(r => ["EVENT", "OPERATION"].includes(r.kind) && Date.now() - Date.parse(r.dueAt!) > 300_000);
    const work = page.items.sort((a,b) => Number(a.kind === "COMMUNICATION") - Number(b.kind === "COMMUNICATION"));
    for (const candidate of work) {
      if (Date.now() - start > 75_000) { lagging = true; break dueWork; }
      try {
        if (candidate.kind === "OPERATION") await runOperation(candidate as unknown as Row<Operation>);
        else if (candidate.kind === "EVENT") await processEvent(candidate as unknown as Row<EventRecord>);
        else if (candidate.kind === "TASK") await dispatchTask(candidate as unknown as Row<LeadTask>);
        else if (candidate.kind === "ROLE_SYNC") { const { syncResponsibilities } = await import("./workflow"); await syncResponsibilities(candidate as unknown as Parameters<typeof syncResponsibilities>[0]); }
        else if (candidate.kind === "CALL_SYNC") await syncCall(candidate as unknown as Parameters<typeof syncCall>[0]);
        else if (candidate.kind === "CONVERSATION_BACKFILL") { const { backfillConversation } = await import("./events"); await backfillConversation(candidate as unknown as Parameters<typeof backfillConversation>[0]); }
        else if (candidate.kind === "COMMUNICATION") { if (candidate.data.channel === "CALL" && callChecks++ >= 4) continue; await refreshCommunication(candidate as unknown as Row<Communication>); }
        else if (candidate.kind === "LIFECYCLE") {
          const { syncAccountLifecycle } = await import("./workflow"); await syncAccountLifecycle(candidate.accountId!);
          await save(row("LIFECYCLE", candidate.id, candidate.data, { accountId: candidate.accountId, previous: candidate }), candidate);
        }
        else if (candidate.kind === "TRIAGE") {
          await issue(candidate.id, "Unlinked communication needs review; its response deadline has arrived");
          await save(row("TRIAGE", candidate.id, candidate.data, { previous: candidate }), candidate);
        }
        counters.handled++;
      } catch(e) {
        if (conflict(e)) continue;
        counters.failed++;
        const current = await get(candidate.id);
        if (!current || current.version !== candidate.version) continue;
        const rateLimited = e instanceof ProviderError && e.status === 429;
        const attempts = Number(current.data.attempts ?? 0) + (rateLimited ? 0 : 1);
        const error = e instanceof Error ? e.message : "Communication processing failed";
        const delay = e instanceof ProviderError ? e.retryAfter : Math.min(900, 30 * 2 ** Math.min(attempts, 5));
        const firstFailureAt = String(current.data.firstFailureAt ?? new Date().toISOString());
        await save(row(current.kind, current.id, { ...current.data, attempts, error, firstFailureAt, ...(current.kind === "COMMUNICATION" && current.data.channel === "EMAIL" ? { seenError: error } : {}) }, { accountId: current.accountId, previous: current,
          // Team commitments never expire out of the dispatcher on an API error.
          dueAt: !["TASK", "LIFECYCLE", "ROLE_SYNC", "CALL_SYNC", "TRIAGE"].includes(current.kind) && attempts >= 12 && !rateLimited ? undefined : new Date(Date.now() + delay * 1000).toISOString() }), current);
        if (!rateLimited || Date.now() - Date.parse(firstFailureAt) >= 300_000) await issue(current.id, error, current.accountId);
      }
    }
  } while (cursor && Date.now() - start < 75_000);
  const oldHealth = await get("health:worker");
  await save(row("HEALTH", "health:worker", { at: new Date().toISOString(), lagging: lagging || counters.failed > 0 }, { previous: oldHealth }), oldHealth);
  return counters;
};
