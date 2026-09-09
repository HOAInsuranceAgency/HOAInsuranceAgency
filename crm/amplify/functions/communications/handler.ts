import { historyStopped, restartHistory, type HistoryJob } from "./history";
import { reviewOperation, recordCallOutcome, linkActivity } from "./review";
import { archiveAllowed } from "./cleanup";
import { randomUUID } from "node:crypto";
import type { AppSyncIdentityCognito } from "aws-lambda";
import type { Communication, IntegrationConfig, LeadTask, LeadWorkflow, TeamEligibility } from "../../../../shared/leadWorkflow";
import { normalizePhone } from "../../../../shared/leadWorkflow";
import { get, row, query, save, put, commit, audit, conflict, retryableStorage, check } from "./store";
import { config, credentials, saveCredentials, saveConfig, type Credentials } from "./config";
import { dataClient } from "./data";
import { accountRows, defaultWorkflow, ensureWorkflow, expected, validRole, setResponsibilities, saveTask, completeTask, mergeTasks, team, enabledUser } from "./workflow";
import { permittedConversation, verifySmsChannel } from "./providers";
import { operationRow } from "./outbox";
import { connectionChecks, activationChecks } from "./setup";
import { enqueueOperation } from "./operations";
import { modelPut } from "../lead-intake/handler";
import type { ConversationLink } from "./events";

type Input = Record<string, unknown>;
function object(value: unknown): Input {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (parsed == null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid request");
  return parsed as Input;
}
const text = (input: Input, key: string, max = 500) => typeof input[key] === "string" ? (input[key] as string).trim().slice(0, max) : "";
function version(input: Input) { if (!Number.isInteger(input.version)) throw new Error("Refresh this record before saving"); return Number(input.version); }
async function roster() {
  const client = await dataClient(), eligibility = await team();
  const profiles = []; let nextToken: string | null | undefined;
  do { const p = await client.models.UserProfile.list({ nextToken, limit: 100 }); if (p.errors?.length) throw new Error("Could not load teammates"); profiles.push(...p.data); nextToken = p.nextToken; } while (nextToken);
  return profiles.map(p => eligibility.find(t => t.userId === p.userId) ?? { userId: p.userId, name: `${p.firstName} ${p.lastName}`, email: p.email, enabled: true, salesperson: false, champion: false, version: 0 });
}
function safeCommunication(data: Communication): Communication {
  return { ...data, text: data.text?.replace(/([?&](?:t|token|uploadToken)=)[^\s&<>]+/gi, "$1[protected]") };
}
export const handler = async (event: { arguments: { operation?: string; readOperation?: string; input?: unknown }; identity?: AppSyncIdentityCognito }) => {
  try {
    const actor = event.identity?.sub;
    if (!actor) throw new Error("Sign in to the CRM to continue");
    const admin = event.identity?.groups?.includes("ADMIN") || (event.identity?.claims?.["cognito:groups"] as string[] | undefined)?.includes("ADMIN");
    const input = object(event.arguments.input), op = event.arguments.readOperation ?? event.arguments.operation;
    const requireAdmin = () => { if (!admin) throw new Error("Only an admin can change integration or team settings"); };
    if (event.arguments.readOperation) {
      if (op === "accountSummary") {
        const id = text(input, "accountId"), client = await dataClient(), account = await client.models.Account.get({ id });
        if (account.errors?.length || !account.data) throw new Error("Could not load this account");
        const [contacts, quotes, documents] = await Promise.all([account.data.contacts({ limit: 25 }), account.data.quotes({ limit: 25 }), client.models.Document.listDocumentByEntityId({ entityId: id }, { limit: 25 })]);
        if (contacts.errors?.length || quotes.errors?.length || documents.errors?.length) throw new Error("Could not load account context");
        return { ok: true, summary: { name: account.data.name, source: account.data.source, notes: account.data.notes, currentPolicyExpiration: account.data.currentPolicyExpiration,
          contacts: contacts.data.map(c => ({ id: c.id, name: c.name, email: c.email, phone: c.phone })), quotes: quotes.data.map(q => ({ id: q.id, status: q.status, lines: q.lines })), documents: documents.data.map(d => ({ id: d.id, name: d.name, status: d.ocrStatus })),
          more: !!(contacts.nextToken || quotes.nextToken || documents.nextToken), url: `${process.env.CRM_BASE_URL}/accounts/${id}` } };
      }
      if (op === "activity") { const r = await get<Communication>(text(input, "id")); if (!r || r.kind !== "COMMUNICATION") throw new Error("Communication not found"); return { ok: true, communication: safeCommunication({ ...r.data, version: r.version }) }; }
      if (op === "smsComposer") { const c = await config(); if (!c.frontSmsChannelId || !c.activatedAt || c.paused) throw new Error("Activate the shared-line text channel first"); await verifySmsChannel(); return { ok: true, channelId: c.frontSmsChannelId, sender: c.sharedSmsNumber }; }
      if (op === "team") return { ok: true, team: await roster() };
      if (op === "settings") {
        requireAdmin(); const keys = await credentials();
        const recovery = Object.fromEntries(await Promise.all(["front", "dialpad"].map(async provider => {
          const cursor = await get(`cursor:${provider}`);
          return [provider, { version: cursor?.version ?? 0, checkedAt: cursor?.data.checkedAt, restartedAt: cursor?.data.restartedAt }];
        })));
        return { ok: true, recovery, config: await config(), webhookUrl: process.env.COMMUNICATION_WEBHOOK_URL, sidebarUrl: `${process.env.CRM_BASE_URL}/front-sidebar`, health: (await get("health:worker"))?.data, credentialStatus: Object.fromEntries(Object.entries(keys).filter(([k]) => k !== "installationKey").map(([k,v]) => [k, !!v])) };
      }
      if (op === "context") {
        let accountId = text(input, "accountId");
        let frontContext: { conversationId: string; assigneeId?: string; routing?: string } | undefined;
        const conversationId = text(input, "conversationId");
        if (conversationId) { const conversation = await permittedConversation(conversationId); const link = await get<ConversationLink>(`front-link:${conversation.id}`); accountId = link?.data.accountId ?? ""; frontContext = { conversationId: conversation.id, assigneeId: conversation.assignee?.id, routing: link?.data.routing }; }
        if (!accountId) return { ok: true, workflow: null, tasks: [], communications: [], issues: [], team: await roster() };
        const [wf, tasks, communications, issues, members] = await Promise.all([
          get<LeadWorkflow>(`workflow:${accountId}`), accountRows<LeadTask>(accountId, "TASK"),
          query<Communication>("account", accountId, text(input, "nextToken") || undefined, 50, "COMMUNICATION#"),
          accountRows<{ message: string; at: string }>(accountId, "ISSUE"), roster(),
        ]);
        return { ok: true, frontContext, workflow: wf ? { ...wf.data, version: wf.version } : null,
          tasks: tasks.map(t => ({ ...t.data, version: t.version })), communications: communications.items.map(r => safeCommunication({ ...r.data, version: r.version })),
          communicationNextToken: communications.nextToken, issues: issues.filter(r => !(r.data as { resolved?: boolean }).resolved).map(r => ({ id: r.id, ...r.data })), team: members };
      }
      if (op === "work") {
        const kind = text(input, "kind") || "TASK";
        if (!["TASK", "WORKFLOW", "ISSUE", "TRIAGE", "NOTIFICATION", "OPERATION", "EVENT"].includes(kind)) throw new Error("Unknown work view");
        const { workPage } = await import("./work");
        const p = await workPage({ kind, view: text(input, "view"), mine: input.mine === true, actor, nextToken: text(input, "nextToken") || undefined });
        if (kind === "NOTIFICATION") {
          const current = [];
          for (const notice of p.items.filter(r => r.data.recipient === actor)) {
            const [task, wf] = await Promise.all([get<LeadTask>(String(notice.data.taskId)), get<LeadWorkflow>(`workflow:${notice.accountId}`)]);
            const role = notice.data.urgency === "ESCALATED" || task?.data.role === "CHAMPION" ? "championId" : "salespersonId";
            if (task?.data.status === "OPEN" && wf?.data.disposition === "ACTIVE" && wf.data[role] === actor && [task.data.notifiedAt, task.data.escalatedAt].includes(String(notice.data.at))) { current.push(notice); continue; }
            // A cancelled episode, changed owner or edited promise retires its old reminder.
            try { await commit([put(row("NOTIFICATION", notice.id, { ...notice.data, resolved: true }, { accountId: notice.accountId, previous: notice }), notice), ...(task ? [check(task)] : []), ...(wf ? [check(wf)] : [])]); }
            catch (e) { if (!conflict(e) && !retryableStorage(e)) throw e; }
          }
          p.items = current;
        }
        const items = p.items.filter(r => kind !== "NOTIFICATION" || r.data.recipient === actor).map(r => kind === "EVENT" ? { id: r.id, version: r.version, provider: r.data.provider, error: r.data.error, attempts: r.data.attempts, processedAt: r.data.processedAt, dueAt: r.dueAt } : kind === "OPERATION" ? { id: r.id, accountId: r.accountId, version: r.version, type: r.data.type, state: r.data.state, error: r.data.error, uid: r.data.uid, messageId: r.data.messageId, conversationId: r.data.conversationId } : { ...r.data, id: r.id, version: r.version, accountId: r.accountId });
        const workflows = new Map((await Promise.all([...new Set(p.items.map(r => r.accountId).filter((id): id is string => !!id))].map(id => get<LeadWorkflow>(`workflow:${id}`)))).filter((w): w is NonNullable<typeof w> => !!w).map(w => [w.data.accountId, w.data]));
        return { ok: true, items: items.map(item => { const wf = workflows.get((item as { accountId?: string }).accountId ?? ""); return { ...item, ...(wf ? { name: wf.name, salespersonId: wf.salespersonId, championId: wf.championId } : {}) }; }), nextToken: p.nextToken };
      }
      throw new Error("Unknown read operation");
    }
    if (op === "refreshSeen") {
      const comm = await get<Communication>(text(input, "id"));
      if (!comm?.accountId || comm.kind !== "COMMUNICATION" || comm.data.provider !== "front" || comm.data.channel !== "EMAIL" || comm.data.direction !== "OUTBOUND") throw new Error("Choose a sent Front email");
      const last = Math.max(Date.parse(comm.data.seenRequestedAt ?? "") || 0, Date.parse(comm.data.seenCheckedAt ?? "") || 0);
      if (Date.now() - last < 60_000) return { ok: true, notice: "Seen status was recently checked or queued. Refresh the history shortly." };
      const now = new Date().toISOString();
      await save(row("COMMUNICATION", comm.id, { ...comm.data, seenRequestedAt: now, attempts: 0 }, { accountId: comm.accountId, previous: comm, dueAt: now }), comm);
      return { ok: true, notice: "Seen refresh queued. Refresh the history shortly; provider limits may delay the result." };
    }
    if (op === "saveAttachment") {
      const source = await get<Communication>(text(input, "communicationId")), attachmentId = text(input, "attachmentId");
      if (!source?.accountId || source.kind !== "COMMUNICATION" || source.data.provider !== "front" || !source.data.attachments?.some(a => a.id === attachmentId)) throw new Error("Choose an attachment on a linked Front message");
      await enqueueOperation(`op:attachment:${source.id}:${attachmentId}`, { type: "ATTACHMENT", accountId: source.accountId, sourceMessageId: source.data.providerId, attachmentId, requestedBy: actor });
      return { ok: true };
    }
    if (op === "initializeLead") return { ok: true, workflow: (await ensureWorkflow(text(input, "accountId"))).data };
    if (op === "setResponsibilities") return { ok: true, workflow: await setResponsibilities(text(input, "accountId"), text(input, "salespersonId"), text(input, "championId"), version(input), actor) };
    if (op === "reopenLead") {
      const accountId = text(input, "accountId"), wf = await ensureWorkflow(accountId); expected(wf, version(input));
      if (!["LOST", "DISQUALIFIED"].includes(wf.data.disposition)) throw new Error("Only lost or disqualified leads can be reopened here");
      const reason = text(input, "reason"); if (!reason) throw new Error("Record the reopening reason");
      const { makeTask } = await import("./workflow");
      const task = await makeTask({ accountId, title: text(input, "title"), dueAt: text(input, "dueAt"), kind: "FOLLOW_UP", custom: true });
      await commit([put(row("WORKFLOW", wf.id, { ...wf.data, disposition: "ACTIVE", humanTakeover: true, version: wf.version + 1 }, { accountId, previous: wf }), wf), put(row("TASK", task.id, task, { accountId, dueAt: task.dueAt })), audit(accountId, actor, "Lead reopened with next action", { reason, task })]);
      return { ok: true };
    }
    if (op === "saveTask") return { ok: true, task: await saveTask(input as unknown as Parameters<typeof saveTask>[0], actor) };
    if (op === "mergeTasks") { await mergeTasks(input as unknown as Parameters<typeof mergeTasks>[0], actor); return { ok: true }; }
    if (op === "completeTask") { await completeTask(input as unknown as Parameters<typeof completeTask>[0], actor); return { ok: true }; }
    if (op === "saveEligibility") {
      requireAdmin(); const userId = text(input, "userId"); await enabledUser(userId);
      const member = (await roster()).find(t => t.userId === userId); if (!member) throw new Error("Teammate not found");
      const old = await get<TeamEligibility>(`eligibility:${userId}`);
      if ((old?.version ?? 0) !== Number(input.version ?? 0)) throw new Error("Teammate settings changed. Refresh and try again.");
      const next: TeamEligibility = { userId, name: member.name, email: member.email, enabled: input.enabled !== false, salesperson: input.salesperson === true, champion: input.champion === true,
        frontId: text(input, "frontId") || undefined, dialpadId: text(input, "dialpadId") || undefined };
      if (next.frontId && !/^tea_[a-z0-9]+$/.test(next.frontId)) throw new Error("Invalid Front teammate ID");
      if (next.dialpadId && !/^\d+$/.test(next.dialpadId)) throw new Error("Invalid Dialpad user ID");
      await commit([put(row("ELIGIBILITY", `eligibility:${userId}`, next, { previous: old }), old), audit("TEAM", actor, "Assignment eligibility changed", next)]);
      return { ok: true, member: next };
    }
    if (op === "saveSettings") {
      requireAdmin(); const value = object(input.config) as unknown as IntegrationConfig;
      value.dialpadNumbers = (value.dialpadNumbers ?? []).map(n => { const phone = normalizePhone(n); if (!phone) throw new Error("Invalid business phone number"); return phone; });
      value.sharedSmsNumber = normalizePhone(value.sharedSmsNumber) ?? "";
      if (value.sharedSmsNumber !== "+15082332261") throw new Error("Prospect texts use the confirmed shared main line (508) 233-2261");
      if (value.defaultUserId) {
        if (!(await roster()).some(member => member.userId === value.defaultUserId)) throw new Error("Choose a current CRM teammate as the default");
        await validRole(value.defaultUserId, "SALESPERSON"); await validRole(value.defaultUserId, "CHAMPION", false);
      }
      if (input.credentials && Object.values(object(input.credentials)).some(v => typeof v === "string" && v.trim())) { value.paused = true; value.cleanupEnabled = false; }
      const credentialFields = Object.entries(object(input.credentials)).filter(([key, value]) => ["frontToken", "frontSigningKey", "dialpadToken", "dialpadSigningKey"].includes(key) && typeof value === "string" && !!value.trim()).map(([key]) => key);
      const saved = await saveConfig(value, false, [audit("SETTINGS", actor, "Integration settings saved", { paused: value.paused, cleanupEnabled: value.cleanupEnabled, credentialUpdatesRequested: credentialFields })]);
      if (credentialFields.length) {
        await saveCredentials(object(input.credentials) as Credentials);
        await commit([audit("SETTINGS", actor, "Integration credentials updated", { fields: credentialFields })]);
      }
      return { ok: true, config: saved };
    }
    if (op === "restartReconciliation") {
      requireAdmin(); const provider = text(input, "provider"), reason = text(input, "reason", 2000);
      if (!["front", "dialpad"].includes(provider) || !reason) throw new Error("Choose a provider and record why history needs to restart");
      const c = await config(); if (!c.activatedAt) throw new Error("Activate capture before restarting reconciliation");
      const key = `cursor:${provider}`, old = await get(key);
      if (version(input) !== (old?.version ?? 0)) throw new Error("History progressed. Refresh settings before restarting it.");
      // Keep the unfinished time window; dropping only pagination cannot skip
      // uncaptured records. Existing receipts deduplicate pages already read.
      const data = { after: old?.data.after ?? Date.parse(c.activatedAt), through: old?.data.through,
        ...(provider === "front" ? { inbox: old?.data.inbox ?? 0 } : {}), restartedAt: new Date().toISOString() };
      await commit([put(row("CURSOR", key, data, { previous: old }), old), audit("SETTINGS", actor, "Provider history restarted", { provider, reason, after: data.after, through: data.through })]);
      return { ok: true };
    }
    if (op === "restartConversationHistory") {
      requireAdmin(); const reason = text(input, "reason", 2000);
      if (!reason) throw new Error("Record why this conversation's history needs to restart");
      const cnv = (await permittedConversation(text(input, "conversationId"))).id;
      const link = await get<ConversationLink>(`front-link:${cnv}`), writes = [];
      // Both the initial link walk and the periodic repair use this same reset
      // contract. Restart in place so an old failed row cannot latch capture off.
      for (const id of [`conversation-backfill:${cnv}`, `front-reconcile:${cnv}`]) {
        const old = await get<HistoryJob>(id);
        if (old?.dueAt) continue;
        if (id.startsWith("front-reconcile:") && !old) continue;
        writes.push(put(restartHistory(id, cnv, link?.data.accountId ?? old?.accountId, old), old));
      }
      if (writes.length) writes.push(audit(link?.data.accountId ?? "SETTINGS", actor, "Conversation history restarted", { cnv, reason }));
      await commit(writes); return { ok: true };
    }
    if (op === "validateConnection") { requireAdmin(); return { ok: true, checks: await connectionChecks() }; }
    if (op === "activate") {
      requireAdmin();
      if (input.nativeChecksConfirmed !== true) throw new Error("Verify the connected numbers and shared-line text sender before activation");
      const checks = await activationChecks();
      if (checks.some(c => !c.ok)) return { ok: false, error: checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`).join("; ") };
      const c = await config();
      const saved = await saveConfig({ ...c, activatedAt: c.activatedAt ?? new Date().toISOString(), paused: false, cleanupEnabled: input.cleanupEnabled === true }, true);
      await commit([audit("SETTINGS", actor, "Integration activated after connection checks", { at: saved.activatedAt, cleanupEnabled: saved.cleanupEnabled })]);
      return { ok: true, config: saved };
    }
    if (op === "cancelAi") {
      const wf = await ensureWorkflow(text(input, "accountId")); expected(wf, version(input));
      await commit([put(row("WORKFLOW", wf.id, { ...wf.data, humanTakeover: true, version: wf.version + 1 }, { accountId: wf.accountId, previous: wf }), wf), audit(wf.data.accountId, actor, "Initial AI reply cancelled", {})]);
      // An eventually consistent account index cannot prove that no send has
      // already acquired its lease. Never promise recall from that snapshot.
      return { ok: true, notice: "The team has taken over and future AI sends are blocked. An email already dispatched may still arrive; this action cannot recall it. Check its delivery state in Front before replying." };
    }
    if (op === "linkConversation") {
      const accountId = text(input, "accountId"), cnv = (await permittedConversation(text(input, "conversationId"))).id;
      const wf = await ensureWorkflow(accountId), old = await get<ConversationLink>(`front-link:${cnv}`);
      if (old && old.accountId !== accountId) throw new Error("This conversation already belongs to another account; review its link first");
      const purpose = input.purpose === "CARRIER" ? "CARRIER" : "PROSPECT";
      const changed = old?.data.purpose !== purpose;
      const writes = [];
      if (changed) writes.push(put(row("LINK", `front-link:${cnv}`, { accountId, conversationId: cnv, purpose, routing: purpose === "CARRIER" ? "CHAMPION" : "SALESPERSON" }, { accountId, previous: old }), old));
      if (!wf.data.conversationId && purpose === "PROSPECT") writes.push(put(row("WORKFLOW", wf.id, { ...wf.data, conversationId: cnv, version: wf.version + 1 }, { accountId, previous: wf }), wf));
      if (changed) {
        const handlerId = purpose === "CARRIER" ? wf.data.championId : wf.data.salespersonId;
        const handler = handlerId ? await get<TeamEligibility>(`eligibility:${handlerId}`) : undefined;
        if (handler?.data.frontId) writes.push(put(operationRow(`op:link-route:${cnv}:${old?.version ?? 0}`, { type: "ASSIGN", accountId, conversationId: cnv, assigneeId: handler.data.frontId })));
      }
      const backfillId = `conversation-backfill:${cnv}`, backfill = await get<HistoryJob>(backfillId);
      if (!backfill || historyStopped(backfill)) writes.push(put(restartHistory(backfillId, cnv, accountId, backfill), backfill));
      if (writes.length) {
        if (!changed && old) writes.push(check(old));
        writes.push(audit(accountId, actor, changed ? "Conversation linked" : "Conversation link repaired", { cnv, purpose }));
      }
      await commit(writes); return { ok: true };
    }
    if (op === "linkActivity") { await linkActivity(input as unknown as Parameters<typeof linkActivity>[0], actor); return { ok: true }; }
    if (op === "recordCallOutcome") { await recordCallOutcome(input as unknown as Parameters<typeof recordCallOutcome>[0], actor); return { ok: true }; }
    if (op === "reviewOperation") { requireAdmin(); await reviewOperation(input as unknown as Parameters<typeof reviewOperation>[0], actor); return { ok: true }; }
    if (op === "reviewIssue") {
      const old = await get(text(input, "id")); if (!old || !["ISSUE", "TRIAGE", "NOTIFICATION", "EVENT"].includes(old.kind)) throw new Error("Review item not found"); expected(old, version(input));
      const reason = text(input, "reason", 2000); if (!reason) throw new Error("Record the review reason");
      if (old.kind === "EVENT") requireAdmin();
      const replay = input.replay === true && old.kind === "EVENT";
      await commit([put(row(old.kind, old.id, { ...old.data, resolved: !replay, attempts: replay ? 0 : old.data.attempts, error: undefined }, { accountId: old.accountId, previous: old, dueAt: replay ? new Date().toISOString() : undefined }), old), audit(old.accountId ?? "TRIAGE", actor, replay ? "Event replay requested" : "Review item resolved", { id: old.id, reason })]);
      return { ok: true };
    }
    if (op === "archive") {
      const accountId = text(input, "accountId"), wf = await ensureWorkflow(accountId); expected(wf, version(input));
      const cnv = text(input, "conversationId") || wf.data.conversationId;
      if (!cnv || !await archiveAllowed(accountId, cnv)) throw new Error("Keep this conversation open until responsibilities, next actions, unresolved communication and sync health are clear");
      await enqueueOperation(`op:manual-cleanup:${accountId}:${randomUUID()}`, { type: "ARCHIVE", accountId, conversationId: cnv }); return { ok: true };
    }
    if (op === "routeConversation") {
      const cnv = (await permittedConversation(text(input, "conversationId"))).id, role = text(input, "role"), link = await get<ConversationLink>(`front-link:${cnv}`);
      if (!link || !["SALESPERSON", "CHAMPION"].includes(role)) throw new Error("Link this conversation and select its handler role");
      const wf = await ensureWorkflow(link.data.accountId);
      const member = await get<TeamEligibility>(`eligibility:${role === "CHAMPION" ? wf.data.championId : wf.data.salespersonId}`);
      if (!member?.data.frontId) throw new Error("Map this teammate's Front identity in Team settings");
      await commit([put(row("LINK", link.id, { ...link.data, routing: role }, { accountId: link.accountId, previous: link }), link), put(operationRow(`op:route:${cnv}:${link.version}`, { type: "ASSIGN", accountId: wf.data.accountId, conversationId: cnv, assigneeId: member.data.frontId })), audit(wf.data.accountId, actor, "Conversation routing changed", { cnv, role })]);
      return { ok: true };
    }
    if (op === "addNote") {
      const accountId = text(input, "accountId"), body = text(input, "text", 10000), requestId = text(input, "requestId");
      if (!body || !/^[a-zA-Z0-9-]{20,100}$/.test(requestId)) throw new Error("Enter a note and valid request identity"); await ensureWorkflow(accountId);
      const id = `note:${actor}:${requestId}`; if (await get(id)) return { ok: true };
      const writes = [put(row("COMMUNICATION", id, { id, accountId, provider: "crm", providerId: id, channel: "NOTE", direction: "INTERNAL", at: new Date().toISOString(), text: body, actorId: actor, status: "SAVED", version: 1 }, { accountId })), audit(accountId, actor, "Internal note added", { id })];
      if (input.publishToFront === true) writes.push(put(operationRow(`op:${id}`, { type: "COMMENT", accountId, text: body })));
      await commit(writes); return { ok: true };
    }
    if (op === "createLead") {
      const requestId = text(input, "requestId"), fields = object(input.fields), name = text(fields, "name", 200);
      if (!name || !/^[a-zA-Z0-9-]{20,100}$/.test(requestId)) throw new Error("A name and valid request ID are required");
      const key = `manual:${actor}:${requestId}`, existing = await get<{ accountId: string }>(key);
      if (existing) return { ok: true, id: existing.data.accountId };
      const id = randomUUID(), wf = await defaultWorkflow(id, name);
      if (input.salespersonId || input.championId) {
        const salespersonId = text(input, "salespersonId"), championId = text(input, "championId");
        await validRole(salespersonId, "SALESPERSON"); await validRole(championId, "CHAMPION");
        Object.assign(wf, { salespersonId, championId, assignmentIssue: undefined });
      }
      const account: Input = { name, stage: "LEAD", type: ["ASSOCIATION", "PERSONAL", "COMMERCIAL_OTHER"].includes(String(fields.type)) ? fields.type : "ASSOCIATION", lastWriteBy: actor };
      for (const field of ["address", "city", "state", "zip", "currentAgent", "currentPolicyExpiration", "source", "notes"]) if (fields[field]) account[field] = text(fields, field, field === "notes" ? 10000 : 500);
      for (const field of ["unitCount", "totalInsuredValue"]) if (fields[field] != null && fields[field] !== "") {
        const value = Number(fields[field]); if (!Number.isFinite(value) || value < 0 || field === "unitCount" && !Number.isInteger(value)) throw new Error("Enter valid units and insured value"); account[field] = value;
      }
      try { await commit([modelPut("Account", id, account), put(row("WORKFLOW", `workflow:${id}`, wf, { accountId: id })), put(row("MANUAL_REQUEST", key, { accountId: id })), audit(id, actor, "Lead created", { name })]); }
      catch(e) { if (conflict(e)) { const winner = await get<{ accountId: string }>(key); if (winner) return { ok: true, id: winner.data.accountId }; } throw e; }
      return { ok: true, id };
    }
    if (op === "backfill") {
      requireAdmin(); const client = await dataClient();
      const page = await client.models.Account.list({ filter: { stage: { eq: "LEAD" } }, nextToken: text(input, "nextToken") || undefined, limit: 25 });
      if (page.errors?.length) throw new Error("Could not load the next lead batch");
      let assigned = 0, exceptions = 0;
      for (const account of page.data) {
        const old = await ensureWorkflow(account.id);
        if (!old.data.salespersonId || !old.data.championId) {
          const defaults = await defaultWorkflow(account.id, account.name);
          if (defaults.assignmentIssue) { exceptions++; continue; }
          await save(row("WORKFLOW", old.id, { ...old.data, salespersonId: old.data.salespersonId ?? defaults.salespersonId, championId: old.data.championId ?? defaults.championId, assignmentIssue: undefined, version: old.version + 1 }, { accountId: account.id, previous: old }), old);
          assigned++;
        }
      }
      return { ok: true, assigned, exceptions, nextToken: page.nextToken };
    }
    throw new Error("Unknown operation");
  } catch (e) {
    return { ok: false, error: conflict(e) ? "This record changed. Refresh and try again." : e instanceof Error ? e.message : "The change could not be saved" };
  }
};
