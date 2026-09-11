import { interimResponse } from "../../../../shared/serviceEvidence";
import { taskDomain } from "../../../../shared/workRouting";
import { automaticContactTask, contactAt, contactProgress, sameContact, type ContactPair } from "../../../../shared/contactProgress";
import { followUpDeadline, taskWakeAt, normalizePhone, type Communication, type LeadTask } from "../../../../shared/leadWorkflow";
import { accountRows, ensureWorkflow, makeTask } from "./workflow";
import { get, row, put, commit, check, query, save, conflict, type Row } from "./store";
import { operationRow } from "./outbox";
import { config } from "./config";
import { dataClient } from "./data";
import type { Operation } from "./operations";

async function purpose(c: Communication): Promise<Communication> {
  const link = c.conversationId ? await get<{ purpose?: "PROSPECT" | "CARRIER"; context?: Communication["context"]; policyId?: string; quoteId?: string }>(`front-link:${c.conversationId}`) : undefined;
  return { ...c, purpose: link?.data.purpose ?? c.purpose ?? "PROSPECT", context: link?.data.context ?? c.context, policyId: link?.data.policyId ?? c.policyId, quoteId: link?.data.quoteId ?? c.quoteId };
}

/** Only contacts already belonging to this lead can join email and phone activity. */
export async function accountContactPairs(accountId: string): Promise<ContactPair[]> {
  const account = await (await dataClient()).models.Account.get({ id: accountId });
  if (account.errors?.length || !account.data) throw new Error("The lead's contacts could not be loaded");
  const contacts: ContactPair[] = []; let nextToken: string | undefined;
  do {
    const page = await account.data.contacts({ limit: 100, nextToken });
    if (page.errors?.length) throw new Error("The lead's contacts could not be loaded");
    contacts.push(...page.data); nextToken = page.nextToken ?? undefined;
  } while (nextToken);
  return contacts;
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
  if (["LOST", "DISQUALIFIED"].includes(wf.data.disposition)) return;
  const context = comm.context ?? (wf.data.disposition === "BOUND" && !wf.data.openLeadQuoteIds?.length ? "SERVICE" : "LEAD"), domain = comm.purpose === "CARRIER" ? "CARRIER" : "CLIENT";
  const fence = await contactFence(accountId);
  const contactPairs = await accountContactPairs(accountId);
  const role = domain === "CARRIER" || context !== "LEAD" ? "CHAMPION" : "SALESPERSON";
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
  for (const key of [`task:first:${accountId}`, ...(wf.data.deferredExpiration ? [`task:annual:${accountId}:${wf.data.deferredExpiration}`] : [])]) {
    const t = await get<LeadTask>(key); if (t) candidates.set(t.id, t);
  }
  let returnedMissedCall = false, annualReturned = false;
  let followUpCount = 0;
  const satisfiedSourceIds = new Set<string>();
  for (const candidate of candidates.values()) {
    const t = await get<LeadTask>(candidate.id);
    if (t?.data.completedByCommunicationId === comm.id) {
      returnedMissedCall ||= t.data.kind === "CALLBACK";
    annualReturned ||= t.data.kind === "ANNUAL_RETURN";
      followUpCount = Math.max(followUpCount, (t.data.followUpCount ?? 0) + (t.data.kind === "FOLLOW_UP" && t.data.dueAt <= at ? 1 : 0));
      for (const id of t.data.sourceIds ?? []) satisfiedSourceIds.add(id);
    }
    if (!t || t.accountId !== accountId || t.data.status !== "OPEN" || taskDomain(t.data) !== domain || !automaticContactTask(t.data)) continue;
    if ((t.data.context ?? "LEAD") !== context || t.data.policyId && t.data.policyId !== comm.policyId || t.data.quoteId && t.data.quoteId !== comm.quoteId) continue;
    if (t.data.kind === "ANNUAL_RETURN" && at < t.data.dueAt) continue;
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
    for (const source of sources) if (source.data.at <= at && sameContact(comm, await purpose(source.data), contactPairs)) matched.push(source.id);
    const knownContact = contactPairs.some(p => [p.email?.toLowerCase(), p.phone ? normalizePhone(p.phone) : undefined].some(handle => handle && (comm.to ?? [comm.from]).some(to => to && (to.toLowerCase() === handle || normalizePhone(to) === handle))));
    const fallback = !ids.length && (t.data.conversationId && t.data.conversationId === comm.conversationId || (["FIRST_CONTACT", "ANNUAL_RETURN"].includes(t.data.kind) || t.data.kind === "DOCUMENTS" && t.data.parentTaskId) && knownContact) && (t.data.sourceAt ?? t.createdAt) <= at;
    if (!matched.length && !fallback) continue;
    returnedMissedCall ||= t.data.kind === "CALLBACK";
    annualReturned ||= t.data.kind === "ANNUAL_RETURN";
    followUpCount = Math.max(followUpCount, (t.data.followUpCount ?? 0) + (t.data.kind === "FOLLOW_UP" && t.data.dueAt <= at ? 1 : 0));
    for (const source of matched) satisfiedSourceIds.add(source);
    const remaining = ids.filter(id => !matched.includes(id));
    const data: LeadTask = remaining.length ? { ...t.data, sourceIds: remaining, version: t.version + 1 }
      : { ...t.data, status: "COMPLETE", completedByCommunicationId: comm.id, attemptAt: at, reason: progress === "ATTEMPT" ? "Outbound attempt recorded; request remains open with a next retry" : "Contact recorded automatically", version: t.version + 1 };
    await commit([check(wf), check(fence), check(projection), put(row("TASK", t.id, data, { accountId, previous: t, dueAt: taskWakeAt(data) }), t)]);
    changed = true;
  }
  const scoped: Communication[] = [];
  for (const candidate of activity.values()) scoped.push(await purpose(candidate.data));
  {
    const resolved = scoped.filter(c => c.id !== comm.id && c.direction === "INBOUND" && c.at <= at && sameContact(comm, c, contactPairs));
    for (let i = 0; i < resolved.length; i += 60) {
      const writes = [check(wf), check(fence), check(projection)];
      for (const c of resolved.slice(i, i + 60)) {
        const old = await get<Communication>(c.id);
        if (old?.accountId === accountId && !old.data.resolved) writes.push(put(row("COMMUNICATION", old.id, { ...old.data, ...(progress === "CONTACT" ? { resolved: true, resolvedByCommunicationId: comm.id } : { outreachAt: at, outreachByCommunicationId: comm.id }) }, { accountId, previous: old }), old));
      }
      if (writes.length > 3) { await commit(writes); changed = true; }
    }
  }
  const laterInbound = scoped.some(c => c.direction === "INBOUND" && c.id !== comm.id && c.at > at && c.classification !== "AUTOMATIC" && sameContact(comm, c, contactPairs));
  const laterContact = scoped.some(c => c.id !== comm.id && !!contactProgress(c) && contactAt(c) > at && sameContact(comm, c, contactPairs));
  const custom = [...candidates.values()].some(t => t.data.status === "OPEN" && t.data.custom && !automaticContactTask(t.data) && t.data.role === role);
  const marketing = await get<{ waitingOnCarrier?: boolean }>(`marketing-context:${accountId}`);
  // The outreach task closes when the salesperson asks for information. Its
  // underlying underwriting requirement remains open until the information
  // is actually supplied, so that request keeps the two-day follow-up cadence.
  const prospectOwes = [...candidates.values()].some(t => t.data.status === "OPEN" && t.data.kind === "DOCUMENTS" && (taskDomain(t.data) === "CLIENT" || t.data.milestone && t.data.parentTaskId));
  const weekly = context === "LEAD" && domain === "CLIENT" && marketing?.data.waitingOnCarrier && !prospectOwes;
  const deferred = context === "LEAD" && wf.data.deferredUntil && at < wf.data.deferredUntil;
  const routineWaiting = (context !== "SERVICE" || interimResponse(comm)) && (!deferred || returnedMissedCall || satisfiedSourceIds.size > 0);

  const id = `task:wait:${accountId}:${comm.conversationId ?? (comm.direction === "INBOUND" ? comm.from : comm.to?.[0]) ?? comm.providerId}${role === "CHAMPION" ? ":champion" : ""}`;
  const previous = await get<LeadTask>(id);
  const writes = [annualReturned ? put(row("WORKFLOW", wf.id, { ...wf.data, deferredUntil: undefined, version: wf.version + 1 }, { accountId, previous: wf }), wf) : check(wf), put(row("CONTACT_FENCE", fence.id, {}, { previous: fence }), fence)];
  // Newer inbound work supersedes waiting; old/replayed sends cannot move its date.
  if (!laterInbound && !laterContact && !custom && (routineWaiting || progress === "ATTEMPT") && (!previous?.data.sourceAt || previous.data.sourceAt < at || previous.data.status === "CANCELLED" && previous.data.reason === "The email has not been sent" && previous.data.sourceIds?.includes(comm.id) || projection.data.contactAppliedKind === "ATTEMPT" && progress === "CONTACT")) {
    followUpCount = Math.max(followUpCount, previous?.data.followUpCount ?? 0);
    const task = await makeTask({ id, accountId, role, domain, context, policyId: comm.policyId, kind: weekly ? "PROSPECT_UPDATE" : "FOLLOW_UP",
      title: progress === "ATTEMPT" ? "Try again" : domain === "CARRIER" ? "Follow up with carrier" : weekly ? "Keep the prospect informed" : context !== "LEAD" ? (context === "SERVICE" ? "Follow up on the service request" : "Follow up on renewal information") : "Follow up with prospect",
      sourceAt: at, conversationId: comm.conversationId,
      dueAt: followUpDeadline(at, progress === "ATTEMPT" && returnedMissedCall ? 1 : weekly || context === "LEAD" && domain === "CLIENT" && followUpCount >= 2 ? 5 : 2, (await config()).holidays) });
    task.sourceIds = [comm.id]; task.followUpCount = followUpCount; task.requirementSourceIds = progress === "ATTEMPT" ? [...satisfiedSourceIds] : undefined; task.waitingOn = weekly ? "CARRIER" : domain === "CARRIER" ? "CARRIER" : context === "LEAD" ? "PROSPECT" : "CLIENT"; task.version = (previous?.version ?? 0) + 1;
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
  const coverageId = `lifecycle:contact:${comm.id}`;
  if (!await get(coverageId)) await save(row("LIFECYCLE", coverageId, { accountId }, { accountId, dueAt: new Date().toISOString() }));
}

/** Old unanswered work and out-of-order provider events also use the actual communication. */
export async function repairContactWork(accountId: string, target?: Communication) {
  const activity = await accountRows<Communication>(accountId, "COMMUNICATION");
  const contacts = activity.filter(r => !!contactProgress(r.data) && (r.data.provider !== "front" || r.data.frontDraft === false)).sort((a,b) => contactAt(b.data).localeCompare(contactAt(a.data)));
  if (!contacts.length) return;
  const contactPairs = await accountContactPairs(accountId);
  // Choose the newest matching contact for each request, rather than only the
  // account's newest ten messages (which could all concern someone else).
  const requests = target ? [target] : activity.filter(r => !r.data.resolved && r.data.direction === "INBOUND").map(r => r.data);
  const selected = new Map<string, Communication>();
  for (const request of requests) {
    const scoped = await purpose(request);
    for (const c of contacts) if (contactAt(c.data) >= request.at && sameContact(await purpose(c.data), scoped, contactPairs)) { selected.set(c.id, c.data); break; }
  }
  // Also create waiting work for recent outbound contact with no inbound episode.
  if (!target) for (const c of contacts.slice(0, 10)) selected.set(c.id, c.data);
  for (const c of selected.values()) await applyContactProgress(c, true);
}

export async function migrateContactProgress() {
  const key = "migration:automatic-contact-progress:v3", old = await get<{ cursor?: string; complete?: boolean }>(key);
  if (old?.data.complete && Date.now() - Date.parse(old.updatedAt) < 3600_000) return;
  const page = await query<LeadTask>("work", "TASK", old?.data.complete ? undefined : old?.data.cursor, 5);
  for (const accountId of new Set(page.items.map(t => t.accountId).filter((s): s is string => !!s))) await repairContactWork(accountId);
  await save(row("MIGRATION", key, { cursor: page.nextToken, complete: !page.nextToken }, { previous: old }), old);
}
