import { tasksRemoved } from "./retiredTasks";
export async function nextYear(input: { accountId: string; version: number; expiration: string; requestId: string }, actor: string) {
  void input; void actor;
  return tasksRemoved();
}
