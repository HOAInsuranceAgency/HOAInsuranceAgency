import type { LeadTask, LeadWorkflow, TeamEligibility, TeamRouting } from "./leadWorkflow";
import { taskRoute, taskContext, taskDomain } from "./workRouting";
import { leadActionGuidance } from "./leadActionGuidance";
import { needsAttention } from "./leadWorkViews";

export interface ReportItem {
  id: string; accountId?: string; account: string; title: string; why: string; next: string; dueAt?: string;
  taskVersion?: number; responsible: string; section: string; stage: "DUE" | "MANAGER" | "OWNER" | "EXCEPTION";
  lastOutreach?: string; lastOutreachKind?: string; url?: string;
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
    const guidance = leadActionGuidance(task, [], stage !== "DUE");
    if (stage === "OWNER") guidance.why = `This work is still unresolved after the manager's recovery day. Your help is needed to restore coverage. ${leadActionGuidance(task, [], false).why}`;
    sections.add(section);
    items.set(task.id, { id: task.id, taskVersion: task.version, accountId: task.accountId, account: wf.name, title: guidance.action, why: guidance.why, next: guidance.after, dueAt: task.dueAt,
      responsible: team.find(m => m.userId === route.recipientId)?.name ?? "Needs coverage", section, stage });
  }
  const list = [...items.values()].sort((a,b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
  return { recipientId, name: member?.name ?? "Team", asOf: now, daily, sections: [...sections], items: list, complete: !input.health.length, health: input.health,
    accountCount: new Set(list.map(i => i.accountId)).size, teamCounts: [...counts.values()] };
}

const escape = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const easternTime = (v: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(v));
export function renderMorningReport(report: MorningReport, baseUrl: string) {
  const title = report.sections.length === 1 ? report.sections[0] : "Your work today";
  const list = report.items.slice(0, 20);
  const intro = report.complete ? report.items.length ? `${report.accountCount} account${report.accountCount === 1 ? "" : "s"} · ${report.items.length} action${report.items.length === 1 ? "" : "s"}` : "No work needs attention this morning." : "Some activity could not be verified. Check the coverage issues below.";
  const url = `${baseUrl}/lead-work?report=mine`;
  const text = `${title}\n${easternTime(report.asOf)} Eastern\n\n${intro}\n${report.health.join("\n")}\n${report.teamCounts.map(c => `${c.name}: ${c.due} need attention · ${c.overdue} overdue`).join("\n")}\n\n${list.map(i => `${i.section}\n${i.account} — ${i.title}\n${i.responsible}${i.dueAt ? ` · Due ${easternTime(i.dueAt)} Eastern` : ""}\n${i.why}\n${i.lastOutreach ? `Last ${i.lastOutreachKind ?? "outreach"}: ${easternTime(i.lastOutreach)} Eastern\n` : ""}${i.next}\n${i.url ?? url}`).join("\n\n")}\n\n${report.items.length > list.length ? `And ${report.items.length - list.length} more. ` : ""}View the current list and download: ${url}\nYour actual emails, calls and business records update this list automatically.`;
  const html = `<div style="background:#f3f5f8;padding:24px;font:15px/1.55 Arial,sans-serif;color:#142d4e"><div style="max-width:640px;margin:auto;background:white;border:1px solid #dce3ed;border-radius:12px;padding:28px"><p style="color:#66768b;font-size:11px;letter-spacing:1.5px">HOA INSURANCE AGENCY</p><h1 style="font-size:25px;margin:10px 0">${escape(title)}</h1><p>${escape(intro)}</p><p style="color:#66768b;font-size:12px">As of ${escape(easternTime(report.asOf))} Eastern</p>${report.health.map(h => `<p style="padding:12px;background:#fff4dd">${escape(h)}</p>`).join("")}${report.teamCounts.length ? `<table style="width:100%;border-collapse:collapse">${report.teamCounts.map(c => `<tr><td style="padding:8px">${escape(c.name)}</td><td>${c.due} need attention · ${c.overdue} overdue</td></tr>`).join("")}</table>` : ""}${list.map(i => `<div style="border-top:1px solid #dce3ed;padding:18px 0"><p style="color:#66768b;font-size:12px;margin:0">${escape(i.section)} · ${escape(i.responsible)}</p><h2 style="font-size:17px;margin:5px 0">${escape(i.account)}</h2><p style="margin:5px 0"><b>${escape(i.title)}</b></p><p style="margin:5px 0">${escape(i.why)}</p>${i.lastOutreach ? `<p style="font-size:12px;color:#66768b">Last ${escape(i.lastOutreachKind ?? "outreach")}: ${escape(easternTime(i.lastOutreach))} Eastern</p>` : ""}${i.dueAt ? `<p style="font-size:12px">Due ${escape(easternTime(i.dueAt))} Eastern</p>` : ""}<a style="color:#1764a7" href="${escape(i.url ?? url)}">Open the work →</a></div>`).join("")}${report.items.length > list.length ? `<p>And ${report.items.length - list.length} more actions in your current list.</p>` : ""}<p><a style="display:inline-block;background:#142d4e;color:white;text-decoration:none;border-radius:6px;padding:11px 16px" href="${escape(url)}">View my work</a></p><p style="font-size:12px;color:#66768b">Your actual emails, calls and business records update this list automatically. No report acknowledgement is needed.</p></div></div>`;
  return { title, text, html };
}
