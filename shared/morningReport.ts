import type { LeadTask, LeadWorkflow, TeamEligibility, TeamRouting } from "./leadWorkflow";
import { taskRoute, taskContext, taskDomain } from "./workRouting";
import { leadActionGuidance, agencyDay, canTakeResponse, workLink } from "./leadActionGuidance";
import { needsAttention } from "./leadWorkViews";

export interface ReportItem {
  id: string; accountId?: string; account: string; title: string; why: string; next: string; dueAt?: string;
  taskVersion?: number; responsible: string; section: string; stage: "DUE" | "MANAGER" | "OWNER" | "EXCEPTION";
  lastOutreach?: string; lastOutreachKind?: string; url?: string;
  kind?: LeadTask["kind"]; term?: string; role?: string; canTakeResponse?: boolean; linkLabel?: string;
  group?: "Sales" | "Client and carrier" | "Setup and data";
  verifiedEscalation?: boolean; blockerOwner?: string; blockerReviewAt?: string;
}
export interface MorningReport {
  recipientId: string; name: string; asOf: string; sections: string[]; items: ReportItem[];
  complete: boolean; health: string[]; daily: boolean; accountCount: number;
  teamCounts: { name: string; due: number; overdue: number }[];
}
export function morningReport(input: { recipientId: string; team: TeamEligibility[]; routing: TeamRouting; workflows: LeadWorkflow[]; tasks: LeadTask[]; now: string; health: string[] }): MorningReport {
  const { recipientId, team, routing, now } = input;
  const member = team.find(m => m.userId === recipientId), settings = routing.members.find(m => m.userId === recipientId);
  const workflows = new Map(input.workflows.map(w => [w.accountId, w]));
  const sections = new Set<string>(), items = new Map<string, ReportItem>();
  const counts = new Map<string, { name: string; due: number; overdue: number }>();
  const daily = !!member?.salesperson || !!settings?.salesManager;
  if (member?.salesperson) sections.add("Your leads today");
  if (settings?.salesManager) {
    sections.add("Your sales team today");
    for (const report of routing.members.filter(m => m.salesManagerId === recipientId)) counts.set(report.userId, { name: team.find(m => m.userId === report.userId)?.name ?? "Teammate", due: 0, overdue: 0 });
  }
  for (const task of input.tasks) {
    if (task.status !== "OPEN") continue;
    const wf = workflows.get(task.accountId); if (!wf) continue;
    const route = taskRoute(task, wf, routing, team, now);
    const attention = needsAttention(task, now);
    const manager = task.escalationAt <= now, owner = !!task.ownerEscalationAt && task.ownerEscalationAt <= now;
    const sales = taskContext(task) === "LEAD" && taskDomain(task) === "CLIENT";
    const count = route.accountableId ? counts.get(route.accountableId) : undefined;
    if (sales && count && attention) { count.due++; if (task.dueAt < now) count.overdue++; }
    let section = "", stage: ReportItem["stage"] = "DUE";
    if ((route.recipientId === recipientId || task.specialistId && route.accountableId === recipientId) && attention) section = sales ? task.helperReason === "SALES_ASSIST" ? "Prospect help requested" : "Your leads today" : "Your client and carrier work today";
    if (route.managerId === recipientId && manager && route.accountableId !== recipientId) { section = sales ? "Your sales team today" : "Marketing and client-service exceptions"; stage = "MANAGER"; }
    if (route.ownerId === recipientId && owner && route.accountableId !== recipientId) { section = "Needs your attention"; stage = "OWNER"; }
    if (!section) continue;
    const guidance = leadActionGuidance(task, [], stage !== "DUE", now), link = workLink(task);
    if (stage === "OWNER" && !task.blocker) guidance.why = `Manager intervention is overdue. Help the responsible team resolve this work. ${leadActionGuidance(task, [], false, now).why}`;
    sections.add(section);
    items.set(task.id, { id: task.id, taskVersion: task.version, accountId: task.accountId, account: wf.name, title: guidance.action, why: guidance.why, next: guidance.after, dueAt: task.dueAt,
      responsible: team.find(m => m.userId === route.recipientId)?.name ?? "Needs assignment", section, stage,
      kind: task.kind, term: task.term, role: task.blocker ? "Blocker owner" : route.role === "SALESPERSON" ? "Salesperson" : "Deal champion", group: sales ? "Sales" : "Client and carrier",
      verifiedEscalation: stage === "OWNER" ? !!task.escalatedAt : stage === "MANAGER" ? !!task.notifiedAt : false,
      canTakeResponse: canTakeResponse(task), url: link.path, linkLabel: link.label,
      blockerOwner: task.blocker ? team.find(m => m.userId === task.blocker!.ownerId)?.name ?? "Needs assignment" : undefined, blockerReviewAt: task.blocker?.reviewAt });
  }
  const list = prioritizeReportItems([...items.values()], now);
  return { recipientId, name: member?.name ?? "Team", asOf: now, daily, sections: [...sections], items: list, complete: !input.health.length, health: input.health,
    accountCount: new Set(list.map(i => i.accountId)).size, teamCounts: [...counts.values()] };
}

export function reportPriority(item: ReportItem, now: string) {
  if (item.group === "Setup and data") return 5;
  if (["RESPONSE", "CALLBACK", "CORRECTION", "CARRIER", "BIND"].includes(item.kind ?? "")) return 0;
  const days = item.term ? (Date.parse(item.term) - Date.parse(agencyDay(now))) / 86400_000 : Infinity;
  if (days <= 14) return 1;
  if (item.verifiedEscalation) return 2;
  return item.kind === "FIRST_CONTACT" ? 3 : 4;
}
export function prioritizeReportItems(items: ReportItem[], now: string) {
  return [...items].sort((a,b) => reportPriority(a, now) - reportPriority(b, now) || (a.dueAt ?? "").localeCompare(b.dueAt ?? "") || a.id.localeCompare(b.id));
}
export const reportGroup = (i: ReportItem) => i.group ?? (i.stage === "EXCEPTION" ? "Setup and data" : "Sales");
/** Reserve space for both business roles; one old account cannot fill the email. */
export function selectReportItems(report: MorningReport, limit = 20) {
  const sorted = prioritizeReportItems(report.items, report.asOf), picked: ReportItem[] = [];
  const queues = ["Sales", "Client and carrier"].map(g => sorted.filter(i => reportGroup(i) === g));
  for (const queue of queues) {
    const seen = new Set<string>();
    for (const i of queue) if (!seen.has(i.accountId ?? i.id) && seen.size < Math.floor(limit / 3)) { picked.push(i); seen.add(i.accountId ?? i.id); }
  }
  for (const unique of [true, false]) for (const i of sorted.filter(i => reportGroup(i) !== "Setup and data")) {
    if (picked.length >= limit) break;
    if (!picked.includes(i) && (!unique || !picked.some(p => p.accountId === i.accountId && reportGroup(p) === reportGroup(i)))) picked.push(i);
  }
  // Administrative issues have a separate count/link, never displacing client work.
  for (const i of sorted.filter(i => reportGroup(i) === "Setup and data")) if (picked.length < limit) picked.push(i);
  return prioritizeReportItems(picked, report.asOf);
}

const escape = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const easternTime = (v: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(v));
export function renderMorningReport(report: MorningReport, baseUrl: string) {
  const title = report.sections.length === 1 ? report.sections[0] : "Your work today";
  const list = selectReportItems(report), url = `${baseUrl}/lead-work?report=mine`;
  const intro = report.complete ? report.items.length ? `${report.accountCount} account${report.accountCount === 1 ? "" : "s"} · ${report.items.length} action${report.items.length === 1 ? "" : "s"}` : "No work needs attention this morning." : "Some activity could not be verified. Review the setup and data section.";
  const groups = ["Sales", "Client and carrier", "Setup and data"].map(name => ({ name, total: report.items.filter(i => reportGroup(i) === name).length, items: list.filter(i => reportGroup(i) === name) })).filter(g => g.total);
  const href = (i: ReportItem) => i.url?.startsWith("/") ? `${baseUrl}${i.url}` : i.url ?? url;
  const details = (i: ReportItem) => `${i.role ? `${i.role}: ` : ""}${i.responsible}${i.stage === "MANAGER" ? " · Manager help needed" : i.stage === "OWNER" ? " · Owner help needed" : ""}`;
  const text = `${title}\n${easternTime(report.asOf)} Eastern\n\n${intro}\n${report.health.join("\n")}\n${report.teamCounts.map(c => `${c.name}: ${c.due} need attention · ${c.overdue} overdue`).join("\n")}\n\n${groups.map(g => `${g.name} — ${g.total} action${g.total === 1 ? "" : "s"}\n\n${g.items.map(i => `${i.account} — ${i.title}\n${details(i)}${i.dueAt ? ` · Due ${easternTime(i.dueAt)} Eastern` : ""}\n${i.why}\n${i.lastOutreach ? `Last ${i.lastOutreachKind ?? "outreach"}: ${easternTime(i.lastOutreach)} Eastern\n` : ""}${i.blockerOwner ? `Blocker owner: ${i.blockerOwner} · Review ${easternTime(i.blockerReviewAt!)} Eastern\n` : ""}${i.next}\n${href(i)}`).join("\n\n")}`).join("\n\n")}\n\n${report.items.length > list.length ? `And ${report.items.length - list.length} more actions. ` : ""}View the current list and download: ${url}\nYour actual emails, calls and business records update this list automatically.`;
  const html = `<div style="background:#f3f5f8;padding:24px;font:15px/1.55 Arial,sans-serif;color:#142d4e"><div style="max-width:640px;margin:auto;background:white;border:1px solid #dce3ed;border-radius:12px;padding:28px"><p style="color:#66768b;font-size:11px;letter-spacing:1.5px">HOA INSURANCE AGENCY</p><h1 style="font-size:25px;margin:10px 0">${escape(title)}</h1><p>${escape(intro)}</p><p style="color:#66768b;font-size:12px">As of ${escape(easternTime(report.asOf))} Eastern</p>${report.health.map(h => `<p style="padding:12px;background:#fff4dd">${escape(h)}</p>`).join("")}${report.teamCounts.length ? `<table style="width:100%;border-collapse:collapse">${report.teamCounts.map(c => `<tr><td style="padding:8px">${escape(c.name)}</td><td>${c.due} need attention · ${c.overdue} overdue</td></tr>`).join("")}</table>` : ""}${groups.map(g => `<h2 style="font-size:19px;padding:10px;background:#edf2f7;margin-top:24px">${escape(g.name)} <span style="font-size:13px;font-weight:normal">· ${g.total} action${g.total === 1 ? "" : "s"}</span></h2>${g.items.map((i, index) => g.items.slice(0, index).some(prior => prior.accountId && prior.accountId === i.accountId) ? `<div style="border-bottom:1px solid #dce3ed;padding:10px 0"><p style="margin:0"><b>${escape(i.account)} — ${escape(i.title)}</b></p><p style="font-size:12px;margin:5px 0">${escape(details(i))}${i.dueAt ? ` · Due ${escape(easternTime(i.dueAt))} Eastern` : ""}</p>${i.blockerOwner ? `<p>Blocker owner: ${escape(i.blockerOwner)} · Review ${escape(easternTime(i.blockerReviewAt!))} Eastern</p>` : ""}<a href="${escape(href(i))}" style="color:#1764a7">${escape(i.linkLabel ?? "Open the work")} →</a></div>` : `<div style="border-bottom:1px solid #dce3ed;padding:14px 0"><p style="color:#66768b;font-size:12px;margin:0">${escape(details(i))}</p><h3 style="font-size:17px;margin:5px 0">${escape(i.account)}</h3><p style="margin:5px 0"><b>${escape(i.title)}</b></p><p style="margin:5px 0">${escape(i.why)}</p>${i.lastOutreach ? `<p style="font-size:12px;color:#66768b">Last ${escape(i.lastOutreachKind ?? "outreach")}: ${escape(easternTime(i.lastOutreach))} Eastern</p>` : ""}${i.blockerOwner ? `<p style="font-size:12px">Blocker owner: ${escape(i.blockerOwner)} · Review ${escape(easternTime(i.blockerReviewAt!))} Eastern</p>` : ""}${i.dueAt ? `<p style="font-size:12px">Due ${escape(easternTime(i.dueAt))} Eastern</p>` : ""}<p>${escape(i.next)}</p><a style="color:#1764a7" href="${escape(href(i))}">${escape(i.linkLabel ?? "Open the work")} →</a></div>`).join("")}${g.total > g.items.length ? `<p>${g.total - g.items.length} more in <a href="${escape(url)}">${escape(g.name.toLowerCase())}</a>.</p>` : ""}`).join("")}${report.items.length > list.length ? `<p>And ${report.items.length - list.length} more actions in your current list.</p>` : ""}<p><a style="display:inline-block;background:#142d4e;color:white;text-decoration:none;border-radius:6px;padding:11px 16px" href="${escape(url)}">View my work</a></p><p style="font-size:12px;color:#66768b">Your actual emails, calls and business records update this list automatically. No report acknowledgement is needed.</p></div></div>`;
  return { title, text, html };
}
