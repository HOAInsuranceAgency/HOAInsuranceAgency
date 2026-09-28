import type { LeadWorkflow } from "../../../../shared/leadWorkflow";
import { conflict, get, query, row, save } from "./store";

/** Dedicated scheduled worker: drain many pages per invocation, checkpointing
 * each one. Keep the normal communication dispatcher free to deliver work. */
export async function migrateAssignmentIndex(options: { maxPages?: number; budgetMs?: number } = {}) {
  const key = "migration:assignment-index:v1", deadline = Date.now() + (options.budgetMs ?? 45_000);
  let checkpoint = await get<{ cursor?: string; complete?: boolean; processed?: number }>(key);
  if (checkpoint?.data.complete) return;
  for (let pageNumber = 0; pageNumber < (options.maxPages ?? 1000) && Date.now() < deadline; pageNumber++) {
    const page = await query<LeadWorkflow>("kind", "WORKFLOW", checkpoint?.data.cursor, 100);
    for (let offset = 0; offset < page.items.length; offset += 25) {
      if (Date.now() >= deadline) return; // Resume this page; completed rows are idempotent.
      const results = await Promise.allSettled(page.items.slice(offset, offset + 25).map(async candidate => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const current = await get<LeadWorkflow>(candidate.id);
          if (!current || current.assignedSalespersonId === current.data.salespersonId) return;
          try {
            await save(row("WORKFLOW", current.id, { ...current.data, version: current.version + 1 }, { previous: current, accountId: current.accountId ?? current.data.accountId, dueAt: current.dueAt }), current);
            return;
          } catch (error) { if (!conflict(error) || attempt === 2) throw error; }
        }
      }));
      // Wait for all in-flight writes before failing, and never checkpoint a
      // partial page. Concurrent reassignment is re-read, never overwritten.
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
    checkpoint = await save(row("MIGRATION", key, { cursor: page.nextToken, complete: !page.nextToken, processed: (checkpoint?.data.processed ?? 0) + page.items.length }, { previous: checkpoint }), checkpoint);
    if (!page.nextToken) return;
  }
}

export const handler = async () => { await migrateAssignmentIndex(); };
