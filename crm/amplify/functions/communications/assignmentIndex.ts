import { BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import type { LeadWorkflow } from "../../../../shared/leadWorkflow";
import { conflict, db, get, query, row, save, table, type Row } from "./store";
import { migrateProducerIndex } from "./producerIndex";

/** GSI pages may be stale. Read their current rows together before attempting
 * conditional writes; an unprocessed key is never evidence of a deleted row. */
async function readPage(ids: string[], deadline: number) {
  const name = table(), found = new Map<string, Row<LeadWorkflow>>();
  let pending = [...new Set(ids)].map(id => ({ id }));
  if (pending.length > 100) throw new Error("Assignment migration page exceeds the batch read limit");
  for (let attempt = 0; pending.length; attempt++) {
    if (Date.now() >= deadline) return;
    const result = await db.send(new BatchGetCommand({ RequestItems: { [name]: { Keys: pending, ConsistentRead: true } } }));
    for (const item of result.Responses?.[name] ?? []) found.set(item.id, item as Row<LeadWorkflow>);
    pending = (result.UnprocessedKeys?.[name]?.Keys ?? []).map(key => ({ id: key.id as string }));
    if (pending.length) {
      if (attempt === 3) throw new Error("Assignment migration batch read remains incomplete; retry this page");
      const delay = 25 * 2 ** attempt;
      if (Date.now() + delay >= deadline) return;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  return found;
}

/** Dedicated scheduled worker: drain many pages per invocation, checkpointing
 * each one. Keep the normal communication dispatcher free to deliver work. */
export async function migrateAssignmentIndex(options: { maxPages?: number; budgetMs?: number } = {}) {
  const key = "migration:assignment-index:v1", deadline = Date.now() + (options.budgetMs ?? 45_000);
  let checkpoint = await get<{ cursor?: string; complete?: boolean; processed?: number }>(key);
  if (checkpoint?.data.complete) return;
  for (let pageNumber = 0; pageNumber < (options.maxPages ?? 1000) && Date.now() < deadline; pageNumber++) {
    const page = await query<LeadWorkflow>("kind", "WORKFLOW", checkpoint?.data.cursor, 100);
    const currentRows = await readPage(page.items.map(candidate => candidate.id), deadline);
    if (!currentRows) return; // Leave the checkpoint unchanged when the read budget expires.
    for (let offset = 0; offset < page.items.length; offset += 25) {
      if (Date.now() >= deadline) return; // Resume this page; completed rows are idempotent.
      const results = await Promise.allSettled(page.items.slice(offset, offset + 25).map(async candidate => {
        let current = currentRows.get(candidate.id);
        for (let attempt = 0; attempt < 3; attempt++) {
          if (!current || current.assignedSalespersonId === current.data.salespersonId) return;
          try {
            await save(row("WORKFLOW", current.id, { ...current.data, version: current.version + 1 }, { previous: current, accountId: current.accountId ?? current.data.accountId, dueAt: current.dueAt }), current);
            return;
          } catch (error) {
            if (!conflict(error) || attempt === 2) throw error;
            current = await get<LeadWorkflow>(candidate.id);
          }
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

export const handler = async () => {
  let producerFailure: unknown;
  try { await migrateProducerIndex({ budgetMs: 10_000 }); }
  catch (error) { producerFailure = error; }
  await migrateAssignmentIndex();
  if (producerFailure) throw producerFailure;
};
