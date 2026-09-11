import { taskWakeAt } from "../../../../shared/leadWorkflow";
import { isLeadSource } from "../../../../shared/leadSource";
import { historyStopped, restartHistory, type HistoryJob } from "./history";
import { reviewOperation, recordCallOutcome, linkActivity } from "./review";
import { archiveAllowed } from "./cleanup";
import { randomUUID } from "node:crypto";
import type { AppSyncIdentityCognito } from "aws-lambda";
import type { Communication, IntegrationConfig, LeadTask, LeadWorkflow, TeamEligibility } from "../../../../shared/leadWorkflow";
import { normalizePhone } from "../../../../shared/leadWorkflow";
import { get, row, query, save, put, commit, audit, conflict, retryableStorage, check, hash } from "./store";
import { authorizedQuoteTerms } from "../../../../shared/quoteAuthorization";
import { validCalendarDate } from "../../../../shared/renewalPolicy";
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
      if (op === "nextYearPreview") {
        const account = await (await dataClient()).models.Account.get({ id: text(input, "accountId") });
        if (account.errors?.length || !account.data?.currentPolicyExpiration) throw new Error("Record the incumbent expiration in the account first");
        const result = (await import("../../../../shared/renewalPolicy")).annualReturn(account.data.currentPolicyExpiration, (await config()).holidays, new Date().toISOString());
        return { ok: true, current: account.data.currentPolicyExpiration, next: result.expiration, returnAt: result.returnAt };
      }
      if (op === "reportDelivery") {
        requireAdmin(); const page = await query<{ recipientId: string; day: string; state: string; error?: string }>("work", "REPORT_EDITION", text(input, "nextToken") || undefined, 50), members = await roster();
        return { ok: true, items: page.items.map(r => ({ id: r.id, recipient: members.find(m => m.userId === r.data.recipientId)?.name ?? "Unavailable teammate", day: r.data.day, state: r.data.state, error: r.data.error })), nextToken: page.nextToken };
      }
      if (op === "lastContacts") {
        const accounts = input.accounts;
        if (!Array.isArray(accounts) || accounts.length > 10) throw new Error("Choose up to 10 leads at a time");
        const { lastContactPage } = await import("./lastContact");
        const items = [];
        // Keep provider-free history reads bounded and below table bursts.
        for (const raw of accounts) {
          const entry = object(raw), id = text(entry, "accountId", 100);
          if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("Choose a valid lead");
          items.push(await lastContactPage(id, text(entry, "nextToken", 4000) || undefined));
        }
        return { ok: true, items };
      }
      if (op === "accountSummary") {
        const id = text(input, "accountId"), client = await dataClient(), account = await client.models.Account.get({ id });
        if (account.errors?.length || !account.data) throw new Error("Could not load this account");
        const [contacts, quotes, documents] = await Promise.all([account.data.contacts({ limit: 25 }), account.data.quotes({ limit: 25 }), client.models.Document.listDocumentByEntityId({ entityId: id }, { limit: 25 })]);
        if (contacts.errors?.length || quotes.errors?.length || documents.errors?.length) throw new Error("Could not load account context");
        return { ok: true, summary: { name: account.data.name, source: account.data.source, leadSource: account.data.leadSource, notes: account.data.notes, currentPolicyExpiration: account.data.currentPolicyExpiration,
          contacts: contacts.data.map(c => ({ id: c.id, name: c.name, email: c.email, phone: c.phone })), quotes: quotes.data.map(q => ({ id: q.id, status: q.status, lines: q.lines })), documents: documents.data.map(d => ({ id: d.id, name: d.name, status: d.ocrStatus })),
          more: !!(contacts.nextToken || quotes.nextToken || documents.nextToken), url: `${process.env.CRM_BASE_URL}/accounts/${id}` } };
      }
      if (op === "deliveryOptions") {
        const task = await get<LeadTask>(text(input, "taskId")); if (!task || task.data.status !== "OPEN") throw new Error("Choose an open service request");
        const client = await dataClient(), options: { id: string; kind: string; name: string }[] = [];
        let nextToken: string | undefined;
        if (task.data.serviceType === "CERTIFICATE") do { const p = await client.models.Certificate.list({ filter: { accountId: { eq: task.data.accountId } }, nextToken, limit: 100 }); if (p.errors?.length) throw new Error("Could not load certificates"); options.push(...p.data.filter(d => d.s3Key && task.data.sourceIds?.includes(d.sourceCommunicationId ?? "")).map(d => ({ id: d.id, kind: "CERTIFICATE", name: `${d.certificateNumber ?? "Certificate"} · ${d.holderName}` }))); nextToken = p.nextToken ?? undefined; } while (nextToken);
        else do { const p = await client.models.Document.listDocumentByEntityId({ entityId: task.data.accountId }, { nextToken, limit: 100 }); if (p.errors?.length) throw new Error("Could not load documents"); options.push(...p.data.filter(d => d.s3Key && d.s3Key !== "pending" && task.data.sourceIds?.includes(d.sourceCommunicationId ?? "")).map(d => ({ id: d.id, kind: "DOCUMENT", name: d.name }))); nextToken = p.nextToken ?? undefined; } while (nextToken);
        return { ok: true, options };
      }
      if (op === "activity") { const r = await get<Communication>(text(input, "id")); if (!r || r.kind !== "COMMUNICATION") throw new Error("Communication not found"); return { ok: true, communication: safeCommunication({ ...r.data, version: r.version }) }; }
      if (op === "smsComposer") { const c = await config(); if (!c.frontSmsChannelId || !c.activatedAt || c.paused) throw new Error("Activate the shared-line text channel first"); await verifySmsChannel(); return { ok: true, channelId: c.frontSmsChannelId, sender: c.sharedSmsNumber }; }
      if (op === "myReport") return { ok: true, report: await (await import("./reports")).reportFor(actor) };
      if (op === "teamRouting") return { ok: true, routing: await (await import("./routing")).routing() };
      if (op === "team") return { ok: true, team: await roster() };
      if (op === "settings") {
        requireAdmin(); const keys = await credentials();
        const recovery = Object.fromEntries(await Promise.all(["front", "dialpad"].map(async provider => {
          const cursor = await get(`cursor:${provider}`);
          return [provider, { version: cursor?.version ?? 0, checkedAt: cursor?.data.checkedAt, restartedAt: cursor?.data.restartedAt }];
        })));
        return { ok: true, recovery, config: await config(), webhookUrl: process.env.COMMUNICATION_WEBHOOK_URL, alertTopicArn: process.env.COMMUNICATION_ALERT_TOPIC, sidebarUrl: `${process.env.CRM_BASE_URL}/front-sidebar`, health: (await get("health:worker"))?.data, credentialStatus: Object.fromEntries(Object.entries(keys).filter(([k]) => k !== "installationKey").map(([k,v]) => [k, !!v])) };
      }
      if (op === "context") {
        let accountId = text(input, "accountId");
        let frontContext: import("../../../../shared/leadWorkflow").WorkflowContext["frontContext"] | undefined;
        const conversationId = text(input, "conversationId");
        if (conversationId) { const conversation = await permittedConversation(conversationId); const link = await get<ConversationLink>(`front-link:${conversation.id}`); accountId = link?.data.accountId ?? ""; frontContext = { conversationId: conversation.id, assigneeId: conversation.assignee?.id, routing: link?.data.routing, purpose: link?.data.purpose, context: link?.data.context, policyId: link?.data.policyId }; }
        if (!accountId) return { ok: true, workflow: null, tasks: [], communications: [], issues: [], team: await roster() };
        const [wf, tasks, communications, issues, members, settings, health, monitor, census, syncGap] = await Promise.all([
          get<LeadWorkflow>(`workflow:${accountId}`), accountRows<LeadTask>(accountId, "TASK"),
          query<Communication>("account", accountId, text(input, "nextToken") || undefined, 50, "COMMUNICATION#"),
          accountRows<{ message: string; at: string }>(accountId, "ISSUE"), roster(), config(),
          get("health:worker"), get("health:monitor"), get("coverage:census"), get("issue:sync-gap"),
        ]);
        const recent = (value: unknown, maxAge: number) => {
          const age = typeof value === "string" ? Date.now() - Date.parse(value) : NaN;
          return age >= 0 && age <= maxAge;
        };
        const trackingHealthy = !!settings.activatedAt && !settings.paused
          && health?.data.lagging === false && recent(health.data.at, 300_000)
          && Array.isArray(monitor?.data.errors) && monitor.data.errors.length === 0 && recent(monitor.data.at, 600_000)
          && recent(census?.data.completedAt, 24 * 3600_000) && (!syncGap || syncGap.data.resolved === true);
        return { ok: true, actorId: actor, trackingHealthy, frontContext, workflow: wf ? { ...wf.data, version: wf.version } : null,
          tasks: tasks.map(t => ({ ...t.data, version: t.version })), communications: communications.items.filter(r => r.data.status !== "DRAFT").map(r => safeCommunication({ ...r.data, version: r.version })),
          communicationNextToken: communications.nextToken, issues: issues.filter(r => !(r.data as { resolved?: boolean }).resolved).map(r => ({ id: r.id, ...r.data })), team: members };
      }
      if (op === "work") {
        const kind = text(input, "kind") || "TASK";
        if (!["TASK", "WORKFLOW", "ISSUE", "TRIAGE", "NOTIFICATION", "OPERATION", "EVENT"].includes(kind)) throw new Error("Unknown work view");
        if (["ISSUE", "OPERATION", "EVENT"].includes(kind)) requireAdmin();
        const responsibility = text(input, "responsibility");
        if (responsibility && !["SALESPERSON", "CHAMPION"].includes(responsibility)) throw new Error("Choose a valid responsibility");
        const { workPage } = await import("./work");
        const p = await workPage({ kind, view: text(input, "view"), responsibility, mine: input.mine === true, actor, nextToken: text(input, "nextToken", 4000) || undefined });
        if (kind === "NOTIFICATION") {
          const current = [];
          for (const notice of p.items.filter(r => r.data.recipient === actor)) {
            const [task, wf] = await Promise.all([get<LeadTask>(String(notice.data.taskId)), get<LeadWorkflow>(`workflow:${notice.accountId}`)]);
            const route = task && wf ? await (await import("./routing")).resolveTaskRoute(task.data, wf.data) : undefined;
            const now = new Date().toISOString();
            const allowed = route && task && (route.recipientId === actor || task.data.escalationAt <= now && route.managerId === actor || task.data.ownerEscalationAt && task.data.ownerEscalationAt <= now && route.ownerId === actor);
            if (task?.data.status === "OPEN" && allowed && [task.data.lastReminderAt, task.data.notifiedAt, task.data.escalatedAt, task.data.ownerNotifiedAt].includes(String(notice.data.at))) { current.push(notice); continue; }
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
    if (op === "prepareBusinessDraft") return { ok: true, draft: await (await import("./businessDelivery")).prepareBusinessDraft(input as unknown as Parameters<typeof import("./businessDelivery").prepareBusinessDraft>[0], actor) };
    if (op === "authorizeBind") {
      if (input.clientAuthorized !== true) throw new Error("Client authorization is required before requesting binding");
      const q = await (await dataClient()).models.Quote.get({ id: text(input, "quoteId") });
      if (q.errors?.length || !q.data) throw new Error("Could not load the quote");
      const terms = authorizedQuoteTerms(q.data);
      if (q.data.bindAuthorizedAt && q.data.bindAuthorizedTerms === terms) return { ok: true };
      if (!["QUOTED", "PRESENTED"].includes(q.data.status) || !q.data.carrierId || !validCalendarDate(q.data.effectiveDate) || !validCalendarDate(q.data.expirationDate) || q.data.expirationDate <= q.data.effectiveDate || !(q.data.premium != null && q.data.premium > 0) || !q.data.lines?.filter(Boolean).length) throw new Error("Finish the usable quote before recording client authorization");
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      if (q.data.offerExpiresAt && (!validCalendarDate(q.data.offerExpiresAt) || q.data.offerExpiresAt < today)) throw new Error("The carrier offer has expired. Obtain current terms before requesting binding.");
      if (q.data.updatedAt !== text(input, "updatedAt")) throw new Error("The quote changed. Review its current terms before authorizing binding.");
      const now = new Date().toISOString();
      await commit([{ Update: { TableName: process.env.QUOTE_TABLE!, Key: { id: q.data.id }, UpdateExpression: "SET bindAuthorizedAt = :at, bindAuthorizedBy = :actor, bindAuthorizedTerms = :terms, updatedAt = :at, lastWriteBy = :actor", ConditionExpression: "updatedAt = :old", ExpressionAttributeValues: { ":at": now, ":actor": actor, ":terms": terms, ":old": q.data.updatedAt } } },
        put(row("LIFECYCLE", `lifecycle:bind-authorization:${q.data.id}:${hash(`${terms}:${q.data.updatedAt}`).slice(0,16)}`, { accountId: q.data.accountId }, { accountId: q.data.accountId, dueAt: now })), audit(q.data.accountId, actor, "Client authorized binding of quoted terms", { quoteId: q.data.id })]);
      return { ok: true };
    }
    if (op === "recoverReport") { requireAdmin(); await (await import("./reports")).recoverEdition(text(input, "editionId"), text(input, "messageId")); return { ok: true }; }
    if (op === "saveTeamRouting") { requireAdmin(); return { ok: true, routing: await (await import("./routing")).saveRouting(input as unknown as import("../../../../shared/leadWorkflow").TeamRouting, actor, await roster()) }; }
    if (op === "nextYear") return { ok: true, result: await (await import("./annualReturn")).nextYear(input as unknown as Parameters<typeof import("./annualReturn").nextYear>[0], actor) };
    if (op === "takeResponse" || op === "delegateService" || op === "requestProspectInformation") {
      const task = await get<LeadTask>(text(input, "taskId")); if (!task || task.data.status !== "OPEN") throw new Error("Choose an open request"); expected(task, version(input));
      const wf = await ensureWorkflow(task.data.accountId), routingRecord = await get("team-routing");
      const route = await (await import("./routing")).resolveTaskRoute(task.data, wf.data);
      if (op === "takeResponse") {
        if (actor !== route.managerId && actor !== route.ownerId) throw new Error("Only the responsible manager or owner can take this response");
        await commit([check(wf), ...(routingRecord ? [check(routingRecord)] : []), put(row("TASK", task.id, { ...task.data, helperId: actor, helperRequestedBy: actor, helperReason: "MANAGER_COVER", version: task.version + 1 }, { accountId: task.accountId, previous: task, dueAt: task.dueAt }), task)]);
      } else {
        if (actor !== wf.data.championId && actor !== route.managerId && actor !== route.ownerId) throw new Error("The champion or responsible manager coordinates this request");
        if (op === "delegateService") {
          if ((task.data.context ?? "LEAD") === "LEAD") throw new Error("Use the lead's salesperson for client work");
          const specialist = text(input, "specialistId"); await enabledUser(specialist);
          await commit([check(wf), put(row("TASK", task.id, { ...task.data, specialistId: specialist, accountableRole: "CHAMPION", version: task.version + 1 }, { accountId: task.accountId, previous: task, dueAt: task.dueAt }), task), audit(task.data.accountId, actor, "Specialist assigned to client request", { taskId: task.id, specialist })]);
        } else {
          if (task.data.kind !== "CARRIER" || (task.data.context ?? "LEAD") !== "LEAD") throw new Error("Choose the carrier's new-business information request");
          const key = `task:client-information:${task.id}`;
          if (!await get(key)) {
            const { makeTask } = await import("./workflow");
            const child = await makeTask({ accountId: task.data.accountId, id: key, kind: "DOCUMENTS", title: "Obtain the information requested by underwriting", role: "SALESPERSON", domain: "CLIENT", context: "LEAD", sourceAt: new Date().toISOString(), conversationId: wf.data.conversationId });
            child.parentTaskId = task.id; child.sourceIds = []; child.requirementSourceIds = task.data.sourceIds; child.waitingOn = "PROSPECT";
            const requirementId = `task:requirement:${task.id}`, oldRequirement = await get(requirementId);
            const requirement = { ...task.data, id: requirementId, kind: "DOCUMENTS" as const, title: "Supply the information requested by underwriting", milestone: true, serviceType: "GENERAL" as const, parentTaskId: task.id, version: 1 };
            await commit([check(wf), check(task), ...(!oldRequirement ? [put(row("TASK", requirementId, requirement, { accountId: task.accountId, dueAt: taskWakeAt(requirement) }))] : []), put(row("TASK", key, child, { accountId: task.accountId, dueAt: taskWakeAt(child) })), audit(task.data.accountId, actor, "Requested prospect information from salesperson", { taskId: task.id })]);
          }
        }
      }
      return { ok: true };
    }
    if (op === "requestChampionHelp") {
      const task = await get<LeadTask>(text(input, "taskId"));
      if (!task || task.data.status !== "OPEN") throw new Error("Choose an open client request");
      expected(task, version(input));
      const wf = await ensureWorkflow(task.data.accountId);
      const { taskDomain, taskContext } = await import("../../../../shared/workRouting");
      if (taskDomain(task.data) !== "CLIENT" || taskContext(task.data) !== "LEAD") throw new Error("Champion help applies to a prospect request");
      if (actor !== wf.data.salespersonId) throw new Error("The salesperson requests help with their prospect");
      if (!wf.data.championId) throw new Error("Assign the deal champion first");
      await validRole(wf.data.championId, "CHAMPION");
      await commit([check(wf), put(row("TASK", task.id, { ...task.data, helperId: wf.data.championId, helperRequestedBy: actor, helperReason: "SALES_ASSIST", accountableRole: "SALESPERSON", version: task.version + 1 }, { accountId: task.accountId, previous: task, dueAt: task.dueAt }), task), audit(task.data.accountId, actor, "Asked champion to help with prospect", { taskId: task.id })]);
      return { ok: true };
    }
    if (op === "refreshSeen") {
      const comm = await get<Communication>(text(input, "id"));
      if (!comm?.accountId || comm.kind !== "COMMUNICATION" || comm.data.provider !== "front" || comm.data.channel !== "EMAIL" || comm.data.direction !== "OUTBOUND" || comm.data.status === "DRAFT") throw new Error("Choose a sent Front email");
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
      await commit([put(row("WORKFLOW", wf.id, { ...wf.data, disposition: "ACTIVE", humanTakeover: true, version: wf.version + 1 }, { accountId, previous: wf }), wf), put(row("TASK", task.id, task, { accountId, dueAt: taskWakeAt(task) })), audit(accountId, actor, "Lead reopened with next action", { reason, task })]);
      return { ok: true };
    }
    if (op === "saveTask") return { ok: true, task: await saveTask(input as unknown as Parameters<typeof saveTask>[0], actor) };
    if (op === "mergeTasks") { await mergeTasks(input as unknown as Parameters<typeof mergeTasks>[0], actor); return { ok: true }; }
    if (op === "completeTask") { await completeTask(input as unknown as Parameters<typeof completeTask>[0], actor); return { ok: true }; }
    if (op === "setLeadDisposition") { const { setLeadDisposition } = await import("./workflow"); await setLeadDisposition(text(input, "accountId"), text(input, "disposition"), Number(input.version), actor); return { ok: true }; }
    if (op === "saveEligibility") {
      requireAdmin(); const userId = text(input, "userId"); await enabledUser(userId);
      const member = (await roster()).find(t => t.userId === userId); if (!member) throw new Error("Teammate not found");
      const old = await get<TeamEligibility>(`eligibility:${userId}`);
      if ((old?.version ?? 0) !== Number(input.version ?? 0)) throw new Error("Teammate settings changed. Refresh and try again.");
      const next: TeamEligibility = { userId, name: member.name, email: member.email, enabled: input.enabled !== false, salesperson: input.salesperson === true, champion: input.champion === true,
        frontId: text(input, "frontId") || undefined, dialpadId: text(input, "dialpadId") || undefined };
      if (next.frontId && !/^tea_[a-z0-9]+$/.test(next.frontId)) throw new Error("Invalid Front teammate ID");
      if (next.dialpadId && !/^\d+$/.test(next.dialpadId)) throw new Error("Invalid Dialpad user ID");
      const saved = row("ELIGIBILITY", `eligibility:${userId}`, next, { previous: old });
      await commit([put(saved, old), audit("TEAM", actor, "Assignment eligibility changed", next)]);
      return { ok: true, member: { ...next, version: saved.version } };
    }
    if (op === "saveSettings") {
      requireAdmin(); const value = object(input.config) as unknown as IntegrationConfig;
      value.dialpadNumbers = (value.dialpadNumbers ?? []).map(n => { const phone = normalizePhone(n); if (!phone) throw new Error("Invalid business phone number"); return phone; });
      value.sharedSmsNumber = normalizePhone(value.sharedSmsNumber) ?? "";
      if (value.sharedSmsNumber !== "+15082332261") throw new Error("Prospect texts use the confirmed shared main line (508) 233-2261");
      for (const [id, role] of [[value.defaultSalespersonId ?? value.defaultUserId, "SALESPERSON"], [value.defaultChampionId ?? value.defaultUserId, "CHAMPION"]] as const) {
        if (id) { if (!(await roster()).some(member => member.userId === id)) throw new Error("Choose a current CRM teammate as the default"); await validRole(id, role); }
      }
      if (input.credentials && Object.values(object(input.credentials)).some(v => typeof v === "string" && v.trim())) value.paused = true;
      const credentialFields = Object.entries(object(input.credentials)).filter(([key, value]) => ["frontToken", "frontSigningKey", "dialpadToken", "dialpadSigningKey"].includes(key) && typeof value === "string" && !!value.trim()).map(([key]) => key);
      const saved = await saveConfig(value, false, [audit("SETTINGS", actor, "Integration settings saved", { paused: value.paused, credentialUpdatesRequested: credentialFields })]);
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
      const c = await config(), teamRouting = await get("team-routing");
      const checks = await activationChecks();
      if (checks.some(c => !c.ok)) return { ok: false, error: checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`).join("; ") };
      if (!teamRouting) throw new Error("Complete manager routing before starting delivery");
      const at = c.activatedAt ?? new Date().toISOString();
      const saved = await saveConfig({ ...c, activatedAt: at, paused: false }, true, [check(teamRouting), audit("SETTINGS", actor, "Integration activated after connection checks", { at })]);
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
      const purpose = input.purpose === "CARRIER" ? "CARRIER" : input.purpose === "PROSPECT" ? "PROSPECT" : old?.data.purpose ?? "PROSPECT";
      const context = ["LEAD", "RENEWAL", "SERVICE"].includes(String(input.context)) ? input.context as Communication["context"] : old?.data.context ?? (wf.data.disposition === "BOUND" ? "SERVICE" : "LEAD");
      const policyId = context === "RENEWAL" ? text(input, "policyId") || old?.data.policyId : undefined;
      if (policyId) { const policy = await (await dataClient()).models.Policy.get({ id: policyId }); if (policy.errors?.length || policy.data?.accountId !== accountId) throw new Error("Choose a policy on this account"); }
      if (context === "RENEWAL" && !policyId) throw new Error("Choose the policy this renewal concerns");
      const changed = old?.data.purpose !== purpose || old?.data.context !== context || old?.data.policyId !== policyId;
      const writes = [];
      if (changed) writes.push(put(row("LINK", `front-link:${cnv}`, { accountId, conversationId: cnv, purpose, context, policyId, routing: old?.data.routing === "MANUAL" ? "MANUAL" : (purpose === "CARRIER" || context !== "LEAD" ? "CHAMPION" : "SALESPERSON") }, { accountId, previous: old }), old));
      if (!wf.data.conversationId && purpose === "PROSPECT") writes.push(put(row("WORKFLOW", wf.id, { ...wf.data, conversationId: cnv, version: wf.version + 1 }, { accountId, previous: wf }), wf));
      if (changed) {
        writes.push(put(row("LIFECYCLE", `lifecycle:conversation-context:${cnv}:${old?.version ?? 0}`, { accountId }, { accountId, dueAt: new Date().toISOString() })));
        const handlerId = purpose === "CARRIER" || context !== "LEAD" ? wf.data.championId : wf.data.salespersonId;
        const handler = handlerId ? await get<TeamEligibility>(`eligibility:${handlerId}`) : undefined;
        if (handler?.data.frontId) writes.push(put(operationRow(`op:link-route:${cnv}:${old?.version ?? 0}`, { type: "ASSIGN", accountId, conversationId: cnv, assigneeId: handler.data.frontId })));
      }
      const backfillId = `conversation-backfill:${cnv}`, backfill = await get<HistoryJob>(backfillId);
      if (changed || !backfill || historyStopped(backfill)) writes.push(put(restartHistory(backfillId, cnv, accountId, backfill), backfill));
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
      if (["EVENT", "ISSUE"].includes(old.kind)) requireAdmin();
      if (old.kind === "NOTIFICATION" && old.data.recipient !== actor) throw new Error("This reminder belongs to another teammate");
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
      if (!isLeadSource(fields.leadSource)) throw new Error("Choose a lead source before creating the lead");
      const id = randomUUID(), wf = await defaultWorkflow(id, name);
      if (input.salespersonId || input.championId) {
        const salespersonId = text(input, "salespersonId"), championId = text(input, "championId");
        await validRole(salespersonId, "SALESPERSON"); await validRole(championId, "CHAMPION");
        Object.assign(wf, { salespersonId, championId, assignmentIssue: undefined });
      }
      const account: Input = { name, leadSource: fields.leadSource, stage: "LEAD", type: ["ASSOCIATION", "PERSONAL", "COMMERCIAL_OTHER"].includes(String(fields.type)) ? fields.type : "ASSOCIATION", lastWriteBy: actor };
      for (const field of ["address", "city", "state", "zip", "currentAgent", "currentPolicyExpiration", "notes"]) if (fields[field]) account[field] = text(fields, field, field === "notes" ? 10000 : 500);
      for (const field of ["unitCount", "totalInsuredValue"]) if (fields[field] != null && fields[field] !== "") {
        const value = Number(fields[field]); if (!Number.isFinite(value) || value < 0 || field === "unitCount" && !Number.isInteger(value)) throw new Error("Enter valid units and insured value"); account[field] = value;
      }
      const first = await (await import("./workflow")).makeTask({ id: `task:first:${id}`, accountId: id, kind: "FIRST_CONTACT", title: "Make first contact" });
      try { await commit([put(row("TASK", first.id, first, { accountId: id, dueAt: taskWakeAt(first) })), modelPut("Account", id, account), put(row("WORKFLOW", `workflow:${id}`, wf, { accountId: id })), put(row("MANUAL_REQUEST", key, { accountId: id })), audit(id, actor, "Lead created", { name })]); }
      catch(e) { if (conflict(e)) { const winner = await get<{ accountId: string }>(key); if (winner) return { ok: true, id: winner.data.accountId }; } throw e; }
      return { ok: true, id };
    }
    if (op === "backfill") {
      requireAdmin(); const client = await dataClient();
      // AppSync cursors are opaque and can exceed the text helper's 500-character limit.
      const nextToken = input.nextToken;
      if (nextToken != null && (typeof nextToken !== "string" || nextToken.length > 16_384)) throw new Error("Invalid pagination token. Refresh and try again.");
      const page = await client.models.Account.list({ filter: { stage: { eq: "LEAD" } }, nextToken: nextToken || undefined, limit: 25 });
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
