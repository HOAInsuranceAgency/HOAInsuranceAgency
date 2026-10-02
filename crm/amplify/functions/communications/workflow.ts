import { salespersonEligibility, salespersonWorkflow } from "../../../../shared/salespersonOwnership";
import { CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { type LeadWorkflow, type LeadTask, type TeamEligibility, type TaskKind, type Responsibility, type Communication } from "../../../../shared/leadWorkflow";
import { get, row, put, commit, query, audit, save, conflict, check, absent, type Row, type Write } from "./store";
import { config } from "./config";
import { operationRow } from "./outbox";
import { dataClient } from "./data";
import { tasksRemoved } from "./retiredTasks";

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
    const job = row("ROLE_SYNC", `role-sync:ownership:${accountId}`, { phase: "LINK", accountId }, { accountId, dueAt: new Date().toISOString() });
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
  const current = await get<LeadWorkflow>(`workflow:${accountId}`);
  if (!Number.isInteger(version) || version !== (current?.version ?? 0)) throw new Error("This record changed. Refresh before saving.");
  const old = current ? await ensureWorkflow(accountId) : undefined;
  if (old) expected(old, version);
  await validRole(salespersonId, "SALESPERSON");
  let data: LeadWorkflow;
  if (old) data = salespersonWorkflow(old.data);
  else {
    const account = await (await dataClient()).models.Account.get({ id: accountId });
    if (!account.data || account.errors?.length) throw new Error("The account could not be loaded");
    if (await get(`deleted-account:${accountId}`)) throw new Error("This account is being deleted");
    // Assign the requested owner in the first write. Initializing with the
    // configured default first would briefly grant the wrong person access.
    data = { accountId, name: account.data.name, disposition: account.data.stage === "CLIENT" ? "BOUND" : "ACTIVE", ownershipModel: "SALESPERSON", version: 1, updatedAt: new Date().toISOString() };
  }
  const next = row("WORKFLOW", `workflow:${accountId}`, { ...data, salespersonId, assignmentIssue: undefined, version: (old?.version ?? 0) + 1, updatedAt: new Date().toISOString() }, { accountId, previous: old });
  const job = row("ROLE_SYNC", `role-sync:${accountId}:${next.version}`, { phase: "LINK", accountId }, { accountId, dueAt: new Date().toISOString() });
  await commit([put(next, old), ...(!old ? [absent(`deleted-account:${accountId}`)] : []), put(job), audit(accountId, actor, "Salesperson changed", { salespersonId })]);
  await syncResponsibilities(job).catch(() => {}); // Durable job retries a failed first page.
  return next.data;
}
export async function syncResponsibilities(candidate: Row<{ phase: string; accountId: string; cursor?: string }>) {
  const job = await get<typeof candidate.data>(candidate.id); if (!job?.dueAt) return;
  const { accountId } = job.data;
  // Old TASK/NOTIFICATION phases restart at links; historical tasks stay untouched.
  const phase = "LINK", cursor = job.data.phase === "LINK" ? job.data.cursor : undefined;
  if (await get(`deleted-account:${accountId}`)) {
    await save(row("ROLE_SYNC", job.id, job.data, { accountId, previous: job }), job); return;
  }
  const wf = await ensureWorkflow(accountId), { salespersonId } = wf.data;
  const page = await query<Record<string, unknown>>("account", accountId, cursor, 25, `${phase}#`);
  const writes: Write[] = [check(wf)];
  if (phase === "LINK") for (const item of page.items) {
    const link = item as unknown as Row<{ conversationId: string; routing?: string }>;
    if (link.data.routing === "MANUAL") continue;
    if (link.data.routing !== "SALESPERSON") writes.push(put(row("LINK", link.id, { ...link.data, routing: "SALESPERSON" }, { accountId, previous: link }), link));
    const member = salespersonId ? await get<TeamEligibility>(`eligibility:${salespersonId}`) : undefined;
    const key = `op:route:${job.id}:${link.id}`;
    if (member?.data.enabled && member.data.salesperson && member.data.frontId && !await get(key)) writes.push(put(operationRow(key, { type: "ASSIGN", accountId, conversationId: link.data.conversationId, assigneeId: member.data.frontId })));
  }
  writes.push(put(row("ROLE_SYNC", job.id, { ...job.data, phase: "LINK", cursor: page.nextToken }, { accountId, previous: job, dueAt: page.nextToken ? new Date().toISOString() : undefined }), job));
  await commit(writes);
}
export async function makeTask(input: { accountId: string; title: string; kind: TaskKind; role?: Responsibility; dueAt?: string; sourceAt?: string; episode?: string; conversationId?: string; custom?: boolean; id?: string; domain?: LeadTask["domain"]; context?: LeadTask["context"]; term?: string; policyId?: string; quoteId?: string; milestone?: boolean; obligationKey?: string; lines?: string[]; marketingTaskId?: string; carrierId?: string; waitingOn?: LeadTask["waitingOn"]; businessDueAt?: string; shortTimeline?: boolean }): Promise<LeadTask> {
  void input;
  return tasksRemoved();
}
export async function saveTask(input: { accountId: string; id?: string; title: string; kind: TaskKind; role: Responsibility; dueAt: string; version?: number; reason: string }, actor: string) {
  void input; void actor;
  return tasksRemoved();
}

export async function completeTask(input: { id: string; version: number; reason?: string; successor?: { title: string; dueAt: string; role: Responsibility; kind: TaskKind }; outcome?: "LOST" | "DISQUALIFIED" }, actor: string) {
  void input; void actor;
  return tasksRemoved();
}

/** Business decisions remain explicit; routine communication needs no second entry. */
export async function setLeadDisposition(accountId: string, disposition: string, version: number, actor: string) {
  const wf = await ensureWorkflow(accountId); expected(wf, version);
  if (!["ACTIVE", "LOST", "DISQUALIFIED"].includes(disposition) || wf.data.disposition === "BOUND") throw new Error("Use the existing quote/bind workflow for a bound lead");
  if (wf.data.disposition === disposition) return;
  const account = await (await dataClient()).models.Account.get({ id: accountId });
  if (account.errors?.length || !account.data || account.data.stage === "CLIENT") throw new Error("This lead's status could not be changed");
  const writes = [put(row("WORKFLOW", wf.id, { ...wf.data, disposition: disposition as LeadWorkflow["disposition"], humanTakeover: true, version: wf.version + 1 }, { accountId, previous: wf }), wf), audit(accountId, actor, "Lead status changed", { disposition })];
  await commit(writes);
}
/** Preserve incoming correspondence and its real Front reopen event, without tasks. */
export async function recordInbound(comm: Communication, kind: TaskKind = "RESPONSE") {
  void kind;
  if (!comm.accountId || await get(`deleted-account:${comm.accountId}`)) return;
  const projection = await get<Communication>(comm.id);
  if (!projection || projection.data.resolved) return;
  const wf = await ensureWorkflow(comm.accountId);
  const { repairContactWork, contactFence } = await import("./contactProgress");
  if (projection.data.workflowApplied) { await repairContactWork(comm.accountId, comm); return; }
  const fence = await contactFence(comm.accountId);
  const writes: Write[] = [check(wf), put(row("CONTACT_FENCE", fence.id, {}, { previous: fence }), fence), put(row("COMMUNICATION", projection.id, { ...projection.data, workflowApplied: true }, { accountId: comm.accountId, previous: projection, dueAt: projection.dueAt }), projection)];
  if (comm.conversationId && !["LOST", "DISQUALIFIED"].includes(wf.data.disposition)) {
    const reopenId = `op:inbound:${comm.id}`, existing = await get<import("./operations").Operation>(reopenId);
    if (!existing) writes.push(put(operationRow(reopenId, { type: "REOPEN", accountId: comm.accountId, conversationId: comm.conversationId })));
    else if (comm.resolvedByCommunicationId && ["CONFIRMED", "SUPPRESSED"].includes(existing.data.state)) writes.push(put(row("OPERATION", reopenId, { ...existing.data, state: "READY", error: undefined, attempts: 0 }, { accountId: comm.accountId, previous: existing, dueAt: new Date().toISOString() }), existing));
  }
  await commit(writes);
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
  void input; void actor;
  return tasksRemoved();
}
