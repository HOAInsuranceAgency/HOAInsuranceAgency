import { config } from "./config";
import { historyDue, restartHistory, type HistoryJob } from "./history";
import { front, dialpad, dialpadCallItems } from "./providers";
import { get, row, save, put, commit, canonical, hash, issue } from "./store";
import type { EventRecord } from "./events";
import { dialpadBusinessLine, unidentifiedDialpadReceipt } from "./phoneScope";

async function reconcileFront() {
  const c = await config(); if (!c.activatedAt) return;
  const activation = Date.parse(c.activatedAt), inboxes = [...new Set([c.frontInboxId, ...c.allowedInboxIds].filter((x): x is string => !!x))];
  if (!inboxes.length) return;
  const old = await get<{ next?: string; pending?: string[]; messageNext?: string; inbox?: number; after?: number; through?: number }>("cursor:front");
  const inbox = (old?.data.inbox ?? 0) % inboxes.length, after = old?.data.after ?? activation, through = old?.data.through ?? Date.now();
  let pending = old?.data.pending ?? [], next = old?.data.next;
  if (!pending.length) {
    const search = `inbox:${inboxes[inbox]} after:${Math.floor(after / 1000)} before:${Math.ceil(through / 1000)}`;
    const page = await front<{ _results: { id: string }[]; _pagination?: { next?: string } }>(next ?? `/conversations/search/${encodeURIComponent(search)}?limit=25`);
    if (!Array.isArray(page._results)) throw new Error("Front conversation history needs review");
    pending = page._results.map(r => r?.id); next = page._pagination?.next;
  }
  // Capture independent replayable jobs before advancing the search cursor.
  // A broken conversation can no longer trap all the other conversations.
  for (const cnv of pending) {
    if (typeof cnv !== "string" || !/^cnv_[a-z0-9]+$/.test(cnv)) {
      await issue(`reconcile:front:${hash(canonical(cnv))}`, "Front history returned an invalid conversation ID"); continue;
    }
    const key = `front-reconcile:${cnv}`, job = await get<HistoryJob>(key);
    if (historyDue(job)) await save(restartHistory(key, cnv, job?.accountId, job), job);
  }
  const finishedInbox = !next, finishedCycle = finishedInbox && inbox + 1 >= inboxes.length;
  await save(row("CURSOR", "cursor:front", { next, inbox: finishedInbox ? (inbox + 1) % inboxes.length : inbox,
    after: finishedCycle ? Math.max(activation, through - 6 * 3600_000) : after, through: finishedCycle ? undefined : through, checkedAt: new Date().toISOString() }, { previous: old }), old);
}
async function reconcileDialpad() {
  const c = await config(); if (!c.activatedAt || !c.dialpadCompanyId || !c.dialpadNumbers.length) return;
  const activation = Date.parse(c.activatedAt), old = await get<{ cursor?: string; after?: number; through?: number }>("cursor:dialpad");
  const after = old?.data.after ?? activation, through = old?.data.through ?? Date.now();
  const params = new URLSearchParams({ started_after: String(after), started_before: String(through) });
  if (old?.data.cursor) params.set("cursor", old.data.cursor);
  const page = await dialpad<{ items?: Record<string, unknown>[]; cursor?: string }>(`/call?${params}`);
  for (const item of dialpadCallItems(page)) {
    const p = item && typeof item === "object" ? item : {}, id = String(p.call_id ?? p.id);
    const valid = /^\d+$/.test(id);
    const line = dialpadBusinessLine(p);
    if (line && !c.dialpadNumbers.includes(line)) continue;
    const snapshot = Object.fromEntries(["call_id", "master_call_id", "entry_point_call_id", "operator_call_id", "internal_number", "external_number", "from_number", "to_number", "direction", "date_started", "date_connected", "date_ended", "target", "entry_point_target", "transcription_text", "recap_summary"].map(key => [key, p[key]]));
    const key = `reconcile:dialpad:${valid ? id : "invalid"}:${hash(canonical(valid ? snapshot : item))}`;
    if (await get(key)) continue;
    const error = !valid ? "Dialpad call history returned an invalid call ID" : !line ? "Dialpad call history has no identifiable business line; review the provider record" : undefined;
    // Unidentified items retain provider IDs for review, without storing content
    // whose business-line scope could not be established.
    // Any failed storage write still prevents checkpoint advancement.
    await commit([put(row<EventRecord & { error?: string }>("EVENT", key, { provider: "dialpad", payload: line ? valid ? { ...p, call_id: id, state: "hangup" } : p : unidentifiedDialpadReceipt(p), attempts: 0, error }, { dueAt: !error ? new Date().toISOString() : undefined })),
      ...(error ? [put(row("ISSUE", `issue:${key}`, { sourceId: key, message: error, at: new Date().toISOString(), resolved: false }))] : [])]);
  }
  await save(row("CURSOR", "cursor:dialpad", { cursor: page.cursor, after: page.cursor ? after : Math.max(activation, through - 86400_000), through: page.cursor ? through : undefined, checkedAt: new Date().toISOString() }, { previous: old }), old);
}
/** Independent bounded capture, checkpointed only after durable per-item work. */
export async function reconcile() {
  const results = await Promise.allSettled([reconcileFront(), reconcileDialpad()]);
  for (const [index, result] of results.entries()) {
    const id = `reconcile:${index === 0 ? "front" : "dialpad"}`;
    if (result.status === "rejected") await issue(id, result.reason instanceof Error ? result.reason.message : "Provider reconciliation failed");
    else {
      const old = await get(`issue:${id}`);
      if (old && !old.data.resolved) await save(row("ISSUE", old.id, { ...old.data, resolved: true }, { previous: old }), old);
    }
  }
  return { lagging: results.some(r => r.status === "rejected") };
}
