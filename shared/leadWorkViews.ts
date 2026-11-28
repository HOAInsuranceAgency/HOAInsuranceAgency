import { agencyDay } from './agencyTime';
export function dueToday(dueAt: string, now: string) {
  return Number.isFinite(Date.parse(dueAt)) && agencyDay(dueAt) === agencyDay(now);
}
/** Requests need attention immediately; scheduled promises join them on their due date. */
export function needsAttention(task: { kind?: string; dueAt?: string; blocker?: { reviewAt: string } }, now: string) {
  return !!task.blocker && (task.blocker.reviewAt <= now || dueToday(task.blocker.reviewAt, now)) || ["RESPONSE", "CALLBACK", "CARRIER", "CORRECTION"].includes(task.kind ?? "")
    || !task.dueAt || !Number.isFinite(Date.parse(task.dueAt))
    || Date.parse(task.dueAt) <= Date.parse(now) || dueToday(task.dueAt, now);
}
