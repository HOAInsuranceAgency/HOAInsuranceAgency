import { tasksRemoved } from "./retiredTasks";
export async function updateBlocker(input: { taskId: string; version: number; action: string; reason?: string; detail?: string; ownerId?: string }, actor: string) {
  void input; void actor;
  return tasksRemoved();
}
