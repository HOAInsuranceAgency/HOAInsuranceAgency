import { BLOCKER_REASONS, canRecordBlocker } from "../../../../shared/workBlocker";
import { followUpDeadline, morningReminderAt, taskWakeAt, type LeadTask } from "../../../../shared/leadWorkflow";
import { get, row, put, check, commit, audit } from "./store";
import { config } from "./config";
import { enabledUser, ensureWorkflow, team } from "./workflow";
import { resolveTaskRoute } from "./routing";

/** Explicit business decisions only. Notes, snoozes and ordinary outreach never set or clear a blocker. */
export async function updateBlocker(input: { taskId: string; version: number; action: string; reason?: string; detail?: string; ownerId?: string }, actor: string) {
  if (typeof input.taskId !== "string" || !Number.isInteger(input.version) || input.detail != null && typeof input.detail !== "string" || input.ownerId != null && typeof input.ownerId !== "string") throw new Error("Choose valid blocker details");
  const task = await get<LeadTask>(input.taskId);
  if (!task || task.kind !== "TASK" || task.data.status !== "OPEN" || !canRecordBlocker(task.data)) throw new Error("Choose open carrier, document or placement work");
  if (input.version !== task.version) throw new Error("This work changed. Refresh before saving.");
  const wf = await ensureWorkflow(task.data.accountId), settings = await get("team-routing"), route = await resolveTaskRoute(task.data, wf.data);
  if (![route.accountableId, route.recipientId, route.managerId, route.ownerId].includes(actor)) throw new Error("Only the responsible teammate, manager or owner can update this blocker");
  if (!["SET", "REVIEW", "CLEAR"].includes(input.action)) throw new Error("Choose a blocker action");
  if (input.action !== "SET" && !task.data.blocker) throw new Error("This work has no blocker to review");
  const now = new Date().toISOString(), c = await config();
  let blocker = task.data.blocker;
  if (input.action === "SET") {
    if (!BLOCKER_REASONS.includes(input.reason as typeof BLOCKER_REASONS[number])) throw new Error("Choose a listed business blocker");
    if (input.detail && input.detail.length > 500) throw new Error("Keep the blocker detail under 500 characters");
    const ownerId = input.ownerId || route.managerId || route.ownerId;
    if (!ownerId || !(await team()).some(m => m.userId === ownerId && m.enabled)) throw new Error("Choose an enabled teammate to own the blocker");
    await enabledUser(ownerId);
    blocker = { reason: input.reason!, detail: input.detail?.trim() || undefined, ownerId, recordedAt: now, recordedBy: actor, reviewAt: followUpDeadline(now, 1, c.holidays) };
  } else if (input.action === "CLEAR") blocker = undefined;
  else blocker = { ...blocker!, reviewAt: followUpDeadline(now, 1, c.holidays) };
  const businessMorning = task.data.reminderAt ?? morningReminderAt(task.data.dueAt, c.holidays);
  const next: LeadTask = { ...task.data, blocker, ...(input.action === "CLEAR" && businessMorning > now ? { nextReminderAt: businessMorning } : {}), version: task.version + 1 };
  await commit([check(wf), ...(settings ? [check(settings)] : []), put(row("TASK", task.id, next, { accountId: task.accountId, previous: task, dueAt: taskWakeAt(next) }), task), audit(task.data.accountId, actor, input.action === "CLEAR" ? "Business blocker cleared" : "Business blocker recorded or reviewed", { taskId: task.id, blocker })]);
  return { ok: true };
}
