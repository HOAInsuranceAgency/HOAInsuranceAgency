import { morningReport, renderMorningReport, type MorningReport } from "../../../../shared/morningReport";
import { reminderWindow, type LeadTask, type LeadWorkflow, type Communication } from "../../../../shared/leadWorkflow";
import { contactAt, contactProgress } from "../../../../shared/contactProgress";
import { taskDomain, taskContext } from "../../../../shared/workRouting";
import { get, query, row, put, save, commit, check, issue, conflict, hash, type Row } from "./store";
import { routing, resolveIssue } from "./routing";
import { team, enabledUser, accountRows } from "./workflow";
import { config } from "./config";
import { front, ProviderError, messageConversation, type FrontMessage } from "./providers";

export const reportDay = (now: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
export async function allRows<T = Record<string, unknown>>(kind: string, index: "work" | "kind" = "kind") {
  const records: Row<T>[] = []; let cursor: string | undefined;
  do { const p = await query<T>(index, kind, cursor); records.push(...p.items); cursor = p.nextToken; } while (cursor);
  return records;
}
export async function reportSnapshot() {
  const [members, settings, taskRows, workflows, health, census, issues, triage] = await Promise.all([
    team(), routing(), allRows<LeadTask>("TASK", "work"), allRows<LeadWorkflow>("WORKFLOW"), get("health:worker"), get("coverage:census"), allRows("ISSUE", "work"), allRows("TRIAGE", "work"),
  ]);
  const warnings: string[] = [];
  if (!health || health.data.lagging || Date.now() - Date.parse(String(health.data.at)) > 300_000) warnings.push("Recent communication processing could not be confirmed.");
  if (!census?.data.completedAt || Date.now() - Date.parse(String(census.data.completedAt)) > 24 * 3600_000) warnings.push("The full account coverage check has not completed recently.");
  if (issues.some(i => ["issue:sync-gap", "issue:reconcile", "issue:provider-auth", "issue:coverage-census"].includes(i.id))) warnings.push("An integration issue needs repair; the work list may be incomplete.");
  return { members, settings, taskRows, workflows, warnings, issues, triage };
}
export async function reportFor(recipientId: string, snapshot?: Awaited<ReturnType<typeof reportSnapshot>>, includeHistory = true): Promise<MorningReport> {
  const s = snapshot ?? await reportSnapshot(), now = new Date().toISOString();
  const report = morningReport({ recipientId, team: s.members, routing: s.settings, tasks: s.taskRows.map(r => r.data), workflows: s.workflows.map(w => w.data), now, health: s.warnings });
  const byId = new Map(s.workflows.map(w => [w.data.accountId, w.data]));
  const isIntake = recipientId === (s.settings.intakeOwnerId ?? s.settings.ownerId), isIntegration = recipientId === (s.settings.integrationOwnerId ?? s.settings.ownerId);
  for (const item of [...s.issues, ...s.triage]) {
    const wf = item.accountId ? byId.get(item.accountId) : undefined;
    const business = /incumbent-date|renewal-facts|renewal-context|expired-risk|policy-handoff|placement|bind-authorization/.test(item.id);
    const assignment = /coverage:|assignment:/.test(item.id);
    const visible = business ? wf?.championId === recipientId || recipientId === s.settings.marketingManagerId
      : assignment ? recipientId === s.settings.ownerId : item.kind === "TRIAGE" || /Link this|Unlinked/.test(String(item.data.message)) ? isIntake : isIntegration;
    if (!visible || item.data.resolved) continue;
    const section = business ? "Your client and carrier work today" : "Assigned exceptions";
    if (!report.sections.includes(section)) report.sections.push(section);
    report.items.push({ id: item.id, accountId: item.accountId, account: wf?.name ?? "Team coverage", title: String(item.data.message ?? "Link this incoming activity to its account"), why: "This gap needs a named person to restore coverage.", next: "Open the record and correct the source information.", responsible: report.name, section, stage: "EXCEPTION", dueAt: typeof item.data.dueAt === "string" ? item.data.dueAt : undefined });
  }
  for (const accountId of includeHistory ? new Set(report.items.flatMap(i => i.accountId ? [i.accountId] : [])) : []) {
    const contacts = (await accountRows<Communication>(accountId, "COMMUNICATION")).map(r => r.data).filter(c => !c.internalReport && c.actorId !== "crm:initial-ai" && !!contactProgress(c)).sort((a,b) => contactAt(b).localeCompare(contactAt(a)));
    for (const item of report.items.filter(i => i.accountId === accountId)) {
      const task = s.taskRows.find(t => t.id === item.id)?.data;
      const contact = contacts.find(c => !task || (c.purpose === "CARRIER" ? "CARRIER" : "CLIENT") === taskDomain(task) && (c.context ?? "LEAD") === taskContext(task) && (!task.policyId || task.policyId === c.policyId));
      item.url = `${process.env.CRM_BASE_URL}/accounts/${accountId}`;
      if (contact) { item.lastOutreach = contactAt(contact); item.lastOutreachKind = contactProgress(contact) === "ATTEMPT" ? "call attempt" : contact.direction === "INBOUND" ? "connected inbound call" : "human outreach"; }
    }
  }
  report.accountCount = new Set(report.items.flatMap(i => i.accountId ? [i.accountId] : [])).size;
  return report;
}

interface Edition { recipientId: string; day: string; state: "READY" | "LEASED" | "ACCEPTED" | "SENT" | "UNKNOWN"; uid?: string; messageId?: string; email?: string; subject?: string; channelId?: string; leaseUntil?: string; error?: string; sentAt?: string }
/** Resolve against Cognito, never a self-editable profile address or client input. */
async function verifiedRecipient(userId: string) {
  const user = await enabledUser(userId);
  const attrs = Object.fromEntries((user.Attributes ?? []).map(a => [a.Name, a.Value]));
  if (attrs.email_verified !== "true" || !attrs.email) throw new Error("Verify this teammate's sign-in email before sending reports");
  const c = await config();
  if (c.environment !== "main" && !c.testRecipients.some(email => email.toLowerCase() === attrs.email!.toLowerCase())) throw new Error("This teammate's email is not an approved staging recipient");
  return attrs.email;
}
export async function verifyReportChannel(channelId: string) {
  const channel = await front<{ id: string; is_valid: boolean; type: string; address?: string; _links?: { related?: { inbox?: string } } }>(`/channels/${channelId}`);
  if (!channel.is_valid || !["smtp", "imap", "google", "gmail", "office365", "outlook", "front_mail"].includes(channel.type)) throw new Error("Connect a verified email channel for internal reports");
  const c = await config(), inbox = channel._links?.related?.inbox?.split("/").pop();
  if (!inbox || [c.frontInboxId, ...c.allowedInboxIds].includes(inbox)) throw new Error("Use an internal reporting inbox separate from the monitored lead inboxes");
}
async function confirmEdition(edition: Row<Edition>) {
  if (!edition.data.uid) return;
  const message = await front<FrontMessage & { error_type?: string }>(`/messages/alt:uid:${encodeURIComponent(edition.data.uid)}`);
  if (message.error_type) throw new Error("Front could not deliver the morning report");
  if (!message.id || message.is_draft !== false) return;
  const next = { ...edition.data, state: "SENT" as const, messageId: message.id, sentAt: new Date().toISOString(), error: undefined };
  const conversationId = messageConversation(message);
  const link = conversationId ? await get(`report-conversation:${conversationId}`) : undefined;
  await commit([put(row("REPORT_EDITION", edition.id, next, { previous: edition }), edition), ...(conversationId ? [put(row("REPORT_CONVERSATION", `report-conversation:${conversationId}`, { editionId: edition.id }, { previous: link }), link)] : [])]);
  await resolveIssue(edition.id);
}
export const handler = async () => {
  const now = new Date().toISOString(), c = await config();
  // Accepted sends can be reconciled outside 9am; new sends cannot.
  for (const edition of await allRows<Edition>("REPORT_EDITION", "work")) if (edition.data.state === "ACCEPTED") {
    try { await confirmEdition(edition); } catch (e) { await issue(edition.id, e instanceof Error ? e.message : "Morning report delivery needs review"); }
  }
  const priorHealth = await get<{ day: string; recipients?: string[]; incomplete?: boolean }>("health:reports");
  if (priorHealth?.data.day === reportDay(now) && priorHealth.data.recipients) {
    const incomplete = (await Promise.all(priorHealth.data.recipients.map(id => get<Edition>(`report:${c.environment}:${reportDay(now)}:${id}`)))).some(r => r?.data.state !== "SENT");
    if (incomplete !== priorHealth.data.incomplete) await save(row("HEALTH", "health:reports", { ...priorHealth.data, incomplete, at: now }, { previous: priorHealth }), priorHealth);
  }
  if (!reminderWindow(now, c.holidays) || c.paused || !c.activatedAt) return;
  const snapshot = await reportSnapshot(), settings = await get("team-routing");
  if (!settings || !snapshot.settings.reportChannelId) { await issue("report-setup", "Choose the internal report channel and team managers before morning delivery"); return; }
  const start = Date.now();
  for (const member of snapshot.members.filter(m => m.enabled)) {
    if (Date.now() - start > 90_000 || !reminderWindow(new Date().toISOString(), c.holidays)) break;
    const day = reportDay(now), id = `report:${c.environment}:${day}:${member.userId}`;
    let edition = await get<Edition>(id);
    if (edition && ["SENT", "UNKNOWN", "ACCEPTED"].includes(edition.data.state)) continue;
    if (edition?.data.state === "LEASED") {
      if (edition.data.leaseUntil! > now) continue;
      await save(row("REPORT_EDITION", id, { ...edition.data, state: "UNKNOWN", error: "The send result was interrupted; review before retrying" }, { previous: edition }), edition);
      await issue(id, "Morning report delivery is uncertain. Check Front before retrying."); continue;
    }
    let posted = false, acceptedUid: string | undefined;
    try {
      const report = await reportFor(member.userId, snapshot);
      if (!report.daily && !report.items.length && !(member.userId === snapshot.settings.ownerId && report.health.length)) continue;
      const email = await verifiedRecipient(member.userId);
      await verifyReportChannel(snapshot.settings.reportChannelId);
      const content = renderMorningReport(report, process.env.CRM_BASE_URL!);
      const body = `${content.html}<!-- hoa-report:${hash(id)} -->`;
      const data: Edition = { recipientId: member.userId, day, state: "LEASED", email, channelId: snapshot.settings.reportChannelId, subject: `${content.title} — ${day}`, leaseUntil: new Date(Date.now() + 180_000).toISOString() };
      const next = row("REPORT_EDITION", id, data, { previous: edition });
      const currentMember = await get(`eligibility:${member.userId}`);
      const checks = [];
      for (const item of report.items.slice(0, 20)) {
        const source = await get(item.id);
        if (source?.kind === "TASK" && source.data.status !== "OPEN" || source?.data.resolved) throw new Error("Work changed; refresh the morning edition before sending");
        if (source) checks.push(check(source));
      }
      await commit([put(next, edition), check(settings), ...(currentMember ? [check(currentMember)] : []), ...checks]); edition = next;
      posted = true;
      const result = await front<{ message_uid?: string }>(`/channels/${snapshot.settings.reportChannelId}/messages`, "POST", { to: [email], cc: [], bcc: [], sender_name: "HOA CRM", subject: data.subject, body, text: content.text, should_add_default_signature: false, signature_id: null, options: { archive: true } });
      acceptedUid = result.message_uid;
      if (!result.message_uid) throw new Error("Front accepted the report without returning its receipt");
      await save(row("REPORT_EDITION", id, { ...data, state: "ACCEPTED", uid: result.message_uid }, { previous: edition }), edition);
      await resolveIssue("report-setup");
    } catch (e) {
      if (conflict(e) && !posted) continue;
      const current = await get<Edition>(id), error = e instanceof Error ? e.message : "Morning report delivery needs review";
      const uncertain = posted && (!(e instanceof ProviderError) || e.uncertain);
      if (!current || current.data.state !== "ACCEPTED") await save(row("REPORT_EDITION", id, { ...(current?.data ?? { recipientId: member.userId, day }), state: acceptedUid ? "ACCEPTED" : uncertain ? "UNKNOWN" : "READY", uid: acceptedUid ?? current?.data.uid, error }, { previous: current }), current);
      await issue(id, error);
    }
  }
  const expected: string[] = [];
  for (const member of snapshot.members.filter(m => m.enabled)) {
    const r = await reportFor(member.userId, snapshot, false);
    if (r.daily || r.items.length || member.userId === snapshot.settings.ownerId && r.health.length || await get(`report:${c.environment}:${reportDay(now)}:${member.userId}`)) expected.push(member.userId);
  }
  const incomplete = (await Promise.all(expected.map(id => get<Edition>(`report:${c.environment}:${reportDay(now)}:${id}`)))).some(r => r?.data.state !== "SENT");
  const health = await get("health:reports");
  await save(row("HEALTH", "health:reports", { day: reportDay(now), at: new Date().toISOString(), expected: expected.length, recipients: expected, incomplete }, { previous: health }), health);

};

/** Recovery accepts provider proof of the exact internal email, never an unchecked retry. */
export async function recoverEdition(id: string, messageId: string) {
  const edition = await get<Edition>(id);
  if (!edition || !["UNKNOWN", "ACCEPTED", "LEASED"].includes(edition.data.state)) throw new Error("Choose an uncertain report edition");
  if (!/^msg_[a-z0-9]+$/.test(messageId)) throw new Error("Choose the sent Front message");
  const m = await front<FrontMessage>(`/messages/${messageId}`);
  const recipients = m.recipients?.filter(r => r.role === "to").map(r => r.handle.toLowerCase()) ?? [];
  if (m.is_inbound || m.is_draft !== false || m.subject !== edition.data.subject || recipients.length !== 1 || recipients[0] !== edition.data.email?.toLowerCase()) throw new Error("This message does not match the report recipient and edition");
  const marker = `hoa-report:${hash(id)}`;
  if (!m.body?.includes(marker) || !messageConversation(m)) throw new Error("The original report receipt could not be verified");
  const linkId = `report-conversation:${messageConversation(m)}`, link = await get(linkId);
  await commit([put(row("REPORT_EDITION", id, { ...edition.data, state: "SENT", messageId: m.id, sentAt: new Date(m.created_at * 1000).toISOString(), error: undefined }, { previous: edition }), edition), put(row("REPORT_CONVERSATION", linkId, { editionId: id }, { previous: link }), link)]);
  await resolveIssue(id);
}
