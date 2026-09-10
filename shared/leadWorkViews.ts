import type { LeadTask } from "./leadWorkflow";

export const LEAD_WORK_VIEWS = ["Needs attention", "Upcoming", "All open"] as const;
export type LeadWorkView = typeof LEAD_WORK_VIEWS[number];
const agencyDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});
export function dueToday(dueAt: string, now: string) {
  return Number.isFinite(Date.parse(dueAt)) && agencyDate.format(new Date(dueAt)) === agencyDate.format(new Date(now));
}
/** Requests need attention immediately; scheduled promises join them on their due date. */
export function needsAttention(task: { kind?: string; dueAt?: string }, now: string) {
  return ["RESPONSE", "CALLBACK", "CARRIER", "CORRECTION"].includes(task.kind ?? "")
    || !task.dueAt || !Number.isFinite(Date.parse(task.dueAt))
    || Date.parse(task.dueAt) <= Date.parse(now) || dueToday(task.dueAt, now);
}
export function workContext(task: Pick<LeadTask, "kind" | "custom">) {
  if (task.kind === "FOLLOW_UP") return task.custom ? "Follow-up" : "Waiting on prospect";
  return { RESPONSE: "Reply needed", CALLBACK: "Return call", CARRIER: "Carrier response", DOCUMENTS: "Documents", CORRECTION: "Delivery needs attention", TRIAGE: "Needs linking" }[task.kind];
}
