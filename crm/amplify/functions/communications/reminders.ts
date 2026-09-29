import { scheduleReminders, taskWakeAt, type LeadTask } from "../../../../shared/leadWorkflow";
import { salespersonTask } from "../../../../shared/salespersonOwnership";
import { config } from "./config";
import { get, query, save, row, hash, conflict } from "./store";

/** Bounded, resumable migration: existing 5pm tasks must enter the 9am index too. */
export async function migrateReminderSchedules() {
  const { holidays } = await config();
  const key = `migration:morning-reminders:v3:${hash(JSON.stringify([...holidays].sort()))}`;
  const progress = await get<{ cursor?: string; complete?: boolean }>(key);
  // Repeat after a quiet hour so old Lambda invocations during a rolling
  // deployment cannot leave later-created tasks on the former 5pm schedule.
  if (progress?.data.complete && Date.now() - Date.parse(progress.updatedAt) < 3600_000) return;
  const page = await query<LeadTask>("work", "TASK", progress?.data.complete ? undefined : progress?.data.cursor, 25);
  for (const candidate of page.items) {
    const task = await get<LeadTask>(candidate.id);
    if (!task || task.data.status !== "OPEN") continue;
    const data = scheduleReminders(salespersonTask(task.data), holidays);
    if (JSON.stringify(data) === JSON.stringify(task.data) && !!task.dueAt) continue;
    data.version = task.version + 1;
    try { await save(row("TASK", task.id, data, { accountId: task.accountId, previous: task, dueAt: taskWakeAt(data) }), task); }
    catch (e) { if (!conflict(e)) throw e; }
  }
  await save(row("MIGRATION", key, { cursor: page.nextToken, complete: !page.nextToken }, { previous: progress }), progress);
}
