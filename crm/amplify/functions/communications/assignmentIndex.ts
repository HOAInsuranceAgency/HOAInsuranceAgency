import type { LeadWorkflow } from "../../../../shared/leadWorkflow";
import { get, query, row, save } from "./store";

/** One restartable page per worker tick. Never scan on a user's request or
 * publish a partial index as a complete account list during rollout. */
export async function migrateAssignmentIndex() {
  const key = "migration:assignment-index:v1";
  const old = await get<{ cursor?: string; complete?: boolean }>(key);
  if (old?.data.complete) return;
  const page = await query<LeadWorkflow>("kind", "WORKFLOW", old?.data.cursor, 50);
  for (const candidate of page.items) {
    const current = await get<LeadWorkflow>(candidate.id);
    if (!current || current.assignedSalespersonId === current.data.salespersonId) continue;
    await save(row("WORKFLOW", current.id, { ...current.data, version: current.version + 1 }, { previous: current, accountId: current.accountId ?? current.data.accountId, dueAt: current.dueAt }), current);
  }
  await save(row("MIGRATION", key, { cursor: page.nextToken, complete: !page.nextToken }, { previous: old }), old);
}
