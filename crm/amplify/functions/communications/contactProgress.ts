import { automaticContactTask, contactAt, contactProgress, sameContact } from "../../../../shared/contactProgress";
import { followUpDeadline, taskWakeAt, type Communication, type LeadTask } from "../../../../shared/leadWorkflow";
import { accountRows, ensureWorkflow, makeTask } from "./workflow";
import { get, row, put, commit, check, query, save, conflict, type Row } from "./store";
import { operationRow } from "./outbox";
import { config } from "./config";
import type { Operation } from "./operations";

async function purpose(c: Communication): Promise<Communication> {
  const link = c.conversationId ? await get<{ purpose?: "PROSPECT" | "CARRIER" }>(`front-link:${c.conversationId}`) : undefined;
  return { ...c, purpose: link?.data.purpose ?? c.purpose ?? "PROSPECT" };
}

/** Serialize inbound/waiting transitions without changing the editable lead-team version. */
export async function contactFence(accountId: string) {
  const id = `contact-fence:${accountId}`, old = await get(id);
  if (old) return old;
  try { return await save(row("CONTACT_FENCE", id, {})); }
  catch (e) { if (!conflict(e)) throw e; const current = await get(id); if (!current) throw e; return current; }
}

/** Bounded transactions can resume after any interruption. No second note is written. */
export async function applyContactProgress(input: Communication, repair = false) {
  const projection = await get<Communication>(input.id);
  if (!projection?.accountId || projection.kind !== "COMMUNICATION") return;
  const comm = await purpose(projection.data), progress = contactProgress(comm);
  if (!progress) return;
  if (projection.data.contactAppliedKind === progress && !repair) return;
  let changed = false;
  const accountId = projection.accountId, at = contactAt(comm), wf = await ensureWorkflow(accountId);
  if (wf.data.disposition !== "ACTIVE") return;
  const fence = await contactFence(accountId);
  const role = comm.purpose === "CARRIER" ? "CHAMPION" : "SALESPERSON";
  const activity = new Map((await accountRows<Communication>(accountId, "COMMUNICATION")).map(r => [r.id, r]));
  activity.set(projection.id, projection);
  const candidates = new Map((await accountRows<LeadTask>(accountId, "TASK")).map(t => [t.id, t]));
  // Known keys close the normal event/index visibility gap.
  for (const key of [comm.conversationId, comm.providerId].filter(Boolean)) {
    for (const prefix of ["response", "carrier", "wait"]) {
      const t = await get<LeadTask>(`task:${prefix}:${accountId}:${key}`);
      if (t?.accountId === accountId) candidates.set(t.id, t);
    }
  }
  for (const candidate of candidates.values()) {
    const t = await get<LeadTask>(candidate.id);
    if (!t || t.accountId !== accountId || t.data.status !== "OPEN" || t.data.role !== role || !automaticContactTask(t.data)) continue;
    if (t.data.sourceIds?.includes(comm.id) && (t.data.sourceAt ?? t.createdAt) >= at) continue;
    const ids = t.data.sourceIds ?? (t.data.episode ? [t.data.episode] : []);
    const sources: Row<Communication>[] = [];
    for (const id of ids) {
      let source = await get<Communication & { canonicalId?: string }>(id);
      const visited = new Set<string>();
      while (source?.kind === "CALL_REDIRECT" && source.data.canonicalId && !visited.has(source.id) && visited.size < 64) {
        visited.add(source.id); source = await get<Communication & { canonicalId?: string }>(source.data.canonicalId);
      }
      if (source?.kind === "COMMUNICATION" && source.accountId === accountId) { sources.push({ ...source, id }); activity.set(source.id, source); }
    }
    const matched: string[] = [];
    for (const source of sources) if (source.data.at <= at && sameContact(comm, await purpose(source.data))) matched.push(source.id);
    const fallback = !ids.length && !!comm.conversationId && t.data.conversationId === comm.conversationId && (t.data.sourceAt ?? t.createdAt) <= at;
    if (progress !== "CONTACT" || !matched.length && !fallback) continue;
    const remaining = ids.filter(id => !matched.includes(id));
    const data: LeadTask = remaining.length ? { ...t.data, sourceIds: remaining, version: t.version + 1 }
      : { ...t.data, status: "COMPLETE", completedByCommunicationId: comm.id, reason: "Contact recorded automatically", version: t.version + 1 };
    await commit([check(wf), check(fence), check(projection), put(row("TASK", t.id, data, { accountId, previous: t, dueAt: taskWakeAt(data) }), t)]);
    changed = true;
  }
  const scoped: Communication[] = [];
  for (const candidate of activity.values()) scoped.push(await purpose(candidate.data));
  if (progress === "CONTACT") {
    const resolved = scoped.filter(c => c.id !== comm.id && c.direction === "INBOUND" && c.at <= at && sameContact(comm, c));
    for (let i = 0; i < resolved.length; i += 60) {
      const writes = [check(wf), check(fence), check(projection)];
      for (const c of resolved.slice(i, i + 60)) {
        const old = await get<Communication>(c.id);
        if (old?.accountId === accountId && !old.data.resolved) writes.push(put(row("COMMUNICATION", old.id, { ...old.data, resolved: true, resolvedByCommunicationId: comm.id }, { accountId, previous: old }), old));
      }
      if (writes.length > 3) { await commit(writes); changed = true; }
    }
  }
  const laterInbound = scoped.some(c => c.direction === "INBOUND" && c.id !== comm.id && c.at > at && c.classification !== "AUTOMATIC" && sameContact(comm, c));
  const laterContact = scoped.some(c => c.id !== comm.id && !!contactProgress(c) && contactAt(c) > at && sameContact(comm, c));
  const custom = [...candidates.values()].some(t => t.data.status === "OPEN" && t.data.custom && !automaticContactTask(t.data) && t.data.role === role);
  const pendingCallback = [...candidates.values()].some(t => t.data.status === "OPEN" && t.data.kind === "CALLBACK" && t.data.role === role);
  const id = `task:wait:${accountId}:${comm.conversationId ?? (comm.direction === "INBOUND" ? comm.from : comm.to?.[0]) ?? comm.providerId}${role === "CHAMPION" ? ":champion" : ""}`;
  const previous = await get<LeadTask>(id);
  const writes = [check(wf), put(row("CONTACT_FENCE", fence.id, {}, { previous: fence }), fence)];
  // Newer inbound work supersedes waiting; old/replayed sends cannot move its date.
  if (!laterInbound && !laterContact && !custom && !(progress === "ATTEMPT" && pendingCallback) && (!previous?.data.sourceAt || previous.data.sourceAt < at || projection.data.contactAppliedKind === "ATTEMPT" && progress === "CONTACT")) {
    const task = await makeTask({ id, accountId, role, kind: "FOLLOW_UP",
      title: progress === "ATTEMPT" ? "Try the prospect again" : role === "CHAMPION" ? "Follow up with carrier" : "Follow up with prospect",
      sourceAt: at, conversationId: comm.conversationId,
      dueAt: followUpDeadline(at, progress === "ATTEMPT" ? 1 : 2, (await config()).holidays) });
    task.sourceIds = [comm.id]; task.version = (previous?.version ?? 0) + 1;
    writes.push(put(row("TASK", id, task, { accountId, previous, dueAt: taskWakeAt(task) }), previous));
    changed = true;
  }
  if (!changed && projection.data.contactAppliedKind === progress) return;
  writes.push(put(row("COMMUNICATION", comm.id, { ...projection.data, contactApplied: true, contactAppliedKind: progress, workflowApplied: true,
    ...(comm.channel === "CALL" ? { outcome: progress === "CONTACT" ? "CONNECTED" : "NO_ANSWER", outcomeAt: at, resolved: true } : {}) }, { accountId, previous: projection, dueAt: comm.channel === "CALL" ? undefined : projection.dueAt }), projection));
  const conversations = new Set([comm.conversationId, wf.data.conversationId].filter((s): s is string => !!s));
  for (const conversationId of conversations) {
    const key = `op:contact-cleanup:${comm.id}:${conversationId}`;
    const cleanup = await get<Operation>(key);
    if (!cleanup) writes.push(put(operationRow(key, { type: "ARCHIVE", accountId, conversationId })));
    else if (changed && cleanup.data.state === "SUPPRESSED") writes.push(put(row("OPERATION", key, { ...cleanup.data, state: "READY", attempts: 0, error: undefined }, { accountId, previous: cleanup, dueAt: new Date().toISOString() }), cleanup));
  }
  await commit(writes);
}

/** Old unanswered work and out-of-order provider events also use the actual communication. */
export async function repairContactWork(accountId: string, target?: Communication) {
  const activity = await accountRows<Communication>(accountId, "COMMUNICATION");
  const contacts = activity.filter(r => !!contactProgress(r.data)).sort((a,b) => contactAt(b.data).localeCompare(contactAt(a.data)));
  // Choose the newest matching contact for each request, rather than only the
  // account's newest ten messages (which could all concern someone else).
  const requests = target ? [target] : activity.filter(r => !r.data.resolved && r.data.direction === "INBOUND").map(r => r.data);
  const selected = new Map<string, Communication>();
  for (const request of requests) {
    const scoped = await purpose(request);
    for (const c of contacts) if (contactAt(c.data) >= request.at && sameContact(await purpose(c.data), scoped)) { selected.set(c.id, c.data); break; }
  }
  // Also create waiting work for recent outbound contact with no inbound episode.
  if (!target) for (const c of contacts.slice(0, 10)) selected.set(c.id, c.data);
  for (const c of selected.values()) await applyContactProgress(c, true);
}

export async function migrateContactProgress() {
  const key = "migration:automatic-contact-progress:v1", old = await get<{ cursor?: string; complete?: boolean }>(key);
  if (old?.data.complete && Date.now() - Date.parse(old.updatedAt) < 3600_000) return;
  const page = await query<LeadTask>("work", "TASK", old?.data.complete ? undefined : old?.data.cursor, 5);
  for (const accountId of new Set(page.items.map(t => t.accountId).filter((s): s is string => !!s))) await repairContactWork(accountId);
  await save(row("MIGRATION", key, { cursor: page.nextToken, complete: !page.nextToken }, { previous: old }), old);
}
