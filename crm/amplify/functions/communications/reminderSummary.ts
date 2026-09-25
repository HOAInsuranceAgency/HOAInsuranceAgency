import type { Communication, LeadTask, LeadWorkflow, Responsibility } from "../../../../shared/leadWorkflow";
import { morningReminderAt } from "../../../../shared/leadWorkflow";
import { agencyDay, leadActionGuidance, workLink } from "../../../../shared/leadActionGuidance";
import { contactAt, contactProgress } from "../../../../shared/contactProgress";
import { accountableRole, taskContext, taskDomain } from "../../../../shared/workRouting";
import { reportPriority } from "../../../../shared/morningReport";
import { accountRows } from "./workflow";
import { resolveTaskRoute } from "./routing";
import { get, type Row } from "./store";

export interface ReminderGroup { day: string; role: Responsibility; recipientId: string; accountableId?: string; anchorTaskId: string }
export function reminderRecipient(task: LeadTask, route: Awaited<ReturnType<typeof resolveTaskRoute>>, now: string) {
  const manager = task.escalationAt <= now && route.managerId !== route.accountableId;
  const owner = !!task.ownerEscalationAt && task.ownerEscalationAt <= now && route.ownerId !== route.accountableId;
  return owner ? route.ownerId : manager ? route.managerId : route.recipientId;
}
/** Render from fresh records at delivery, so an answered item cannot survive in a queued summary. */
export async function reminderSummary(group: ReminderGroup, wf: Row<LeadWorkflow>, conversationId: string, now: string, restrictTo?: string[]) {
  const indexed = await accountRows<LeadTask>(wf.data.accountId, "TASK");
  const ids = restrictTo ?? [...new Set([...indexed.map(r => r.id), group.anchorTaskId])];
  const tasks = (await Promise.all(ids.map(id => get<LeadTask>(id)))).filter((r): r is Row<LeadTask> => !!r && r.kind === "TASK" && r.accountId === wf.data.accountId);
  const matches: Row<LeadTask>[] = [];
  const routes = new Map<string, Awaited<ReturnType<typeof resolveTaskRoute>>>();
  for (const r of tasks) {
    const t = r.data;
    if (t.status !== "OPEN" || accountableRole(t) !== group.role || (t.conversationId ?? wf.data.conversationId) !== conversationId) continue;
    if (wf.data.disposition === "BOUND" && taskContext(t) === "LEAD" && !wf.data.openLeadQuoteIds?.length) continue;
    if (["LOST", "DISQUALIFIED"].includes(wf.data.disposition) && taskContext(t) === "LEAD" && !t.custom && t.kind !== "BIND") continue;
    if ((t.reminderAt ?? morningReminderAt(t.dueAt)) > now && (!t.blocker || t.blocker.reviewAt > now)) continue;
    const route = await resolveTaskRoute(t, wf.data);
    if (route.accountableId !== group.accountableId || reminderRecipient(t, route, now) !== group.recipientId) continue;
    matches.push(r); routes.set(r.id, route);
  }
  matches.sort((a,b) => reportPriority({ ...a.data, account: wf.data.name, why: "", next: "", responsible: "", section: "", stage: "DUE" }, now) - reportPriority({ ...b.data, account: wf.data.name, why: "", next: "", responsible: "", section: "", stage: "DUE" }, now) || a.data.dueAt.localeCompare(b.data.dueAt));
  // Bound the explanation and its transaction checks; all other tasks remain independently tracked.
  const shown = matches.slice(0, 20);
  const activity = (await accountRows<Communication>(wf.data.accountId, "COMMUNICATION")).map(r => r.data);
  const date = (at: string) => new Date(at).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const paragraphs: string[] = [];
  for (const r of shown) {
    const t = r.data, route = routes.get(r.id)!;
    const guidance = leadActionGuidance(t, activity, t.escalationAt <= now && route.managerId !== route.accountableId, now);
    const member = await get<{ name: string }>(`eligibility:${route.recipientId}`);
    const last = activity.filter(c => !c.internalReport && c.actorId !== "crm:initial-ai" && contactProgress(c) && (c.domain ?? (c.purpose === "CARRIER" ? "CARRIER" : "CLIENT")) === taskDomain(t) && (c.context ?? "LEAD") === taskContext(t) && (!t.policyId || c.policyId === t.policyId)).sort((a,b) => contactAt(b).localeCompare(contactAt(a)))[0];
    const link = workLink(t), url = link.path.startsWith("/") ? `${process.env.CRM_BASE_URL}${link.path}` : link.path;
    const blockerOwner = t.blocker ? await get<{ name: string }>(`eligibility:${t.blocker.ownerId}`) : undefined;
    if (paragraphs.length) {
      paragraphs.push(`• ${t.title} · Due ${date(t.dueAt)} Eastern · ${member?.data.name ?? "Needs assignment"}${t.blocker ? `\n  Blocked: ${t.blocker.reason}. ${blockerOwner?.data.name ?? "Needs assignment"} reviews ${date(t.blocker.reviewAt)} Eastern.` : ""}`);
      continue;
    }
    paragraphs.push(`Next step: ${guidance.action}${guidance.action !== t.title ? `\nWork: ${t.title}` : ""}\nWhy this is back: ${guidance.why}\nResponsible: ${member?.data.name ?? "Needs assignment"} · ${group.role === "SALESPERSON" ? "Salesperson" : "Deal champion"}\nDue: ${agencyDay(t.dueAt) === agencyDay(now) ? "Today" : date(t.dueAt)} Eastern${t.term ? `\nRequired coverage date: ${t.term}` : ""}${last ? `\nLast ${contactProgress(last) === "ATTEMPT" ? "call attempt" : "contact"}: ${date(contactAt(last))} Eastern` : "\nLast contact: not available in linked CRM history."}${guidance.preview ? `\nOriginal request: ${guidance.preview}` : ""}${t.blocker ? `\nBlocker owner: ${blockerOwner?.data.name ?? "Needs assignment"} · Review ${date(t.blocker.reviewAt)} Eastern` : ""}\n${guidance.after}\n${link.label}: ${url}`);
  }
  return { tasks: shown, text: `9 a.m. work reminder — ${wf.data.name}\n${group.role === "SALESPERSON" ? "Sales" : "Client and carrier work"} · ${matches.length} action${matches.length === 1 ? "" : "s"}\n\n${paragraphs[0] ?? ""}${paragraphs.length > 1 ? `\n\nOther work still due\n${paragraphs.slice(1).join("\n")}` : ""}${matches.length > shown.length ? `\n\n${matches.length - shown.length} more actions remain tracked in the CRM.` : ""}` };
}
