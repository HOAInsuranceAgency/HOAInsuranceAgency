import { contactAt, contactProgress, sameContact, type ContactPair } from "../../../../shared/contactProgress";
import { type Communication } from "../../../../shared/leadWorkflow";
import { accountRows, ensureWorkflow } from "./workflow";
import { get, row, put, commit, check, save, conflict } from "./store";
import { operationRow } from "./outbox";
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
  const fence = await contactFence(accountId);
  const contactPairs = await accountContactPairs(accountId);
  const activity = new Map((await accountRows<Communication>(accountId, "COMMUNICATION")).map(r => [r.id, r]));
  activity.set(projection.id, projection);
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
  const writes = [check(wf), put(row("CONTACT_FENCE", fence.id, {}, { previous: fence }), fence)];
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
  // Preserve contact evidence for recent outbound correspondence too.
  if (!target) for (const c of contacts.slice(0, 10)) selected.set(c.id, c.data);
  for (const c of selected.values()) await applyContactProgress(c, true);
}

/** The task-based repair sweep is retired; actual provider events still reconcile evidence. */
export async function migrateContactProgress() { return { retired: true }; }
