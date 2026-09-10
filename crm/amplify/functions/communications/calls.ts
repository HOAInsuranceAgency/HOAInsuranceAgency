import { taskWakeAt } from "../../../../shared/leadWorkflow";
import type { Communication, LeadTask } from "../../../../shared/leadWorkflow";
import { get, row, save, put, commit, check, issue, type Row } from "./store";
import { accountRows, ensureWorkflow } from "./workflow";

export type Call = Communication & { legs?: Record<string, { connected: boolean; ended: boolean }>; relatedIds?: string[]; relatedConversationIds?: string[] };
const commId = (id: string) => `comm:dialpad:call:${id}`;
export async function callRoot(id: string): Promise<string> {
  const visited = new Set<string>();
  while (!visited.has(id) && visited.size < 64) {
    visited.add(id);
    const alias = await get<{ root: string }>(`call-alias:${id}`);
    if (!alias || alias.data.root === id) return id;
    id = alias.data.root;
  }
  throw new Error("Dialpad call relationships need review");
}
export function callStatus(legs: NonNullable<Call["legs"]>) {
  return Object.values(legs).some(l => l.connected) ? "CONNECTED" : Object.values(legs).length && Object.values(legs).every(l => l.ended) ? "MISSED" : "IN_PROGRESS";
}
export function combineLegs(...sources: (Call["legs"] | undefined)[]) {
  const result: NonNullable<Call["legs"]> = {};
  for (const source of sources) for (const [id, leg] of Object.entries(source ?? {})) result[id] = { connected: !!(result[id]?.connected || leg.connected), ended: !!(result[id]?.ended || leg.ended) };
  return result;
}
/** Union known provider relationships even if both legs were captured first.
 * Each pair, its redirects, and a repair job commit together; replay can finish
 * an interrupted multi-leg union without losing already-linked work. */
export async function uniteCalls(ids: string[]) {
  const root = await callRoot(ids[0]);
  for (const id of [...new Set(ids)]) {
    const other = await callRoot(id);
    if (other === root) continue;
    const target = await get<Call>(commId(root)), source = await get<Call>(commId(other));
    const alias = await get(`call-alias:${other}`);
    const targetLink = await get<{ accountId: string; conversationId?: string }>(`activity-link:${commId(root)}`);
    const sourceLink = await get<{ accountId: string; conversationId?: string }>(`activity-link:${commId(other)}`);
    const accounts = new Set([target?.accountId, source?.accountId, targetLink?.data.accountId, sourceLink?.data.accountId].filter(Boolean));
    if (accounts.size > 1) {
      await issue(`call-relationship:${root}:${other}`, "Related Dialpad call legs are linked to different associations. Review both links before combining them.");
      throw new Error("Related call legs have conflicting association links");
    }
    const accountId = [...accounts][0];
    const writes = [put(row("CALL_ALIAS", `call-alias:${other}`, { root }, { previous: alias }), alias)];
    if (source) {
      const legs = combineLegs(target?.data.legs, source.data.legs);
      const relatedIds = [...new Set([root, other, ...(target?.data.relatedIds ?? []), ...(source.data.relatedIds ?? [])])];
      if (relatedIds.length > 64) throw new Error("This call has more than 64 related legs; review before combining more");
      const data: Call = { ...source.data, ...target?.data, id: commId(root), providerId: root, accountId, legs, relatedIds,
        relatedConversationIds: [...new Set([target?.data.conversationId, source.data.conversationId, ...(target?.data.relatedConversationIds ?? []), ...(source.data.relatedConversationIds ?? [])].filter((id): id is string => !!id))],
        at: [source.data.at, target?.data.at].filter((s): s is string => !!s).sort()[0], status: callStatus(legs),
        conversationId: targetLink?.data.conversationId ?? target?.data.conversationId ?? sourceLink?.data.conversationId ?? source.data.conversationId,
        resolved: !!(target?.data.resolved || source.data.resolved), workflowApplied: !!(target?.data.workflowApplied || source.data.workflowApplied),
        text: target?.data.text || source.data.text, summary: target?.data.summary || source.data.summary, version: (target?.version ?? 0) + 1 };
      writes.push(put(row("COMMUNICATION", data.id, data, { accountId, previous: target, dueAt: data.status === "MISSED" && !data.resolved ? [source.dueAt, target?.dueAt, new Date().toISOString()].filter((s): s is string => !!s).sort()[0] : undefined }), target));
      // Keep the original record for review, out of the account timeline and due queue.
      writes.push(put(row("CALL_REDIRECT", source.id, { ...source.data, canonicalId: data.id }, { previous: source }), source));
      if (sourceLink && !targetLink) writes.push(put(row("LINK", `activity-link:${data.id}`, sourceLink.data, { accountId })));
      for (const key of [`triage:${source.id}`, `issue:${source.id}`, ...(accountId ? [`triage:${data.id}`, `issue:${data.id}`] : [])]) {
        const old = await get(key);
        if (old) writes.push(put(row(old.kind, key, { ...old.data, resolved: true, canonicalId: data.id }, { previous: old }), old));
      }
    }
    const job = await get(`call-sync:${root}`);
    writes.push(put(row("CALL_SYNC", `call-sync:${root}`, { providerId: root }, { previous: job, dueAt: new Date().toISOString() }), job));
    await commit(writes);
  }
  return root;
}

/** Repair one bounded page of commitments. Custom promises and mixed requests
 * keep their dates; only duplicate automatic callbacks for this call collapse. */
export async function syncCall(candidate: Row<{ providerId: string }>) {
  const job = await get<typeof candidate.data>(candidate.id); if (!job?.dueAt) return;
  const root = await callRoot(job.data.providerId), comm = await get<Call>(commId(root));
  if (comm?.accountId) {
    const ids = new Set([comm.id, ...(comm.data.relatedIds ?? []).map(commId)]);
    // The account index may lag a callback transaction. Known automatic task
    // keys are read strongly so a late answered leg cannot leave one behind.
    const knownKeys = [...new Set([root, ...(comm.data.relatedIds ?? []), ...Object.keys(comm.data.legs ?? {}), comm.data.conversationId, ...(comm.data.relatedConversationIds ?? [])].filter(Boolean))];
    const direct = await Promise.all(knownKeys.map(key => get<LeadTask>(`task:response:${comm.accountId}:${key}`)));
    const all = new Map((await accountRows<LeadTask>(comm.accountId, "TASK")).map(t => [t.id, t]));
    for (const task of direct) if (task) all.set(task.id, task);
    const tasks = [...all.values()].filter(t => t.data.status === "OPEN" && t.data.sourceIds?.some(id => ids.has(id)));
    const automatic = tasks.filter(t => t.data.kind === "CALLBACK" && !t.data.custom && t.data.sourceIds?.every(id => ids.has(id))).sort((a,b) => a.data.dueAt.localeCompare(b.data.dueAt) || a.id.localeCompare(b.id));
    const survivor = comm.data.status === "CONNECTED" || comm.data.resolved ? undefined : automatic[0];
    const edits = automatic.filter(t => t.id !== survivor?.id).slice(0, 25);
    const wf = await ensureWorkflow(comm.accountId), writes = [check(wf), check(comm)];
    if (survivor && edits.length) {
      const data = { ...survivor.data, sourceIds: [comm.id], escalationAt: automatic.map(t => t.data.escalationAt).sort()[0], version: survivor.version + 1 };
      writes.push(put(row("TASK", survivor.id, data, { accountId: comm.accountId, previous: survivor, dueAt: taskWakeAt(data) }), survivor));
    }
    for (const task of edits) writes.push(put(row("TASK", task.id, { ...task.data, status: "CANCELLED", reason: survivor ? `Same Dialpad call as ${survivor.id}` : "A related call leg was answered or handled; record its outcome", version: task.version + 1 }, { accountId: comm.accountId, previous: task }), task));
    writes.push(put(row("CALL_SYNC", job.id, job.data, { previous: job, dueAt: automatic.length - (survivor ? 1 : 0) > edits.length ? new Date().toISOString() : undefined }), job));
    await commit(writes);
  } else await save(row("CALL_SYNC", job.id, job.data, { previous: job }), job);
}
export async function queueCallSync(providerId: string) {
  const id = `call-sync:${providerId}`, old = await get(id);
  const job = await save(row("CALL_SYNC", id, { providerId }, { previous: old, dueAt: new Date().toISOString() }), old);
  await syncCall(job);
}
