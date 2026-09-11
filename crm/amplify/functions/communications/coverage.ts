import { businessDeadline, followUpDeadline, scheduleReminders, localHour, taskWakeAt, type LeadTask, type LeadWorkflow, type Communication } from "../../../../shared/leadWorkflow";
import { addCalendarDays, scopeLegacyQuotes, quoteCoverage, quoteMatchesRisk, usableQuote, validCalendarDate, type RiskTerm } from "../../../../shared/renewalPolicy";
import { deliveredServiceResponse } from "../../../../shared/serviceEvidence";
import { authorizedQuoteTerms } from "../../../../shared/quoteAuthorization";
import { taskContext, taskDomain } from "../../../../shared/workRouting";
import { contactAt, contactProgress } from "../../../../shared/contactProgress";
import { dataClient } from "./data";
import { operationRow } from "./outbox";
import type { ConversationLink } from "./events";
import { get, row, save, put, commit, check, issue, hash, type Row } from "./store";
import { accountRows, makeTask, ensureWorkflow } from "./workflow";
import { config } from "./config";
import { resolveIssue, resolveTaskRoute } from "./routing";

type Account = { id: string; name: string; stage?: string | null; currentPolicyExpiration?: string | null; createdAt: string; updatedAt: string };
async function all<T>(fetch: (nextToken?: string) => Promise<{ data: T[]; errors?: unknown[]; nextToken?: string | null }>) {
  const items: T[] = []; let cursor: string | undefined;
  do { const p = await fetch(cursor); if (p.errors?.length) throw new Error("Work coverage could not be verified"); items.push(...p.data); cursor = p.nextToken ?? undefined; } while (cursor);
  return items;
}

/** Project existing business evidence into reminders; never create a second business ledger. */
export async function reconcileAccountWork(account: Account, workflow?: Row<LeadWorkflow>) {
  await (await import("./conversationContext")).repairConversationContexts(account.id);
  let wf = workflow ?? await ensureWorkflow(account.id);
  const client = await dataClient(), c = await config(), now = new Date().toISOString();
  const sourceAccount = await client.models.Account.get({ id: account.id });
  if (sourceAccount.errors?.length || !sourceAccount.data) throw new Error("Could not load this account's coverage");
  const related = sourceAccount.data;
  const [rawQuotes, policies, marketing, priorCoverage, certificates, documents, activity, tasks] = await Promise.all([
    all(token => related.quotes({ nextToken: token, limit: 100 })),
    all(token => related.policies({ nextToken: token, limit: 100 })),
    all(token => client.models.MarketingTask.listMarketingTaskByAccountId({ accountId: account.id }, { nextToken: token, limit: 100 })),
    all(token => related.priorCarriers({ nextToken: token, limit: 100 })),
    all(token => related.certificates({ nextToken: token, limit: 100 })),
    all(token => client.models.Document.listDocumentByEntityId({ entityId: account.id }, { nextToken: token, limit: 100 })),
    accountRows<Communication>(account.id, "COMMUNICATION"), accountRows<LeadTask>(account.id, "TASK"),
  ]);
  const { quotes, ambiguous } = scopeLegacyQuotes(rawQuotes, policies);
  if (ambiguous.length) await issue(`renewal-context:${account.id}`, "Choose which expiring policy the ambiguous renewal quotes replace", account.id); else await resolveIssue(`renewal-context:${account.id}`);
  const pendingLead = quotes.filter(q => ["DRAFT", "SUBMITTED", "QUOTED", "PRESENTED"].includes(q.status) && !q.renewalPolicyId && !policies.some(p => p.quoteId === q.id)).map(q => q.id);
  if (JSON.stringify(wf.data.openLeadQuoteIds ?? []) !== JSON.stringify(pendingLead)) wf = await save(row("WORKFLOW", wf.id, { ...wf.data, openLeadQuoteIds: pendingLead, version: wf.version + 1 }, { accountId: account.id, previous: wf }), wf);
  if (wf.data.disposition === "BOUND" && !pendingLead.length) {
    for (const link of await accountRows<ConversationLink>(account.id, "LINK")) {
      if (link.data.context && link.data.context !== "LEAD") continue;
      const nextRouting = link.data.routing === "MANUAL" ? "MANUAL" : "CHAMPION";
      const operationId = `op:client-handoff:${link.id}:${link.version}`;
      await commit([check(wf), put(row("LINK", link.id, { ...link.data, context: "SERVICE", routing: nextRouting }, { accountId: account.id, previous: link }), link), ...(nextRouting !== "MANUAL" ? [put(operationRow(operationId, { type: "ASSIGN", accountId: account.id, conversationId: link.data.conversationId }))] : [])]);
    }
  }
  const terminal = ["LOST", "DISQUALIFIED"].includes(wf.data.disposition);
  const deferred = !!wf.data.deferredUntil && wf.data.deferredUntil > now;
  if (deferred) for (const m of marketing.filter(m => m.sourceType === "LEAD" && m.status === "OPEN" && m.expirationDate !== wf!.data.deferredExpiration && m.createdAt <= wf!.data.deferredAt!)) {
    const result = await client.models.MarketingTask.update({ id: m.id, status: "COMPLETE", resolution: "SUPERSEDED", completedAt: wf.data.deferredAt, completedBy: "system (recorded next-year decision)" });
    if (result.errors?.length) throw new Error("Could not retire the previous marketing cycle");
  }
  const contacts = activity.map(r => r.data).filter(comm => !!contactProgress(comm));
  const latest = contacts.filter(comm => comm.purpose !== "CARRIER").sort((a,b) => contactAt(b).localeCompare(contactAt(a)))[0];
  const writes = async (task: Row<LeadTask>, data: LeadTask) => commit([check(wf!), put(row("TASK", task.id, { ...data, version: task.version + 1 }, { accountId: account.id, previous: task, dueAt: taskWakeAt(data) }), task)]);
  for (const t of tasks.filter(t => t.data.status === "OPEN")) {
    if (terminal && taskContext(t.data) === "LEAD" && !t.data.custom && t.data.kind !== "BIND") { await writes(t, { ...t.data, status: "CANCELLED", reason: "Lead closed by the team" }); continue; }
    if (deferred && !t.data.custom && ["FIRST_CONTACT", "FOLLOW_UP", "PROSPECT_UPDATE", "SUBMISSION", "QUOTE_TARGET"].includes(t.data.kind) && taskContext(t.data) === "LEAD" && (!t.data.term || t.data.term !== wf.data.deferredExpiration) && (t.data.sourceAt ?? t.createdAt) <= wf.data.deferredAt!) {
      await writes(t, { ...t.data, status: "CANCELLED", reason: "Superseded by the recorded next-year cycle" }); continue;
    }
    if (wf.data.disposition === "BOUND" && taskContext(t.data) === "LEAD" && (!t.data.quoteId || !pendingLead.includes(t.data.quoteId)) && !pendingLead.length) {
      if (!t.data.custom && ["FIRST_CONTACT", "FOLLOW_UP", "PROSPECT_UPDATE", "ANNUAL_RETURN"].includes(t.data.kind)) { await writes(t, { ...t.data, status: "CANCELLED", reason: "Acquisition finished; champion owns client work" }); continue; }
      if (["RESPONSE", "CALLBACK", "DOCUMENTS", "CORRECTION", "SERVICE", "CARRIER", "BIND"].includes(t.data.kind)) await writes(t, { ...t.data, context: "SERVICE", domain: taskDomain(t.data), role: "CHAMPION", accountableRole: "CHAMPION", helperId: undefined });
    }
  }
  for (const task of tasks.filter(t => t.data.status === "OPEN" && ["SERVICE", "DOCUMENTS"].includes(t.data.kind) && t.data.serviceType && t.data.milestone)) {
    const sources = activity.filter(c => task.data.sourceIds?.includes(c.id)).map(c => c.data);
    const delivered = task.data.serviceType === "CERTIFICATE" ? certificates.some(c => c.deliveredAt && task.data.sourceIds?.includes(c.sourceCommunicationId ?? ""))
      : task.data.serviceType === "DOCUMENT" ? documents.some(d => d.deliveredAt && task.data.sourceIds?.includes(d.sourceCommunicationId ?? ""))
      : sources.length > 0 && sources.every(source => contacts.some(c => deliveredServiceResponse(source, c)));
    // Without a separate contractual service deadline, the next coordination
    // touch follows actual progress. The original response task retains its SLA.
    const latestProgress = contacts.filter(c => sources.some(source => c.id !== source.id && c.at > source.at && c.conversationId === source.conversationId && c.direction === "OUTBOUND")).sort((a,b) => b.at.localeCompare(a.at))[0];
    if (!delivered && task.data.kind === "SERVICE" && !task.data.businessDueAt && latestProgress && latestProgress.at > (task.data.serviceProgressAt ?? "")) {
      const next = scheduleReminders({ ...task.data, dueAt: followUpDeadline(latestProgress.at, 2, c.holidays), serviceProgressAt: latestProgress.at, nextReminderAt: undefined, notifiedAt: undefined, escalatedAt: undefined, ownerNotifiedAt: undefined, lastReminderAt: undefined }, c.holidays);
      await writes(task, next);
    }
    if (delivered) await writes(task, { ...task.data, status: "COMPLETE", reason: "Requested service delivered through the actual work" });
  }
  const currentObligations = new Set<string>();
  async function obligation(key: string, input: Parameters<typeof makeTask>[0], done: boolean, evidence?: string) {
    currentObligations.add(key);
    const id = `task:obligation:${account.id}:${hash(key).slice(0, 24)}`, old = await get<LeadTask>(id);
    if (done) { if (old?.data.status === "OPEN") await writes(old, { ...old.data, status: "COMPLETE", reason: evidence ?? "Verified in the business record" }); return; }
    if (old?.data.status === "OPEN") return;
    const t = await makeTask({ ...input, id, obligationKey: key });
    if (t.businessDueAt && t.businessDueAt < t.dueAt) t.shortTimeline = true;
    t.version = (old?.version ?? 0) + 1;
    await commit([check(wf!), put(row("TASK", id, t, { accountId: account.id, previous: old, dueAt: taskWakeAt(t) }), old)]);
  }
  const marketingState = await get(`marketing-context:${account.id}`);
  const waitingOnCarrier = quotes.some(q => q.status === "SUBMITTED") || marketing.some(m => m.status === "OPEN");
  if (marketingState?.data.waitingOnCarrier !== waitingOnCarrier) await save(row("MARKETING_CONTEXT", `marketing-context:${account.id}`, { waitingOnCarrier }, { accountId: account.id, previous: marketingState }), marketingState);
  const incoming = activity.some(r => r.data.direction === "INBOUND" && r.data.classification !== "AUTOMATIC" && !r.data.resolved);
  if (!terminal && wf.data.disposition === "ACTIVE" && !deferred && !latest && !incoming && !tasks.some(t => t.data.status === "OPEN" && t.data.kind === "FIRST_CONTACT") && !await get(`task:first:${account.id}`)) {
    await obligation("first-contact", { accountId: account.id, kind: "FIRST_CONTACT", title: "Make first contact", sourceAt: account.createdAt, domain: "CLIENT", context: "LEAD", conversationId: wf.data.conversationId }, false);
  }
  if (wf.data.deferredUntil && wf.data.deferredExpiration) {
    const annualId = `task:annual:${account.id}:${wf.data.deferredExpiration}`;
    if (!await get(annualId)) {
      const task = await makeTask({ id: annualId, accountId: account.id, kind: "ANNUAL_RETURN", title: "Reconnect before the next renewal", dueAt: wf.data.deferredUntil, sourceAt: wf.data.deferredAt, term: wf.data.deferredExpiration, domain: "CLIENT", context: "LEAD", conversationId: wf.data.conversationId });
      await commit([check(wf), put(row("TASK", annualId, task, { accountId: account.id, dueAt: taskWakeAt(task) }))]);
    }
  }
  const risks: RiskTerm[] = policies.filter(p => p.status === "ACTIVE" && validCalendarDate(p.expirationDate)).map(p => ({ accountId: account.id, policyId: p.id, term: p.expirationDate!, lines: (p.lines ?? []).filter((l): l is string => !!l) }));
  if (!terminal && wf.data.disposition === "ACTIVE" && validCalendarDate(account.currentPolicyExpiration) && !deferred) risks.push({ accountId: account.id, term: account.currentPolicyExpiration, lines: [...new Set([...priorCoverage.filter(p => p.expirationDate === account.currentPolicyExpiration && p.lineOfBusiness).map(p => p.lineOfBusiness!), ...quotes.filter(q => q.effectiveDate === account.currentPolicyExpiration).flatMap(q => (q.lines ?? []).filter((l): l is string => !!l))])] });
  if (wf.data.disposition === "BOUND" && !risks.length) await issue(`policy-handoff:${account.id}`, "Record the bound policy and its expiration so the champion can manage renewal preparation", account.id);
  else await resolveIssue(`policy-handoff:${account.id}`);
  for (const risk of risks) {
    const context = risk.policyId ? "RENEWAL" as const : "LEAD" as const;
    const scope = `${risk.policyId ?? "lead"}:${risk.term}`, source = risk.policyId ? policies.find(p => p.id === risk.policyId)!.createdAt : account.createdAt;
    const dueFor = (day: string) => {
      const target = new Date(localHour(day, 9)).toISOString();
      return target < source ? businessDeadline(source, 1, c.holidays) : target;
    };
    const base = { accountId: account.id, role: "CHAMPION" as const, context, domain: "CARRIER" as const, policyId: risk.policyId, term: risk.term, lines: risk.lines, sourceAt: source, milestone: true };
    const evidence = quoteCoverage(quotes, risk, now);
    const workStarted = quotes.some(q => quoteMatchesRisk(q, risk) && ["SUBMITTED", "QUOTED", "PRESENTED", "BOUND"].includes(q.status))
      || contacts.some(comm => comm.context === "RENEWAL" && comm.policyId === risk.policyId && comm.direction === "OUTBOUND" && contactProgress(comm) === "CONTACT" && contactAt(comm) >= new Date(localHour(addCalendarDays(risk.term, -90), 9)).toISOString());
    if (risk.policyId) await obligation(`renewal-start:${scope}`, { ...base, kind: "RENEWAL_START", title: "Start renewal preparation", dueAt: dueFor(addCalendarDays(risk.term, -90)), businessDueAt: new Date(localHour(addCalendarDays(risk.term, -90), 9)).toISOString() }, workStarted, "Renewal request or carrier submission recorded");
    await obligation(`quote-target:${scope}`, { ...base, kind: "QUOTE_TARGET", title: "Obtain usable quotes before expiration", dueAt: dueFor(addCalendarDays(risk.term, -14)), businessDueAt: new Date(localHour(addCalendarDays(risk.term, -14), 9)).toISOString() }, evidence.complete, "Usable quotes cover the required term and lines");
    const issueKey = `renewal-facts:${account.id}:${scope}`;
    if (!risk.lines.length) await issue(issueKey, "Confirm the coverage lines in the quote or policy so quote readiness can be checked", account.id); else await resolveIssue(issueKey);
    if (risk.term < now.slice(0, 10) && !quotes.some(q => q.status === "BOUND" && quoteMatchesRisk(q, risk))) await issue(`expired-risk:${scope}:${account.id}`, "The prior term has expired without confirmed replacement coverage. The champion must review placement.", account.id);
    for (const m of marketing.filter(m => m.expirationDate === risk.term && (m.policyId ?? undefined) === risk.policyId)) {
      const carrierRisk = { ...risk, carrierId: m.carrierId };
      const submitted = quotes.some(q => quoteMatchesRisk(q, carrierRisk) && ["SUBMITTED", "QUOTED", "PRESENTED", "BOUND"].includes(q.status));
      await obligation(`submission:${m.id}`, { ...base, kind: "SUBMISSION", title: `Submit to ${m.carrierName ?? "carrier"}`, marketingTaskId: m.id, carrierId: m.carrierId, dueAt: dueFor(m.submitBy ?? risk.term), businessDueAt: new Date(localHour(m.submitBy ?? risk.term, 9)).toISOString() }, submitted || m.status === "COMPLETE" && m.resolution !== "QUOTED", "Carrier submission or documented placement decision recorded");
    }
  }
  for (const q of quotes) {
    if (q.bindAuthorizedAt) {
      if (q.bindAuthorizedTerms !== authorizedQuoteTerms(q) && !policies.some(p => p.quoteId === q.id)) await issue(`bind-authorization:${q.id}`, "The quote changed after client authorization. Review the revised terms with the client before binding.", account.id);
      else await resolveIssue(`bind-authorization:${q.id}`);
      const renewal = !!q.renewalPolicyId;
      await obligation(`bind:${q.id}`, { accountId: account.id, quoteId: q.id, policyId: q.renewalPolicyId ?? undefined, kind: "BIND", title: "Obtain carrier bind confirmation", role: "CHAMPION", domain: "CARRIER", context: renewal ? "RENEWAL" : "LEAD", sourceAt: q.bindAuthorizedAt, milestone: true, term: q.effectiveDate ?? undefined,
        dueAt: q.effectiveDate ? [new Date(localHour(q.effectiveDate, 9)).toISOString(), businessDeadline(q.bindAuthorizedAt, 1, c.holidays)].sort()[0] : businessDeadline(q.bindAuthorizedAt, 1, c.holidays), businessDueAt: q.effectiveDate ? new Date(localHour(q.effectiveDate, 9)).toISOString() : undefined },
        policies.some(p => p.quoteId === q.id) || ["DECLINED", "LOST"].includes(q.status), "Confirmed policy or explicit placement decision recorded");
    }
    const risk = { accountId: account.id, term: q.effectiveDate ?? "", policyId: q.renewalPolicyId ?? undefined, lines: (q.lines ?? []).filter((s): s is string => !!s) };
    if (!["QUOTED", "PRESENTED", "BOUND"].includes(q.status) || !usableQuote(q, risk, now)) continue;
    const renewal = !!q.renewalPolicyId;
    await obligation(`presentation:${q.id}`, { accountId: account.id, quoteId: q.id, policyId: q.renewalPolicyId ?? undefined, kind: "QUOTE_PRESENTATION", title: renewal ? "Present the renewal quote" : "Present the quote", role: renewal ? "CHAMPION" : "SALESPERSON", domain: "CLIENT", context: renewal ? "RENEWAL" : "LEAD", sourceAt: q.readyAt ?? q.updatedAt, milestone: true, term: risk.term }, ["PRESENTED", "BOUND"].includes(q.status), "Quote presentation recorded");
  }
  for (const t of tasks) {
    if (t.data.status !== "OPEN" || !t.data.obligationKey || currentObligations.has(t.data.obligationKey)) continue;
    if (/^(quote-target|submission|presentation|renewal-start):/.test(t.data.obligationKey)) {
      const current = await get<LeadTask>(t.id);
      if (current?.data.status === "OPEN") await writes(current, { ...current.data, status: "CANCELLED", reason: "The underlying quote or coverage cycle is no longer current" });
    }
  }
  const probe = await makeTask({ accountId: account.id, title: "Verify team coverage", kind: "FIRST_CONTACT", context: wf.data.disposition === "BOUND" ? "SERVICE" : "LEAD" });
  const route = await resolveTaskRoute(probe, wf.data);
  if (route.gaps.length || wf.data.assignmentIssue) await issue(`coverage:${account.id}`, wf.data.assignmentIssue ?? route.gaps.join(". "), account.id); else await resolveIssue(`coverage:${account.id}`);
  if (!terminal && !deferred && wf.data.disposition === "ACTIVE" && !validCalendarDate(account.currentPolicyExpiration)) await issue(`incumbent-date:${account.id}`, "Record the incumbent expiration to protect marketing and next-year follow-up", account.id); else await resolveIssue(`incumbent-date:${account.id}`);
  const receipt = await get(`coverage:${account.id}`);
  await save(row("COVERAGE", `coverage:${account.id}`, { accountId: account.id, checkedAt: now, workflowVersion: wf.version }, { accountId: account.id, previous: receipt }), receipt);
}

/** Every source account is examined, including those absent from the deadline index. */
export async function coverageSweep() {
  const key = "coverage:census", old = await get<{ cursor?: string; completedAt?: string; cycleAt?: string; count?: number }>(key);
  if (!old?.data.cursor && old?.data.completedAt && Date.now() - Date.parse(old.data.completedAt) < 3600_000) return;
  const client = await dataClient(), page = await client.models.Account.list({ nextToken: old?.data.cursor, limit: 5 });
  if (page.errors?.length) throw new Error("The account coverage check could not finish");
  for (const account of page.data) await reconcileAccountWork(account);
  await save(row("COVERAGE", key, { cursor: page.nextToken, cycleAt: old?.data.cursor ? old.data.cycleAt : new Date().toISOString(), count: (old?.data.cursor ? old.data.count ?? 0 : 0) + page.data.length, completedAt: page.nextToken ? old?.data.completedAt : new Date().toISOString() }, { previous: old }), old);
}
