import { salespersonEligibility, salespersonTask, salespersonWorkflow } from "../../../../shared/salespersonOwnership";
import { randomUUID } from "node:crypto";
import { CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { businessDeadline, followUpDeadline, scheduleReminders, taskWakeAt, type LeadWorkflow, type LeadTask, type TeamEligibility, type TaskKind, type Responsibility, type Communication } from "../../../../shared/leadWorkflow";
import { get, row, put, commit, query, audit, save, conflict, check, type Row, type Write } from "./store";
import { config } from "./config";
import { operationRow } from "./outbox";
import { dataClient } from "./data";
import { sameContact } from "../../../../shared/contactProgress";

const cognito = new CognitoIdentityProviderClient();
export class UnavailableTeammateError extends Error {}
export async function enabledUser(userId: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(userId)) throw new Error("Invalid teammate identity");
  const out = await cognito.send(new ListUsersCommand({ UserPoolId: process.env.USER_POOL_ID, Filter: `sub = "${userId}"`, Limit: 1 }));
  if (!out.Users?.[0]?.Enabled) throw new UnavailableTeammateError("This teammate is disabled or no longer available");
  return out.Users[0];
}
export async function team() {
  const out: TeamEligibility[] = [];
  let cursor: string | undefined;
  do { const page = await query<TeamEligibility>("kind", "ELIGIBILITY", cursor); out.push(...page.items.map(r => ({ ...salespersonEligibility(r.data), version: r.version }))); cursor = page.nextToken; } while (cursor);
  return out;
}
export async function validRole(userId: string, role: Responsibility, checkEnabled = true) {
  const member = await get<TeamEligibility>(`eligibility:${userId}`);
  if (role !== "SALESPERSON" || !member?.data.enabled || !member.data.salesperson) throw new Error("Choose an enabled teammate eligible for this responsibility");
  if (checkEnabled) await enabledUser(userId);
  return member.data;
}
export async function defaultWorkflow(accountId: string, name: string): Promise<LeadWorkflow> {
  const c = await config();
  let assignmentIssue: string | undefined;
  const salespersonId = c.defaultSalespersonId ?? c.defaultUserId;
  try {
    if (!salespersonId) throw new Error("Choose the default salesperson in Team settings");
    await validRole(salespersonId, "SALESPERSON");
  } catch (e) { assignmentIssue = e instanceof Error ? e.message : "Default assignment needs attention"; }
  return { accountId, name, salespersonId, ownershipModel: "SALESPERSON", assignmentIssue, disposition: "ACTIVE", version: 1, updatedAt: new Date().toISOString() };
}
export async function ensureWorkflow(accountId: string): Promise<Row<LeadWorkflow>> {
  const old = await get<LeadWorkflow>(`workflow:${accountId}`);
  if (old) {
    if (old.data.ownershipModel === "SALESPERSON" && !old.data.championId) return old;
    // Preserve the assigned salesperson. Missing owners use a verified default;
    // a retired champion is never silently made eligible or given the account.
    const data = salespersonWorkflow(old.data);
    if (!data.salespersonId) {
      const defaults = await defaultWorkflow(accountId, data.name);
      if (!defaults.assignmentIssue) data.salespersonId = defaults.salespersonId;
    }
    try {
      if (!data.salespersonId) throw new Error("Choose a salesperson for this account");
      await validRole(data.salespersonId, "SALESPERSON"); data.assignmentIssue = undefined;
    } catch (e) { data.assignmentIssue = e instanceof Error ? e.message : "Salesperson assignment needs attention"; }
    const next = row("WORKFLOW", old.id, { ...data, ownershipModel: "SALESPERSON" as const, version: old.version + 1, updatedAt: new Date().toISOString() }, { accountId, previous: old });
    const job = row("ROLE_SYNC", `role-sync:ownership:${accountId}`, { phase: "TASK", accountId }, { accountId, dueAt: new Date().toISOString() });
    const existing = await get(job.id);
    try { await commit([put(next, old), ...(!existing ? [put(job)] : [])]); }
    catch (e) {
      if (!conflict(e)) throw e;
      const current = await get<LeadWorkflow>(old.id);
      if (current?.data.ownershipModel === "SALESPERSON" && !current.data.championId) return current;
      throw e; // Retry the migration page if another edit won without migrating.
    }
    return next;
  }
  const client = await dataClient(); const account = await client.models.Account.get({ id: accountId });
  if (!account.data || account.errors?.length) throw new Error("The account could not be loaded");
  const data = await defaultWorkflow(accountId, account.data.name);
  if (account.data.stage === "CLIENT") data.disposition = "BOUND";
  const next = row("WORKFLOW", `workflow:${accountId}`, data, { accountId });
  try { await save(next); } catch (e) { if (!conflict(e)) throw e; return (await get<LeadWorkflow>(next.id))!; }
  return next;
}
export async function accountRows<T>(accountId: string, kind: string): Promise<Row<T>[]> {
  const rows: Row<T>[] = []; let cursor: string | undefined;
  do { const page = await query<T>("account", accountId, cursor, 100, `${kind}#`); rows.push(...page.items); cursor = page.nextToken; } while (cursor);
  return rows;
}
export function expected(old: Row<unknown>, version: unknown) {
  if (old.version !== version) throw new Error("This record changed. Refresh before saving.");
}
export async function setResponsibilities(accountId: string, salespersonId: string, version: number, actor: string) {
  const old = await ensureWorkflow(accountId); expected(old, version);
  await validRole(salespersonId, "SALESPERSON");
  const next = row("WORKFLOW", old.id, { ...salespersonWorkflow(old.data), salespersonId, assignmentIssue: undefined, version: old.version + 1, updatedAt: new Date().toISOString() }, { accountId, previous: old });
  const job = row("ROLE_SYNC", `role-sync:${accountId}:${next.version}`, { phase: "TASK", accountId }, { accountId, dueAt: new Date().toISOString() });
  await commit([put(next, old), put(job), audit(accountId, actor, "Salesperson changed", { salespersonId })]);
  await syncResponsibilities(job).catch(() => {}); // Durable job retries a failed first page.
  return next.data;
}
export async function syncResponsibilities(candidate: Row<{ phase: string; accountId: string; cursor?: string }>) {
  const job = await get<typeof candidate.data>(candidate.id); if (!job?.dueAt) return;
  const { accountId, phase } = job.data;
  if (await get(`deleted-account:${accountId}`)) {
    await save(row("ROLE_SYNC", job.id, job.data, { accountId, previous: job }), job); return;
  }
  const wf = await ensureWorkflow(accountId), { salespersonId } = wf.data;
  const page = await query<Record<string, unknown>>("account", accountId, job.data.cursor, 25, `${phase}#`);
  const writes: Write[] = [check(wf)];
  if (phase === "LINK") for (const item of page.items) {
    const link = item as unknown as Row<{ conversationId: string; routing?: string }>;
    if (link.data.routing === "MANUAL") continue;
    if (link.data.routing !== "SALESPERSON") writes.push(put(row("LINK", link.id, { ...link.data, routing: "SALESPERSON" }, { accountId, previous: link }), link));
    const member = salespersonId ? await get<TeamEligibility>(`eligibility:${salespersonId}`) : undefined;
    const key = `op:route:${job.id}:${link.id}`;
    if (member?.data.enabled && member.data.salesperson && member.data.frontId && !await get(key)) writes.push(put(operationRow(key, { type: "ASSIGN", accountId, conversationId: link.data.conversationId, assigneeId: member.data.frontId })));
  }
  if (phase === "TASK") for (const item of page.items) {
    const task = item as unknown as Row<LeadTask>;
    if (task.data.status !== "OPEN") continue;
    const normalized = salespersonTask(task.data);
    const route = await (await import("./routing")).resolveTaskRoute(normalized, wf.data);
    const directChanged = !!task.data.notifiedAt && task.data.notifiedRecipientId !== route.recipientId;
    const escalationChanged = !!task.data.escalatedAt && task.data.escalatedRecipientId !== route.managerId;
    if (!directChanged && !escalationChanged && JSON.stringify(normalized) === JSON.stringify(task.data)) continue;
    // Notify the new route at the original reminder opportunity. Old manager
    // receipts must not postpone the new salesperson until owner escalation.
    const nextReminderAt = taskWakeAt({ ...normalized, notifiedAt: undefined, escalatedAt: undefined, nextReminderAt: undefined, lastReminderAt: undefined });
    const data = { ...normalized, ...(directChanged || escalationChanged ? { notifiedAt: directChanged ? undefined : task.data.notifiedAt, nextReminderAt, lastReminderAt: undefined } : {}), version: task.version + 1 };
    writes.push(put(row("TASK", task.id, data, { accountId, previous: task, dueAt: directChanged || escalationChanged ? taskWakeAt(data) : task.dueAt }), task));
  }
  const checkedTaskIds = new Set<string>();
  if (phase === "NOTIFICATION") for (const notice of page.items) {
    if (notice.data.resolved) continue;
    const task = await get<LeadTask>(String(notice.data.taskId));
    const route = task ? await (await import("./routing")).resolveTaskRoute(task.data, wf.data) : undefined;
    if (!task || task.data.status !== "OPEN" || ![route?.recipientId, route?.managerId, route?.ownerId].includes(String(notice.data.recipient))) {
      writes.push(put(row("NOTIFICATION", notice.id, { ...notice.data, resolved: true }, { accountId, previous: notice }), notice));
      if (task && !checkedTaskIds.has(task.id)) { writes.push(check(task)); checkedTaskIds.add(task.id); }
    }
  }
  const done = phase === "NOTIFICATION" && !page.nextToken;
  writes.push(put(row("ROLE_SYNC", job.id, { ...job.data, phase: page.nextToken ? phase : phase === "TASK" ? "LINK" : "NOTIFICATION", cursor: page.nextToken }, { accountId, previous: job, dueAt: done ? undefined : new Date().toISOString() }), job));
  await commit(writes);
}
export async function makeTask(input: { accountId: string; title: string; kind: TaskKind; role?: Responsibility; dueAt?: string; sourceAt?: string; episode?: string; conversationId?: string; custom?: boolean; id?: string; domain?: LeadTask["domain"]; context?: LeadTask["context"]; term?: string; policyId?: string; quoteId?: string; milestone?: boolean; obligationKey?: string; lines?: string[]; marketingTaskId?: string; carrierId?: string; waitingOn?: LeadTask["waitingOn"]; businessDueAt?: string; shortTimeline?: boolean }): Promise<LeadTask> {
  if (!input.title?.trim() || input.title.length > 500 || !["FOLLOW_UP", "RESPONSE", "CALLBACK", "CARRIER", "DOCUMENTS", "CORRECTION", "TRIAGE", "FIRST_CONTACT", "ANNUAL_RETURN", "PROSPECT_UPDATE", "RENEWAL_START", "SUBMISSION", "QUOTE_TARGET", "QUOTE_PRESENTATION", "BIND", "SERVICE"].includes(input.kind) || input.role && !["SALESPERSON", "CHAMPION"].includes(input.role)) throw new Error("Invalid next action or responsible role");
  const holidays = (await config()).holidays;
  const sourceAt = input.sourceAt ?? new Date().toISOString();
  const dueAt = input.dueAt ?? (input.kind === "FOLLOW_UP" ? followUpDeadline(sourceAt, 2, holidays) : businessDeadline(sourceAt, 1, holidays));
  if (!Number.isFinite(Date.parse(dueAt))) throw new Error("Choose a valid due date");
  if (input.custom && Date.parse(dueAt) <= Date.now()) throw new Error("Choose a future date for a new promise");
  return scheduleReminders({ ...input, id: input.id ?? `task:${randomUUID()}`, domain: input.domain ?? (input.kind === "CARRIER" || input.role === "CHAMPION" && input.kind === "FOLLOW_UP" ? "CARRIER" : "CLIENT"), context: input.context ?? "LEAD", role: "SALESPERSON", dueAt: new Date(dueAt).toISOString(),
    escalationAt: followUpDeadline(dueAt, 1, holidays), sourceAt, status: "OPEN", version: 1 }, holidays);
}
export async function saveTask(input: { accountId: string; id?: string; title: string; kind: TaskKind; role: Responsibility; dueAt: string; version?: number; reason: string }, actor: string) {
  void input; void actor;
  throw new Error("Routine work is scheduled automatically. Use the account, quote or policy workflow for business changes.");
}

export async function completeTask(input: { id: string; version: number; reason?: string; successor?: { title: string; dueAt: string; role: Responsibility; kind: TaskKind }; outcome?: "LOST" | "DISQUALIFIED" }, actor: string) {
  void input; void actor;
  throw new Error("Complete the actual email, call, quote or policy work; progress is recorded automatically.");
}

/** Business decisions remain explicit; routine communication needs no second entry. */
export async function setLeadDisposition(accountId: string, disposition: string, version: number, actor: string) {
  const wf = await ensureWorkflow(accountId); expected(wf, version);
  if (!["ACTIVE", "LOST", "DISQUALIFIED"].includes(disposition) || wf.data.disposition === "BOUND") throw new Error("Use the existing quote/bind workflow for a bound lead");
  if (wf.data.disposition === disposition) return;
  const account = await (await dataClient()).models.Account.get({ id: accountId });
  if (account.errors?.length || !account.data || account.data.stage === "CLIENT") throw new Error("This lead's status could not be changed");
  const writes = [put(row("WORKFLOW", wf.id, { ...wf.data, disposition: disposition as LeadWorkflow["disposition"], humanTakeover: true, version: wf.version + 1 }, { accountId, previous: wf }), wf), audit(accountId, actor, "Lead status changed", { disposition })];
  if (disposition === "ACTIVE") {
    const task = await makeTask({ accountId, title: "Follow up with prospect", kind: "FOLLOW_UP", conversationId: wf.data.conversationId });
    writes.push(put(row("TASK", task.id, task, { accountId, dueAt: taskWakeAt(task) })));
  } else writes.push(put(row("LIFECYCLE", `lifecycle:${wf.id}:${wf.version}`, { accountId }, { accountId, dueAt: new Date().toISOString() })));
  await commit(writes);
}
export async function recordInbound(comm: Communication, kind: TaskKind = "RESPONSE") {
  if (comm.accountId && await get(`deleted-account:${comm.accountId}`)) return;
  if (!comm.accountId) return;
  const projection = await get<Communication>(comm.id);
  if (projection?.data.resolved) return;
  const serviceWorkflow = await ensureWorkflow(comm.accountId);
  if ((comm.context ?? (serviceWorkflow.data.disposition === "BOUND" && !serviceWorkflow.data.openLeadQuoteIds?.length ? "SERVICE" : "LEAD")) === "SERVICE" && comm.purpose !== "CARRIER" && comm.classification !== "AUTOMATIC") {
    const key = `task:service:${comm.id}`;
    if (!await get(key)) {
      const { serviceRequestType } = await import("../../../../shared/serviceEvidence");
      const task = await makeTask({ id: key, accountId: comm.accountId, title: "Deliver the requested client service", kind: "SERVICE", role: "SALESPERSON", context: "SERVICE", domain: "CLIENT", sourceAt: comm.at, conversationId: comm.conversationId, milestone: true });
      task.sourceIds = [comm.id]; task.serviceType = serviceRequestType(comm);
      await commit([check(serviceWorkflow), put(row("TASK", key, task, { accountId: comm.accountId, dueAt: taskWakeAt(task) }))]);
    }
  }
  if (projection?.data.workflowApplied) { const { repairContactWork } = await import("./contactProgress"); await repairContactWork(comm.accountId, comm); return; }
  const wf = await ensureWorkflow(comm.accountId);
  if (["LOST", "DISQUALIFIED"].includes(wf.data.disposition)) return;
  const context = comm.context ?? (wf.data.disposition === "BOUND" && !wf.data.openLeadQuoteIds?.length ? "SERVICE" : "LEAD");
  const role = "SALESPERSON";
  const { contactFence, accountContactPairs } = await import("./contactProgress");
  const fence = await contactFence(comm.accountId);
  const contactPairs = await accountContactPairs(comm.accountId);
  const tasks = await accountRows<LeadTask>(comm.accountId, "TASK");
  let key = `task:${kind === "CARRIER" ? "carrier" : "response"}:${comm.accountId}:${comm.conversationId ?? comm.providerId}`;
  const alias = await get<{ targetId: string }>(`task-alias:${key}`);
  if (alias && (await get<LeadTask>(alias.data.targetId))?.data.status === "OPEN") key = alias.data.targetId;
  const old = await get<LeadTask>(key);
  const newTask = await makeTask({ id: key, accountId: comm.accountId, kind, role, domain: kind === "CARRIER" ? "CARRIER" : "CLIENT", context, title: kind === "CARRIER" ? "Respond to carrier" : kind === "CALLBACK" ? "Return the call" : context === "LEAD" ? "Respond to prospect" : "Respond to client", sourceAt: comm.at, episode: comm.id, conversationId: comm.conversationId });
  newTask.sourceIds = Array.from(new Set([...(old?.data.status === "OPEN" ? old.data.sourceIds ?? [] : []), comm.id]));
  // Keep transaction size bounded without silently discarding source activity.
  if (newTask.sourceIds.length > 80) throw new Error("This unanswered conversation needs review before more messages can be grouped");
  const incomingDue = newTask.dueAt, incomingEscalation = newTask.escalationAt;
  if (old?.data.status === "OPEN") { Object.assign(newTask, { ...salespersonTask(old.data), sourceIds: newTask.sourceIds }); newTask.dueAt = old.data.custom || old.data.dueAt < incomingDue ? old.data.dueAt : incomingDue; newTask.escalationAt = old.data.custom || old.data.escalationAt < incomingEscalation ? old.data.escalationAt : incomingEscalation; newTask.notifiedAt = old.data.notifiedAt; newTask.escalatedAt = old.data.escalatedAt; }
  if (old?.data.sourceAt && old.data.sourceAt < newTask.sourceAt!) newTask.sourceAt = old.data.sourceAt;
  else if (comm.at < newTask.sourceAt!) newTask.sourceAt = comm.at;
  Object.assign(newTask, scheduleReminders(newTask, (await config()).holidays));
  newTask.version = (old?.version ?? 0) + 1;
  const writes: Write[] = [check(wf), put(row("CONTACT_FENCE", fence.id, {}, { previous: fence }), fence), put(row("TASK", key, newTask, { accountId: comm.accountId, dueAt: taskWakeAt(newTask), previous: old }), old)];
  if (projection) writes.push(put(row("COMMUNICATION", projection.id, { ...projection.data, workflowApplied: true }, { accountId: comm.accountId, previous: projection }), projection));
  for (const task of tasks.filter(t => (t.data.domain ?? (t.data.role === "CHAMPION" ? "CARRIER" : "CLIENT")) === (kind === "CARRIER" ? "CARRIER" : "CLIENT") && (t.data.context ?? "LEAD") === context && t.data.status === "OPEN" && t.data.kind === "FOLLOW_UP" && !t.data.custom && (t.data.sourceAt ?? t.createdAt) <= comm.at).slice(0, 90)) {
    let matches = !!comm.conversationId && task.data.conversationId === comm.conversationId;
    if (!matches) for (const id of task.data.sourceIds ?? []) {
      const source = await get<Communication>(id);
      if (source?.accountId === comm.accountId && sameContact(comm, source.data, contactPairs)) matches = true;
    }
    if (!matches) continue;
    writes.push(put(row("TASK", task.id, { ...task.data, status: "CANCELLED", reason: "Prospect responded", version: task.version + 1 }, { accountId: task.accountId, previous: task }), task));
  }
  if (comm.conversationId) {
    const reopenId = `op:inbound:${comm.id}`, existing = await get<import("./operations").Operation>(reopenId);
    if (!existing) writes.push(put(operationRow(reopenId, { type: "REOPEN", accountId: comm.accountId, conversationId: comm.conversationId })));
    else if (comm.resolvedByCommunicationId && ["CONFIRMED", "SUPPRESSED"].includes(existing.data.state)) {
      writes.push(put(row("OPERATION", reopenId, { ...existing.data, state: "READY", error: undefined, attempts: 0 }, { accountId: comm.accountId, previous: existing, dueAt: new Date().toISOString() }), existing));
    }
  }
  await commit(writes);
  const { repairContactWork } = await import("./contactProgress");
  await repairContactWork(comm.accountId, comm);
}
/** Email, text and completed calls are their own completion evidence. */
export async function recordOutbound(comm: Communication, repair = false) {
  if (comm.accountId && await get(`deleted-account:${comm.accountId}`)) return;
  const { applyContactProgress } = await import("./contactProgress");
  await applyContactProgress(comm, repair);
}

/** Binding remains controlled by the existing CRM bind flow. */
export async function syncAccountLifecycle(accountId: string) {
  if (await get(`deleted-account:${accountId}`)) return;
  let wf = await ensureWorkflow(accountId);
  const account = await (await dataClient()).models.Account.get({ id: accountId });
  if (account.errors?.length || !account.data) throw new Error("Could not verify account lifecycle");
  const disposition = account.data.stage === "CLIENT" ? "BOUND" : wf.data.disposition;
  if (disposition !== wf.data.disposition || account.data.name !== wf.data.name) {
    wf = await save(row("WORKFLOW", wf.id, { ...wf.data, name: account.data.name, disposition, version: wf.version + 1 }, { accountId, previous: wf }), wf);
  }
  const { reconcileAccountWork } = await import("./coverage");
  await reconcileAccountWork(account.data, wf);
  const current = await get<LeadWorkflow>(wf.id);
  if (current?.data.disposition === "BOUND" && !current.data.openLeadQuoteIds?.length && current.data.conversationId) {
    const id = `op:closed-cleanup:${accountId}`;
    if (!await get(id)) await save(operationRow(id, { type: "ARCHIVE", accountId, conversationId: current.data.conversationId }));
  }
}

/** Explicitly combine cross-channel contacts about the same unanswered request. */
export async function mergeTasks(input: { accountId: string; tasks: { id: string; version: number }[]; reason: string }, actor: string) {
  if (!Array.isArray(input.tasks) || input.tasks.length < 2 || input.tasks.length > 10 || !input.reason?.trim()) throw new Error("Select two to ten requests and explain why they are the same request");
  if (new Set(input.tasks.map(t => t.id)).size !== input.tasks.length) throw new Error("Select each request once");
  const wf = await ensureWorkflow(input.accountId), selected = [];
  for (const ref of input.tasks) {
    const task = await get<LeadTask>(ref.id);
    if (!task || task.accountId !== input.accountId || task.data.status !== "OPEN" || !["RESPONSE", "CALLBACK"].includes(task.data.kind) || (task.data.domain ?? "CLIENT") !== "CLIENT" || (task.data.context ?? "LEAD") !== "LEAD") throw new Error("Only open prospect response/callback requests can be combined");
    expected(task, ref.version); selected.push(task);
  }
  const [target, ...others] = selected, sourceIds = [...new Set(selected.flatMap(t => t.data.sourceIds ?? []))];
  if (sourceIds.length > 80) throw new Error("Resolve some activity before combining more requests");
  const dueAt = selected.map(t => t.data.dueAt).sort()[0], escalationAt = selected.map(t => t.data.escalationAt).sort()[0];
  const data = { ...target.data, sourceIds, dueAt, escalationAt, sourceAt: selected.map(t => t.data.sourceAt ?? t.createdAt).sort()[0], version: target.version + 1,
    title: "Respond to prospect / return call", kind: selected.some(t => t.data.kind === "CALLBACK") ? "CALLBACK" as const : "RESPONSE" as const,
    custom: selected.some(t => t.data.custom), notifiedAt: selected.map(t => t.data.notifiedAt).filter(Boolean).sort()[0], escalatedAt: selected.map(t => t.data.escalatedAt).filter(Boolean).sort()[0] };
  Object.assign(data, scheduleReminders(data, (await config()).holidays));
  const writes = [check(wf), put(row("TASK", target.id, data, { accountId: input.accountId, previous: target, dueAt: taskWakeAt(data) }), target), audit(input.accountId, actor, "Requests combined; earliest commitment preserved", input)];
  for (const old of others) {
    const alias = await get(`task-alias:${old.id}`);
    writes.push(put(row("TASK", old.id, { ...old.data, status: "CANCELLED", reason: `Combined with ${target.id}: ${input.reason}`, version: old.version + 1 }, { accountId: input.accountId, previous: old }), old), put(row("TASK_ALIAS", `task-alias:${old.id}`, { targetId: target.id }, { accountId: input.accountId, previous: alias }), alias));
  }
  await commit(writes);
}
