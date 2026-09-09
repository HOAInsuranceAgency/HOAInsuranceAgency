import { randomUUID } from "node:crypto";
import { CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { businessDeadline, followUpDeadline, type LeadWorkflow, type LeadTask, type TeamEligibility, type TaskKind, type Responsibility, type Communication } from "../../../../shared/leadWorkflow";
import { get, row, put, commit, query, audit, save, conflict, check, type Row, type Write } from "./store";
import { config } from "./config";
import { operationRow } from "./outbox";
import { dataClient } from "./data";

const cognito = new CognitoIdentityProviderClient();
export async function enabledUser(userId: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(userId)) throw new Error("Invalid teammate identity");
  const out = await cognito.send(new ListUsersCommand({ UserPoolId: process.env.USER_POOL_ID, Filter: `sub = "${userId}"`, Limit: 1 }));
  if (!out.Users?.[0]?.Enabled) throw new Error("This teammate is disabled or no longer available");
}
export async function team() {
  const out: TeamEligibility[] = [];
  let cursor: string | undefined;
  do { const page = await query<TeamEligibility>("kind", "ELIGIBILITY", cursor); out.push(...page.items.map(r => ({ ...r.data, version: r.version }))); cursor = page.nextToken; } while (cursor);
  return out;
}
export async function validRole(userId: string, role: Responsibility, checkEnabled = true) {
  const member = await get<TeamEligibility>(`eligibility:${userId}`);
  if (!member?.data.enabled || !(role === "SALESPERSON" ? member.data.salesperson : member.data.champion)) throw new Error("Choose an enabled teammate eligible for this responsibility");
  if (checkEnabled) await enabledUser(userId);
  return member.data;
}
export async function defaultWorkflow(accountId: string, name: string): Promise<LeadWorkflow> {
  const c = await config();
  let assignmentIssue: string | undefined;
  try {
    if (!c.defaultUserId) throw new Error("Set Brian Cole as the default teammate in Integration settings");
    await validRole(c.defaultUserId, "SALESPERSON"); await validRole(c.defaultUserId, "CHAMPION", false);
  } catch (e) { assignmentIssue = e instanceof Error ? e.message : "Default assignment needs attention"; }
  return { accountId, name, salespersonId: assignmentIssue ? undefined : c.defaultUserId, championId: assignmentIssue ? undefined : c.defaultUserId,
    assignmentIssue, disposition: "ACTIVE", version: 1, updatedAt: new Date().toISOString() };
}
export async function ensureWorkflow(accountId: string): Promise<Row<LeadWorkflow>> {
  const old = await get<LeadWorkflow>(`workflow:${accountId}`);
  if (old) return old;
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
export async function setResponsibilities(accountId: string, salespersonId: string, championId: string, version: number, actor: string) {
  const old = await ensureWorkflow(accountId); expected(old, version);
  await Promise.all([
    salespersonId !== old.data.salespersonId ? validRole(salespersonId, "SALESPERSON") : enabledUser(salespersonId),
    championId !== old.data.championId ? validRole(championId, "CHAMPION") : enabledUser(championId),
  ]);
  const next = row("WORKFLOW", old.id, { ...old.data, salespersonId, championId, assignmentIssue: undefined, version: old.version + 1, updatedAt: new Date().toISOString() }, { accountId, previous: old });
  const job = row("ROLE_SYNC", `role-sync:${accountId}:${next.version}`, { phase: "TASK", accountId }, { accountId, dueAt: new Date().toISOString() });
  await commit([put(next, old), put(job), audit(accountId, actor, "Responsibilities changed", { salespersonId, championId })]);
  await syncResponsibilities(job).catch(() => {}); // Durable job retries a failed first page.
  return next.data;
}
export async function syncResponsibilities(candidate: Row<{ phase: string; accountId: string; cursor?: string }>) {
  const job = await get<typeof candidate.data>(candidate.id); if (!job?.dueAt) return;
  const { accountId, phase } = job.data;
  const wf = await ensureWorkflow(accountId), { salespersonId, championId } = wf.data;
  const page = await query<Record<string, unknown>>("account", accountId, job.data.cursor, 25, `${phase}#`);
  const writes: Write[] = [check(wf)];
  if (phase === "LINK") for (const item of page.items) {
    const link = item as unknown as Row<{ conversationId: string; routing?: string }>;
    if (!["SALESPERSON", "CHAMPION"].includes(link.data.routing ?? "")) continue;
    const member = await get<TeamEligibility>(`eligibility:${link.data.routing === "CHAMPION" ? championId : salespersonId}`);
    const key = `op:route:${job.id}:${link.id}`;
    if (member?.data.frontId && !await get(key)) writes.push(put(operationRow(key, { type: "ASSIGN", accountId, conversationId: link.data.conversationId, assigneeId: member.data.frontId })));
  }
  if (phase === "TASK") for (const item of page.items) {
    const task = item as unknown as Row<LeadTask>;
    if (task.data.status !== "OPEN" || task.data.dueAt > new Date().toISOString()) continue;
    const direct = task.data.role === "CHAMPION" ? championId : salespersonId;
    const directChanged = !!task.data.notifiedAt && task.data.notifiedRecipientId !== direct;
    const escalationChanged = !!task.data.escalatedAt && task.data.escalatedRecipientId !== championId;
    if (!directChanged && !escalationChanged) continue;
    const data = { ...task.data, notifiedAt: directChanged ? undefined : task.data.notifiedAt, escalatedAt: undefined, version: task.version + 1 };
    writes.push(put(row("TASK", task.id, data, { accountId, previous: task, dueAt: data.notifiedAt ? data.escalationAt : data.dueAt }), task));
  }
  const done = phase === "LINK" && !page.nextToken;
  writes.push(put(row("ROLE_SYNC", job.id, { ...job.data, phase: page.nextToken ? phase : "LINK", cursor: page.nextToken }, { accountId, previous: job, dueAt: done ? undefined : new Date().toISOString() }), job));
  await commit(writes);
}
export async function makeTask(input: { accountId: string; title: string; kind: TaskKind; role?: Responsibility; dueAt?: string; sourceAt?: string; episode?: string; conversationId?: string; custom?: boolean; id?: string }): Promise<LeadTask> {
  if (!input.title?.trim() || input.title.length > 500 || !["FOLLOW_UP", "RESPONSE", "CALLBACK", "CARRIER", "DOCUMENTS", "CORRECTION", "TRIAGE"].includes(input.kind) || input.role && !["SALESPERSON", "CHAMPION"].includes(input.role)) throw new Error("Invalid next action or responsible role");
  const holidays = (await config()).holidays;
  const sourceAt = input.sourceAt ?? new Date().toISOString();
  const dueAt = input.dueAt ?? (input.kind === "FOLLOW_UP" ? followUpDeadline(sourceAt, 2, holidays) : businessDeadline(sourceAt, 1, holidays));
  if (!Number.isFinite(Date.parse(dueAt))) throw new Error("Choose a valid due date");
  if (input.custom && Date.parse(dueAt) <= Date.now()) throw new Error("Choose a future date for a new promise");
  return { ...input, id: input.id ?? `task:${randomUUID()}`, role: input.role ?? "SALESPERSON", dueAt: new Date(dueAt).toISOString(),
    escalationAt: input.kind === "FOLLOW_UP" && !input.custom && !input.dueAt ? followUpDeadline(dueAt, 1, holidays) : businessDeadline(dueAt, 1, holidays), sourceAt, status: "OPEN", version: 1 };
}
export async function saveTask(input: { accountId: string; id?: string; title: string; kind: TaskKind; role: Responsibility; dueAt: string; version?: number; reason: string }, actor: string) {
  if (!input.title?.trim() || !input.reason?.trim()) throw new Error("A next action and a reason are required");
  if (!["FOLLOW_UP", "RESPONSE", "CALLBACK", "CARRIER", "DOCUMENTS", "CORRECTION", "TRIAGE"].includes(input.kind) || !["SALESPERSON", "CHAMPION"].includes(input.role)) throw new Error("Invalid action type or responsibility");
  const workflow = await ensureWorkflow(input.accountId);
  if (workflow.data.disposition !== "ACTIVE") throw new Error("Reopen this lead before adding follow-up work");
  const old = input.id ? await get<LeadTask>(input.id) : undefined;
  if (input.id && (!old || old.kind !== "TASK" || old.accountId !== input.accountId)) throw new Error("Task not found");
  if (old) { expected(old, input.version); if (old.data.status !== "OPEN") throw new Error("This task is already closed"); }
  const data = await makeTask({ ...old?.data, ...input, id: old?.id, custom: true });
  data.notifiedAt = undefined; data.escalatedAt = undefined;
  data.version = (old?.version ?? 0) + 1;
  const next = row("TASK", data.id, data, { accountId: input.accountId, dueAt: data.dueAt, previous: old });
  await commit([check(workflow), put(next, old), audit(input.accountId, actor, "Next action saved", { before: old?.data, after: data, reason: input.reason })]);
  return data;
}
export async function completeTask(input: { id: string; version: number; reason: string; successor?: { title: string; dueAt: string; role: Responsibility; kind: TaskKind }; outcome?: "LOST" | "DISQUALIFIED" }, actor: string) {
  const old = await get<LeadTask>(input.id);
  if (!old || old.kind !== "TASK") throw new Error("Task not found");
  expected(old, input.version);
  if (old.data.status !== "OPEN" || !input.reason?.trim()) throw new Error("An open task and completion reason are required");
  const wf = await ensureWorkflow(old.data.accountId);
  if (old.data.role === "SALESPERSON" && wf.data.disposition === "ACTIVE" && !input.successor && !input.outcome) throw new Error("Record the next action or the lead outcome before completing this task");
  const writes: Write[] = [put(row("TASK", old.id, { ...old.data, status: "COMPLETE", reason: input.reason, version: old.version + 1 }, { accountId: old.accountId, previous: old }), old)];
  if (input.successor && input.outcome) throw new Error("Choose a next action or a terminal outcome");
  if (input.successor) {
    if (!input.successor.title.trim()) throw new Error("Next action is required");
    const task = await makeTask({ ...input.successor, accountId: old.data.accountId, custom: true });
    writes.push(put(row("TASK", task.id, task, { accountId: task.accountId, dueAt: task.dueAt })));
  }
  if (input.outcome) {
    if (!["LOST", "DISQUALIFIED"].includes(input.outcome)) throw new Error("Use the existing quote/bind workflow to bind a lead");
    writes.push(put(row("WORKFLOW", wf.id, { ...wf.data, disposition: input.outcome, version: wf.version + 1 }, { accountId: wf.accountId, previous: wf }), wf));
    writes.push(put(row("LIFECYCLE", `lifecycle:${wf.id}:${wf.version}`, { accountId: wf.data.accountId }, { accountId: wf.accountId, dueAt: new Date().toISOString() })));
  }
  if (!input.outcome) writes.push(check(wf));
  // Resolve the specific source episode only. Independent requests stay open.
  for (const sourceId of old.data.sourceIds ?? (old.data.episode ? [old.data.episode] : [])) {
    const comm = await get<Communication>(sourceId);
    if (comm && comm.accountId === old.accountId) writes.push(put(row("COMMUNICATION", comm.id, { ...comm.data, resolved: true }, { accountId: comm.accountId, previous: comm }), comm));
  }
  // Notification reads retire closed episodes; former-assignee history must
  // not make this bounded completion transaction exceed DynamoDB's limit.
  writes.push(audit(old.data.accountId, actor, "Task completed", input));
  await commit(writes);
}
export async function recordInbound(comm: Communication, kind: TaskKind = "RESPONSE") {
  if (!comm.accountId) return;
  const projection = await get<Communication>(comm.id);
  if (projection?.data.workflowApplied || projection?.data.resolved) return;
  const wf = await ensureWorkflow(comm.accountId);
  if (wf.data.disposition !== "ACTIVE") return;
  const tasks = await accountRows<LeadTask>(comm.accountId, "TASK");
  let key = `task:${kind === "CARRIER" ? "carrier" : "response"}:${comm.accountId}:${comm.conversationId ?? comm.providerId}`;
  const alias = await get<{ targetId: string }>(`task-alias:${key}`);
  if (alias && (await get<LeadTask>(alias.data.targetId))?.data.status === "OPEN") key = alias.data.targetId;
  const old = await get<LeadTask>(key);
  const newTask = await makeTask({ id: key, accountId: comm.accountId, kind, role: kind === "CARRIER" ? "CHAMPION" : "SALESPERSON", title: kind === "CARRIER" ? "Respond to carrier" : kind === "CALLBACK" ? "Return prospect call" : "Respond to prospect", sourceAt: comm.at, episode: comm.id, conversationId: comm.conversationId });
  newTask.sourceIds = Array.from(new Set([...(old?.data.status === "OPEN" ? old.data.sourceIds ?? [] : []), comm.id]));
  // Keep transaction size bounded without silently discarding source activity.
  if (newTask.sourceIds.length > 80) throw new Error("This unanswered conversation needs review before more messages can be grouped");
  const incomingDue = newTask.dueAt, incomingEscalation = newTask.escalationAt;
  if (old?.data.status === "OPEN") { Object.assign(newTask, { ...old.data, sourceIds: newTask.sourceIds }); newTask.dueAt = old.data.custom || old.data.dueAt < incomingDue ? old.data.dueAt : incomingDue; newTask.escalationAt = old.data.custom || old.data.escalationAt < incomingEscalation ? old.data.escalationAt : incomingEscalation; newTask.notifiedAt = old.data.notifiedAt; newTask.escalatedAt = old.data.escalatedAt; }
  if (old?.data.sourceAt && old.data.sourceAt < newTask.sourceAt!) newTask.sourceAt = old.data.sourceAt;
  else if (comm.at < newTask.sourceAt!) newTask.sourceAt = comm.at;
  newTask.version = (old?.version ?? 0) + 1;
  const writes: Write[] = [check(wf), put(row("TASK", key, newTask, { accountId: comm.accountId, dueAt: newTask.escalatedAt ? undefined : newTask.notifiedAt ? newTask.escalationAt : newTask.dueAt, previous: old }), old)];
  if (projection) writes.push(put(row("COMMUNICATION", projection.id, { ...projection.data, workflowApplied: true }, { accountId: comm.accountId, previous: projection }), projection));
  for (const task of tasks.filter(t => kind !== "CARRIER" && t.data.status === "OPEN" && t.data.kind === "FOLLOW_UP" && !t.data.custom && t.data.conversationId === comm.conversationId).slice(0, 90)) {
    writes.push(put(row("TASK", task.id, { ...task.data, status: "CANCELLED", reason: "Prospect responded", version: task.version + 1 }, { accountId: task.accountId, previous: task }), task));
  }
  if (comm.conversationId) writes.push(put(operationRow(`op:inbound:${comm.id}`, { type: "REOPEN", accountId: comm.accountId, conversationId: comm.conversationId })));
  await commit(writes);
}
export async function recordOutbound(comm: Communication) {
  if (!comm.accountId || comm.channel !== "EMAIL") return;
  const projection = await get<Communication>(comm.id);
  if (projection?.data.workflowApplied) return;
  const wf = await ensureWorkflow(comm.accountId);
  if (wf.data.disposition !== "ACTIVE") return;
  const tasks = await accountRows<LeadTask>(comm.accountId, "TASK");
  // Native sends cannot establish which of several unanswered requests was resolved.
  if (tasks.some(t => t.data.status === "OPEN" && (["RESPONSE", "CALLBACK"].includes(t.data.kind) || t.data.custom))) {
    if (projection) await save(row("COMMUNICATION", projection.id, { ...projection.data, workflowApplied: true }, { accountId: comm.accountId, previous: projection, dueAt: projection.dueAt }), projection);
    return;
  }
  const id = `task:wait:${comm.accountId}:${comm.conversationId ?? comm.providerId}`;
  const old = await get<LeadTask>(id);
  if (old?.data.sourceAt && old.data.sourceAt >= comm.at) return;
  const task = await makeTask({ id, accountId: comm.accountId, title: "Follow up with prospect", kind: "FOLLOW_UP", sourceAt: comm.at, conversationId: comm.conversationId });
  task.version = (old?.version ?? 0) + 1;
  const writes = [check(wf), put(row("TASK", id, task, { accountId: comm.accountId, dueAt: task.dueAt, previous: old }), old)];
  if (projection) writes.push(put(row("COMMUNICATION", projection.id, { ...projection.data, workflowApplied: true }, { accountId: comm.accountId, previous: projection, dueAt: projection.dueAt }), projection));
  if (comm.conversationId) writes.push(put(operationRow(`op:cleanup:${comm.id}`, { type: "ARCHIVE", accountId: comm.accountId, conversationId: comm.conversationId })));
  await commit(writes);
}

/** Binding remains controlled by the existing CRM bind flow. */
export async function syncAccountLifecycle(accountId: string) {
  let wf = await ensureWorkflow(accountId);
  const account = await (await dataClient()).models.Account.get({ id: accountId });
  if (account.errors?.length || !account.data) throw new Error("Could not verify account lifecycle");
  const disposition = account.data.stage === "CLIENT" ? "BOUND" : wf.data.disposition;
  if (disposition !== wf.data.disposition || account.data.name !== wf.data.name) {
    wf = await save(row("WORKFLOW", wf.id, { ...wf.data, name: account.data.name, disposition, version: wf.version + 1 }, { accountId, previous: wf }), wf);
  }
  if (wf.data.disposition !== "ACTIVE") {
    const tasks = (await accountRows<LeadTask>(accountId, "TASK")).filter(t => t.data.status === "OPEN");
    for (let i = 0; i < tasks.length; i += 90) await commit(tasks.slice(i, i + 90).map(t => put(row("TASK", t.id, { ...t.data, status: "CANCELLED", reason: "Lead is no longer active", version: t.version + 1 }, { accountId, previous: t }), t)));
  }
}

/** Explicitly combine cross-channel contacts about the same unanswered request. */
export async function mergeTasks(input: { accountId: string; tasks: { id: string; version: number }[]; reason: string }, actor: string) {
  if (!Array.isArray(input.tasks) || input.tasks.length < 2 || input.tasks.length > 10 || !input.reason?.trim()) throw new Error("Select two to ten requests and explain why they are the same request");
  if (new Set(input.tasks.map(t => t.id)).size !== input.tasks.length) throw new Error("Select each request once");
  const wf = await ensureWorkflow(input.accountId), selected = [];
  for (const ref of input.tasks) {
    const task = await get<LeadTask>(ref.id);
    if (!task || task.accountId !== input.accountId || task.data.status !== "OPEN" || !["RESPONSE", "CALLBACK"].includes(task.data.kind) || task.data.role !== "SALESPERSON") throw new Error("Only open prospect response/callback requests can be combined");
    expected(task, ref.version); selected.push(task);
  }
  const [target, ...others] = selected, sourceIds = [...new Set(selected.flatMap(t => t.data.sourceIds ?? []))];
  if (sourceIds.length > 80) throw new Error("Resolve some activity before combining more requests");
  const dueAt = selected.map(t => t.data.dueAt).sort()[0], escalationAt = selected.map(t => t.data.escalationAt).sort()[0];
  const data = { ...target.data, sourceIds, dueAt, escalationAt, sourceAt: selected.map(t => t.data.sourceAt ?? t.createdAt).sort()[0], version: target.version + 1,
    title: "Respond to prospect / return call", kind: selected.some(t => t.data.kind === "CALLBACK") ? "CALLBACK" as const : "RESPONSE" as const,
    custom: selected.some(t => t.data.custom), notifiedAt: selected.map(t => t.data.notifiedAt).filter(Boolean).sort()[0], escalatedAt: selected.map(t => t.data.escalatedAt).filter(Boolean).sort()[0] };
  const writes = [check(wf), put(row("TASK", target.id, data, { accountId: input.accountId, previous: target, dueAt: data.escalatedAt ? undefined : data.notifiedAt ? escalationAt : dueAt }), target), audit(input.accountId, actor, "Requests combined; earliest commitment preserved", input)];
  for (const old of others) {
    const alias = await get(`task-alias:${old.id}`);
    writes.push(put(row("TASK", old.id, { ...old.data, status: "CANCELLED", reason: `Combined with ${target.id}: ${input.reason}`, version: old.version + 1 }, { accountId: input.accountId, previous: old }), old), put(row("TASK_ALIAS", `task-alias:${old.id}`, { targetId: target.id }, { accountId: input.accountId, previous: alias }), alias));
  }
  await commit(writes);
}
