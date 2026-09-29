import type { DynamoDBStreamEvent } from "aws-lambda";
import { get, query, row, save, issue, conflict, type Row } from "./store";
import { config } from "./config";
import { runOperation, type Operation } from "./operations";
import { processEvent, dialpadEvent, type EventRecord } from "./events";
import { ensureWorkflow, accountRows, recordInbound } from "./workflow";
import { front, dialpad, ProviderError, providerTimestamp } from "./providers";
import type { LeadTask, Communication } from "../../../../shared/leadWorkflow";
import { callRoot, syncCall } from "./calls";

/** Drain only old queue indexes; retain each historical task and its evidence unchanged. */
export async function dispatchTask(candidate: Row<LeadTask>) {
  const current = await get(candidate.id);
  if (!current || !["TASK", "NOTIFICATION"].includes(current.kind)) return;
  if (!current.dueAt && !current.workKind) return;
  const { dueAt: _dueAt, dueGroup: _dueGroup, workAt: _workAt, workKind: _workKind, ...historical } = current;
  await save({ ...historical, version: current.version + 1, updatedAt: new Date().toISOString() }, current);
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
        // Preserve a missed call even when provider enrichment is unavailable.
        comm = (await get<Communication>(`comm:dialpad:call:${await callRoot(comm.data.providerId)}`))!;
        if (comm.data.status === "MISSED" && comm.data.accountId && !comm.data.resolved) await recordInbound(comm.data, "CALLBACK");
        const current = (await get<Communication>(comm.id))!;
        await save(row("COMMUNICATION", current.id, { ...current.data, refreshError: e instanceof Error ? e.message : "Call verification unavailable" }, { accountId: current.accountId, previous: current, dueAt: new Date(Date.now() + 300_000).toISOString() }), current);
        await issue(`call-refresh:${comm.id}`, "Call verification needs attention. The original call remains in communication history.", comm.accountId);
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
      if (record.eventName === 'REMOVE' && (record.dynamodb?.OldImage?.__typename?.S === 'Account' || record.dynamodb?.OldImage?.stage?.S && !record.dynamodb?.OldImage?.accountId)) {
        const removedId = record.dynamodb?.OldImage?.id?.S;
        if (removedId) try { await (await import('./deletion')).retireAccount(removedId, 'system (account deleted)'); } catch { batchItemFailures.push({ itemIdentifier: record.dynamodb?.SequenceNumber ?? record.eventID! }); }
        continue;
      }
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
  try {
    await (await import("./ownershipMigration")).migrateSalespersonOwnership();
    await (await import("./routing")).resolveIssue("salesperson-ownership");
  } catch (error) {
    lagging = true;
    await issue("salesperson-ownership", error instanceof Error ? error.message : "Account assignment migration will retry");
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
        if (candidate.kind === 'ACCOUNT_DELETE') { const { retireAccountPage } = await import('./deletion'); await retireAccountPage(candidate as unknown as Parameters<typeof retireAccountPage>[0]); }
        else if (candidate.kind === "OPERATION") await runOperation(candidate as unknown as Row<Operation>);
        else if (candidate.kind === "EVENT") await processEvent(candidate as unknown as Row<EventRecord>);
        else if (["TASK", "NOTIFICATION"].includes(candidate.kind)) await dispatchTask(candidate as unknown as Row<LeadTask>);
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
        if (!current || current.version !== candidate.version || ["TASK", "NOTIFICATION"].includes(current.kind)) continue;
        const rateLimited = e instanceof ProviderError && e.status === 429;
        const attempts = Number(current.data.attempts ?? 0) + (rateLimited ? 0 : 1);
        const error = e instanceof Error ? e.message : "Communication processing failed";
        const delay = e instanceof ProviderError ? e.retryAfter : Math.min(900, 30 * 2 ** Math.min(attempts, 5));
        const firstFailureAt = String(current.data.firstFailureAt ?? new Date().toISOString());
        await save(row(current.kind, current.id, { ...current.data, attempts, error, firstFailureAt, ...(current.kind === "COMMUNICATION" && current.data.channel === "EMAIL" ? { seenError: error } : {}) }, { accountId: current.accountId, previous: current,
          // Provider reconciliation and lifecycle repairs remain retryable.
          dueAt: !["LIFECYCLE", "ROLE_SYNC", "CALL_SYNC", "TRIAGE"].includes(current.kind) && attempts >= 12 && !rateLimited ? undefined : new Date(Date.now() + delay * 1000).toISOString() }), current);
        if (!rateLimited || Date.now() - Date.parse(firstFailureAt) >= 300_000) await issue(current.id, error, current.accountId);
      }
    }
  } while (cursor && Date.now() - start < 75_000);
  const oldHealth = await get("health:worker");
  await save(row("HEALTH", "health:worker", { at: new Date().toISOString(), lagging: lagging || counters.failed > 0 }, { previous: oldHealth }), oldHealth);
  return counters;
};
